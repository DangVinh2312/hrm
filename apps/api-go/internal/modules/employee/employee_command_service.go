package employee

import (
	"context"
	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/permission"
)

type commands struct {
	create    *authority.Command[CreateInput, Created]
	update    *authority.Command[UpdateInput, Versioned]
	official  *authority.Command[OfficialInput, Versioned]
	terminate *authority.Command[TerminationInput, Versioned]
	identity  *authority.Command[IdentityUpdateInput, Versioned]
	rate      *authority.Command[LeaveRateInput, Created]
	account   *authority.Command[AccountLinkInput, Versioned]
}

func newCommands() *commands {
	return &commands{
		create:    authority.NewCommand("hrCompany", "createEmployee", database.ModeWrite, func(CreateInput) string { return permission.CompanyID }, runCreate),
		update:    authority.NewCommand("employee", "update", database.ModeWrite, func(i UpdateInput) string { return i.EmployeeID }, runUpdate),
		official:  authority.NewCommand("employee", "update", database.ModeWrite, func(i OfficialInput) string { return i.EmployeeID }, runOfficial),
		terminate: authority.NewCommand("employee", "update", database.ModeWrite, func(i TerminationInput) string { return i.EmployeeID }, runTermination),
		identity:  authority.NewCommand("employeeIdentity", "update", database.ModeWrite, func(i IdentityUpdateInput) string { return i.EmployeeID }, runIdentityUpdate),
		rate:      authority.NewCommand("employee", "adjustLeaveRate", database.ModeWrite, func(i LeaveRateInput) string { return i.EmployeeID }, runAdjustRate),
		account:   authority.NewCommand("employee", "linkAccount", database.ModeAdmin, func(i AccountLinkInput) string { return i.EmployeeID }, runLinkAccount),
	}
}
func (c *commands) all() []authority.Operation {
	return []authority.Operation{c.create, c.update, c.official, c.terminate, c.identity, c.rate, c.account}
}

func (s *Service) Create(ctx context.Context, secret string, input CreateInput) (Created, error) {
	r, err := authority.Execute(ctx, s.authorization, secret, s.operations.commands.create, input)
	if err == nil && !r.Found {
		return Created{}, apperror.ErrAccessDenied
	}
	return r.Value, err
}
func (s *Service) Update(ctx context.Context, secret string, input UpdateInput) (Versioned, error) {
	r, err := authority.Execute(ctx, s.authorization, secret, s.operations.commands.update, input)
	if err == nil && !r.Found {
		return Versioned{}, apperror.ErrNotFound
	}
	return r.Value, err
}
func (s *Service) Official(ctx context.Context, secret string, input OfficialInput) (Versioned, error) {
	r, err := authority.Execute(ctx, s.authorization, secret, s.operations.commands.official, input)
	if err == nil && !r.Found {
		return Versioned{}, apperror.ErrNotFound
	}
	return r.Value, err
}
func (s *Service) Terminate(ctx context.Context, secret string, input TerminationInput) (Versioned, error) {
	r, err := authority.Execute(ctx, s.authorization, secret, s.operations.commands.terminate, input)
	if err == nil && !r.Found {
		return Versioned{}, apperror.ErrNotFound
	}
	return r.Value, err
}
func (s *Service) UpdateIdentity(ctx context.Context, secret string, input IdentityUpdateInput) (Versioned, error) {
	r, err := authority.Execute(ctx, s.authorization, secret, s.operations.commands.identity, input)
	if err == nil && !r.Found {
		return Versioned{}, apperror.ErrNotFound
	}
	return r.Value, err
}
func (s *Service) AdjustLeaveRate(ctx context.Context, secret string, input LeaveRateInput) (Created, error) {
	r, err := authority.Execute(ctx, s.authorization, secret, s.operations.commands.rate, input)
	if err == nil && !r.Found {
		return Created{}, apperror.ErrNotFound
	}
	return r.Value, err
}
func (s *Service) LinkAccount(ctx context.Context, secret string, input AccountLinkInput) (Versioned, error) {
	r, err := authority.Execute(ctx, s.authorization, secret, s.operations.commands.account, input)
	if err == nil && !r.Found {
		return Versioned{}, apperror.ErrNotFound
	}
	return r.Value, err
}
