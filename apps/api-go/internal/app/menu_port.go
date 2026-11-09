package app

import (
	"context"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/modules/employee"
)

type menuPort struct {
	authority *authority.Authorization
	employees *employee.Service
}

func (m menuPort) SessionMenus(ctx context.Context, secret string) ([]keys.MeMenu, error) {
	allowed, err := m.authority.Permits(ctx, secret, "account", "read")
	if err != nil {
		return nil, err
	}
	if allowed {
		return []keys.MeMenu{keys.MeMenuAccounts}, nil
	}
	return []keys.MeMenu{}, nil
}
func (m menuPort) MeMenus(ctx context.Context, secret string) ([]keys.MeMenu, error) {
	return m.employees.Menus(ctx, secret)
}
