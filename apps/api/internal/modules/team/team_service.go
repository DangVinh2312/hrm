package team

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
)

type Operations struct {
	list    *authority.Query[ListQuery, ListView]
	detail  *authority.Query[string, View]
	create  *authority.Command[CreateInput, Created]
	rename  *authority.Command[RenameInput, Renamed]
	add     *authority.Command[MemberInput, Status]
	primary *authority.Command[MembershipRef, Status]
	end     *authority.Command[MembershipRef, Status]
	lead    *authority.Command[LeadInput, Status]
}

func NewOperations() *Operations {
	resource := string(keys.TeamResourceTeam)
	return &Operations{
		list: authority.NewQuery(resource, string(keys.TeamActionRead), nil, func(ctx authority.QueryContext, input ListQuery) (authority.QueryResult[ListView], error) {
			value, err := listTeams(ctx.Tx, ctx.Scope, input)
			return authority.QueryResult[ListView]{Found: true, Value: value}, err
		}),
		detail: authority.NewQuery(resource, string(keys.TeamActionRead), func(id string) string { return id }, func(ctx authority.QueryContext, id string) (authority.QueryResult[View], error) {
			return teamDetail(ctx.Tx, ctx.Scope, id)
		}),
		create:  authority.NewCommand(string(keys.CompanyResourceCompany), string(keys.CompanyActionCreateTeam), database.ModeWrite, func(CreateInput) string { return permission.CompanyID }, runCreate),
		rename:  authority.NewCommand(resource, string(keys.TeamActionUpdate), database.ModeWrite, func(i RenameInput) string { return i.TeamID }, runRename),
		add:     authority.NewCommand(resource, string(keys.TeamActionAssign), database.ModeAdmin, func(i MemberInput) string { return i.TeamID }, runAddMember),
		primary: authority.NewCommand(resource, string(keys.TeamActionAssign), database.ModeAdmin, func(i MembershipRef) string { return i.TeamID }, runSetPrimary),
		end:     authority.NewCommand(resource, string(keys.TeamActionAssign), database.ModeAdmin, func(i MembershipRef) string { return i.TeamID }, runEndMembership),
		lead:    authority.NewCommand(resource, string(keys.TeamActionAssign), database.ModeAdmin, func(i LeadInput) string { return i.TeamID }, runAssignLead),
	}
}
func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.list, o.detail, o.create, o.rename, o.add, o.primary, o.end, o.lead}
}

type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}
func (s *Service) List(ctx context.Context, secret string, input ListQuery) (ListView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.list, input)
	return result.Value, err
}
func (s *Service) Detail(ctx context.Context, secret, id string) (View, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.detail, id)
	if err == nil && !result.Found {
		return View{}, apperror.ErrNotFound
	}
	return result.Value, err
}
func (s *Service) Create(ctx context.Context, secret string, input CreateInput) (Created, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.create, input)
	if err == nil && !result.Found {
		return Created{}, apperror.ErrAccessDenied
	}
	return result.Value, err
}
func (s *Service) Rename(ctx context.Context, secret string, input RenameInput) (Renamed, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.rename, input)
	if err == nil && !result.Found {
		return Renamed{}, apperror.ErrNotFound
	}
	return result.Value, err
}
func (s *Service) AddMember(ctx context.Context, secret string, input MemberInput) (Status, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.add, input)
	if err == nil && !result.Found {
		return Status{}, apperror.ErrNotFound
	}
	return result.Value, err
}
func (s *Service) SetPrimary(ctx context.Context, secret string, input MembershipRef) (Status, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.primary, input)
	if err == nil && !result.Found {
		return Status{}, apperror.ErrNotFound
	}
	return result.Value, err
}
func (s *Service) EndMembership(ctx context.Context, secret string, input MembershipRef) (Status, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.end, input)
	if err == nil && !result.Found {
		return Status{}, apperror.ErrNotFound
	}
	return result.Value, err
}
func (s *Service) AssignLead(ctx context.Context, secret string, input LeadInput) (Status, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.lead, input)
	if err == nil && !result.Found {
		return Status{}, apperror.ErrNotFound
	}
	return result.Value, err
}
