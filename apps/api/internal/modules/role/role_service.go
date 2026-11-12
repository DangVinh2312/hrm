package role

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
)

// Operations are the role queries and commands, to register with authority.New; Bind gives the facade that runs
// exactly these pointers.
type Operations struct {
	declarations *core.ValidatedDeclarations
	matrix       *authority.Query[struct{}, MatrixView]
	account      *authority.Query[string, AccountPermissionView]
	create       *authority.Command[CreateInput, WriteResult]
	update       *authority.Command[UpdateInput, WriteResult]
	remove       *authority.Command[string, Removed]
}

func anchor[I any](I) string { return permission.RoleID }

// NewOperations computes the catalog once; a catalog above its bound is a release defect and fails the boot.
func NewOperations(c *core.Core, declarations *core.ValidatedDeclarations) (*Operations, error) {
	pairs, err := catalog(declarations)
	if err != nil {
		return nil, err
	}
	role := string(keys.RoleResourceRole)
	m := commands{core: c, declarations: declarations}
	return &Operations{
		declarations: declarations,
		matrix:       authority.NewQuery(role, string(keys.RoleActionRead), nil, readMatrix(pairs)),
		account:      authority.NewQuery(string(keys.AccountResourceAccount), string(keys.AccountActionReadPermissions), func(id string) string { return id }, readAccount),
		create:       authority.NewCommand(role, string(keys.RoleActionCreate), database.ModeAdmin, anchor[CreateInput], m.create),
		update:       authority.NewCommand(role, string(keys.RoleActionUpdate), database.ModeAdmin, anchor[UpdateInput], m.update),
		remove:       authority.NewCommand(role, string(keys.RoleActionDelete), database.ModeAdmin, anchor[string], m.remove),
	}, nil
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.matrix, o.account, o.create, o.update, o.remove}
}

// Service is the role operations bound to the authority. A read that the plan does not reach (no grant, Root
// target, absent account) is found=false, one 404 for all; a write without the grant is 403; a role that is
// absent, not runtime or larger than the actor's own set is 404.
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}

func (s *Service) Matrix(ctx context.Context, secret string) (MatrixView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.matrix, struct{}{})
	return result.Value, result.Found, err
}

// AccountPermissions: a malformed id is a 400 before any transaction.
func (s *Service) AccountPermissions(ctx context.Context, secret, accountID string) (AccountPermissionView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.account, accountID)
	return result.Value, result.Found, err
}

// Create checks the catalog before the exclusive fence is taken; the command checks it again.
func (s *Service) Create(ctx context.Context, secret string, input CreateInput) (WriteResult, error) {
	if err := checkCatalog(s.operations.declarations, input.Label, input.Grants); err != nil {
		return WriteResult{}, err
	}
	return granted(authority.Execute(ctx, s.authorization, secret, s.operations.create, input))
}

func (s *Service) Update(ctx context.Context, secret string, input UpdateInput) (WriteResult, error) {
	if err := checkCatalog(s.operations.declarations, input.Label, input.Grants); err != nil {
		return WriteResult{}, err
	}
	return granted(authority.Execute(ctx, s.authorization, secret, s.operations.update, input))
}

func (s *Service) Remove(ctx context.Context, secret, key string) (Removed, error) {
	return granted(authority.Execute(ctx, s.authorization, secret, s.operations.remove, key))
}

// granted: the anchor is a constant-scope singleton, so a command that does not reach it has no grant.
func granted[R any](result authority.CommandResult[R], err error) (R, error) {
	var zero R
	if err != nil {
		return zero, err
	}
	if !result.Found {
		return zero, apperror.ErrAccessDenied
	}
	return result.Value, nil
}
