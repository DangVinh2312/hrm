package employee

import (
	"context"
	"errors"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
)

type Operations struct {
	list     *authority.Query[ListQuery, ListView]
	detail   *authority.Query[string, View]
	identity *authority.Query[string, IdentityView]
	rates    *authority.Query[string, LeaveRateListView]
	own      *authority.Query[struct{}, ownView]
	commands *commands
}

func NewOperations() *Operations {
	target := func(id string) string { return id }
	return &Operations{
		list:     authority.NewQuery("employee", "read", nil, listEmployees),
		detail:   authority.NewQuery("employee", "read", target, employeeDetail),
		identity: authority.NewQuery("employeeIdentity", "read", target, identityDetail),
		rates:    authority.NewQuery("leaveRate", "read", nil, leaveRates),
		own:      authority.NewQuery("employee", "read", nil, ownEmployee),
		commands: newCommands(),
	}
}

func (o *Operations) All() []authority.Operation {
	return append([]authority.Operation{o.list, o.detail, o.identity, o.rates, o.own}, o.commands.all()...)
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

func (s *Service) Identity(ctx context.Context, secret, id string) (IdentityView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.identity, id)
	if err == nil && !result.Found {
		return IdentityView{}, apperror.ErrNotFound
	}
	return result.Value, err
}

func (s *Service) LeaveRates(ctx context.Context, secret, id string) (LeaveRateListView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.rates, id)
	return result.Value, err
}

func (s *Service) ownEmployee(ctx context.Context, secret string) (ownView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.own, struct{}{})
	if errors.Is(err, apperror.ErrAccessDenied) {
		return ownView{}, nil
	}
	return result.Value, err
}

func (s *Service) Profile(ctx context.Context, secret string) (SelfView, error) {
	own, err := s.ownEmployee(ctx, secret)
	if err != nil {
		return SelfView{}, err
	}
	company, err := s.authorization.Permits(ctx, secret, "hrCompany", "read")
	return SelfView{Employee: own.Own, CompanyScope: company}, err
}
