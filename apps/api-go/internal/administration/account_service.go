package administration

import (
	"context"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/gateway"
	"hrm/api-go/internal/authorization/grant"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
)

// Operations are the account commands, to register with authority.New; Bind gives the facade that runs exactly
// these pointers.
type Operations struct {
	core       *core.Core
	provision  *authority.AdminCommand[provisionInput, provisioned]
	suspend    accountCommand[accountID]
	reactivate accountCommand[accountID]
	assign     accountCommand[roleChange]
	revoke     accountCommand[roleChange]
	bind       accountCommand[boundaryChange]
	unbind     accountCommand[boundaryChange]

	changeEmail        accountCommand[emailChange]
	resetMfa           accountCommand[accountID]
	resetGoogleBinding accountCommand[bindingReset]
}

func NewOperations(c *core.Core) *Operations {
	m := commands{core: c}
	roleAbsent := func(action keys.AccountAction) func(authority.AdminContext, roleChange) audit.Event {
		return func(ctx authority.AdminContext, input roleChange) audit.Event {
			return accessAbsent(ctx, string(action), input.UserID)
		}
	}
	return &Operations{
		core:      c,
		provision: authority.NewAdminCommand(string(keys.AccountResourceAccount), string(keys.AccountActionProvision), m.provision, provisionRootEvent),
		suspend: newAccountCommand(keys.AccountActionSuspend, m.suspend, func(ctx authority.AdminContext, target accountID) audit.Event {
			return accountEvent(audit.KindAccountSuspend, ctx, string(target), "absent")
		}),
		reactivate: newAccountCommand(keys.AccountActionReactivate, m.reactivate, func(ctx authority.AdminContext, target accountID) audit.Event {
			return accountEvent(audit.KindAccountReactivate, ctx, string(target), "absent")
		}),
		assign: newAccountCommand(keys.AccountActionAssignRole, m.changeRole(true), roleAbsent(keys.AccountActionAssignRole)),
		revoke: newAccountCommand(keys.AccountActionRevokeRole, m.changeRole(false), roleAbsent(keys.AccountActionRevokeRole)),
		bind: newAccountCommand(keys.AccountActionBindBoundary, m.changeBoundary(true), func(ctx authority.AdminContext, input boundaryChange) audit.Event {
			return accessAbsent(ctx, string(keys.AccountActionBindBoundary), input.UserID)
		}),
		unbind: newAccountCommand(keys.AccountActionUnbindBoundary, m.changeBoundary(false), func(ctx authority.AdminContext, input boundaryChange) audit.Event {
			return accessAbsent(ctx, string(keys.AccountActionUnbindBoundary), input.UserID)
		}),
		changeEmail: newAccountCommand(keys.AccountActionChangeEmail, identityCommand(m, audit.KindIdentityEmailChange, func(tx *database.Tx, actor string, input emailChange) error {
			return changeIAMAccountEmail(tx, input.UserID, input.Email, input.Issuer, actor)
		}), identityAbsent[emailChange](audit.KindIdentityEmailChange)),
		resetMfa: newAccountCommand(keys.AccountActionResetMfa, identityCommand(m, audit.KindIdentityMfaResetByPermission, func(tx *database.Tx, _ string, target accountID) error {
			return resetIAMMfa(tx, string(target))
		}), identityAbsent[accountID](audit.KindIdentityMfaResetByPermission)),
		resetGoogleBinding: newAccountCommand(keys.AccountActionResetGoogleBinding, identityCommand(m, audit.KindIdentityBindingReset, func(tx *database.Tx, actor string, input bindingReset) error {
			return resetIAMGoogleBinding(tx, input.UserID, input.Issuer, actor)
		}), identityAbsent[bindingReset](audit.KindIdentityBindingReset)),
	}
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.provision, o.suspend.command, o.reactivate.command, o.assign.command, o.revoke.command,
		o.bind.command, o.unbind.command, o.changeEmail.command, o.resetMfa.command, o.resetGoogleBinding.command}
}

// Service is the account operations bound to the authority. issuer is the deployment's one OIDC provider,
// empty when there is not exactly one, and provisioning is then unavailable.
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
	issuer        string
}

func (o *Operations) Bind(a *authority.Authorization, issuer string) *Service {
	return &Service{authorization: a, operations: o, issuer: issuer}
}

