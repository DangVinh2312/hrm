package employee

import (
	"context"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
)

func (s *Service) Menus(ctx context.Context, secret string) ([]keys.MeMenu, error) {
	employees, err := s.ownEmployee(ctx, secret)
	if err != nil {
		return nil, err
	}
	queries := []authority.PermitQuery{
		{{Resource: "team", Action: "read"}},
		{{Resource: "hrCompany", Action: "read"}},
		{{Resource: "workCalendar", Action: "read"}},
		{{Resource: "team", Action: "approvals"}, {Resource: "hrCompany", Action: "approvals"}},
		{},
		{{Resource: "account", Action: "read"}},
		{{Resource: "setting", Action: "read"}},
		{{Resource: "role", Action: "read"}},
	}
	for _, action := range keys.ReportActions() {
		queries[4] = append(queries[4], authority.Probe{Resource: "employee", Action: string(action)})
	}
	if employees.Own != nil {
		for _, action := range []string{"submitRequest", "readLeaveBalance", "readAttendance"} {
			queries = append(queries, authority.PermitQuery{{Resource: "employee", Action: action}})
		}
	}
	answers, err := s.authorization.PermitsMany(ctx, secret, queries)
	if err != nil {
		return nil, err
	}
	var requests, leave, attendance bool
	if employees.Own != nil {
		requests, leave, attendance = answers[8], answers[9], answers[10]
	}
	menus := make([]keys.MeMenu, 0, 11)
	for _, item := range []struct {
		show bool
		key  keys.MeMenu
	}{
		{requests, keys.MeMenuRequests},
		{answers[3], keys.MeMenuApprovals},
		{answers[1] || employees.Others, keys.MeMenuEmployees},
		{answers[1] || answers[0], keys.MeMenuTeams},
		{answers[2], keys.MeMenuCalendar},
		{leave, keys.MeMenuLeave},
		{attendance, keys.MeMenuAttendance},
		{answers[4], keys.MeMenuReports},
		{answers[5], keys.MeMenuAccounts},
		{answers[6], keys.MeMenuSettings},
		{answers[7], keys.MeMenuRoles},
	} {
		if item.show {
			menus = append(menus, item.key)
		}
	}
	return menus, nil
}