// List is account.read: IAM accounts ordered by email, a bounded page.
func (s *Service) List(ctx context.Context, secret string, limit, offset int) (AccountPage, error) {
	page, err := s.authorization.List(ctx, secret, string(keys.AccountResourceAccount), string(keys.AccountActionRead), gateway.ListQuery{OrderBy: "email", Limit: &limit, Offset: offset})
	if err != nil {
		return AccountPage{}, err
	}
	items := make([]AccountRow, 0, len(page.Items))
	for _, row := range page.Items {
		account, ok := accountOf(row)
		if !ok {
			return AccountPage{}, apperror.ErrUnavailable
		}
		items = append(items, account)
	}
	return AccountPage{Items: items, Total: page.Total}, nil
}

// Provision is account.provision with the first role. The caller needs account.assignRole too, answered first
// under the shared fence (403). A role that is absent or, for IAM, beyond the caller's grants is a 404 before
// anything is written; a taken email is a 409.
func (s *Service) Provision(ctx context.Context, secret string, input ProvisionInput) (ProvisionedAccount, error) {
	if s.issuer == "" {
		return ProvisionedAccount{}, apperror.ErrUnavailable
	}
	email, err := credential.CanonicalLoginEmail(input.Email)
	if err != nil || !grant.IsRoleKeyReference(input.RoleKey) {
		return ProvisionedAccount{}, apperror.ErrInvalidRequest
	}
	account := string(keys.AccountResourceAccount)
	allowed, err := s.authorization.AllowsAll(ctx, secret, []authority.Probe{{Resource: account, Action: string(keys.AccountActionProvision)}, {Resource: account, Action: string(keys.AccountActionAssignRole)}})
	if err != nil {
		return ProvisionedAccount{}, err
	}
	if !allowed {
		return ProvisionedAccount{}, apperror.ErrAccessDenied
	}
	result, err := authority.Administer(ctx, s.authorization, secret, s.operations.provision, provisionInput{UserID: newUUID(), Email: email, Issuer: s.issuer, RoleKey: input.RoleKey})
	if err != nil {
		return ProvisionedAccount{}, err
	}
	if !result.found {
		return ProvisionedAccount{}, apperror.ErrNotFound
	}
	return result.row, nil
}

func found(done bool, err error) error {
	if err == nil && !done {
		return apperror.ErrNotFound
	}
	return err
}

// Suspend ends the account and every session of it. Not found (404) is an absent id, any Root or an account
// the caller's grants cannot be proven to contain; oneself is 403.
func (s *Service) Suspend(ctx context.Context, secret, userID string) error {
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.suspend, accountID(userID)))
}

// Reactivate is the reverse of Suspend with the same order; an account that is not suspended is a 409.
func (s *Service) Reactivate(ctx context.Context, secret, userID string) error {
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.reactivate, accountID(userID)))
}

// AssignRole: already held or 20 roles is a 409; an absent role or one beyond an IAM caller's grants is a 404.
func (s *Service) AssignRole(ctx context.Context, secret, userID, roleKey string) error {
	if !grant.IsRoleKeyReference(roleKey) {
		return apperror.ErrInvalidRequest
	}
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.assign, roleChange{UserID: userID, RoleKey: roleKey}))
}

// RevokeRole: not held or the last role is a 409.
func (s *Service) RevokeRole(ctx context.Context, secret, userID, roleKey string) error {
	if !grant.IsRoleKeyReference(roleKey) {
		return apperror.ErrInvalidRequest
	}
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.revoke, roleChange{UserID: userID, RoleKey: roleKey}))
}

// accountOf reads the projection of account_directory; a row without a text key or state is not an account.
func accountOf(row gateway.Row) (AccountRow, bool) {
	if row == nil {
		return AccountRow{}, false
	}
	key, ok := row["key"].AsText()
	state, stateOK := row["state"].AsText()
	if !ok || !stateOK || row["state"].IsNull() {
		return AccountRow{}, false
	}
	nullable := func(field string) *string {
		value, ok := row[field].AsText()
		if row[field].IsNull() || !ok {
			return nil
		}
		return &value
	}
	return AccountRow{UserID: key, Email: nullable("email"), State: state, Enrollment: nullable("enrollment")}, true
}
