package app

import (
	"slices"

	"hrm/api/internal/administration"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/config"
	"hrm/api/internal/database"
	"hrm/api/internal/health"
	"hrm/api/internal/httpapi"
	"hrm/api/internal/modules/attendance"
	"hrm/api/internal/modules/employee"
	"hrm/api/internal/modules/leave"
	"hrm/api/internal/modules/report"
	"hrm/api/internal/modules/role"
	"hrm/api/internal/modules/setting"
	"hrm/api/internal/modules/team"
	"hrm/api/internal/modules/workcalendar"
	"hrm/api/internal/modules/workrequest"
	"hrm/api/internal/modules/workschedule"
)

// modules are the migrated modules bound to the authority. The operations are the ones registered with
// it, since the authority runs only the pointers it registered.
type modules struct {
	authority  *authority.Authorization
	teams      *team.Operations
	employees  *employee.Operations
	calendar   *workcalendar.Operations
	schedules  *workschedule.Operations
	leave      *leave.Operations
	requests   *workrequest.Operations
	attendance *attendance.Operations
	reports    *report.Operations
	roles      *role.Operations
	accounts   *administration.Operations
	issuer     string
	metrics    *health.Metrics
}

// provisioningIssuer is the issuer new accounts enroll at: the deployment's one OIDC provider, empty when there
// is not exactly one.
func provisioningIssuer(providers []config.ProductOidcProviderConfig) string {
	if len(providers) != 1 {
		return ""
	}
	return providers[0].Issuer
}

func newModules(runner *database.Runner, issuer string) (modules, error) {
	m := modules{teams: team.NewOperations(), employees: employee.NewOperations(), calendar: workcalendar.NewOperations(), schedules: workschedule.NewOperations(), leave: leave.NewOperations(), requests: workrequest.NewOperations(), attendance: attendance.NewOperations(), reports: report.NewOperations(), issuer: issuer}
	c, err := declarations.NewCore()
	if err != nil {
		return m, err
	}
	validated, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		return m, err
	}
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	if err != nil {
		return m, err
	}
	if m.roles, err = role.NewOperations(c, validated); err != nil {
		return m, err
	}
	m.accounts = administration.NewOperations(c)
	operations := slices.Concat(setting.Operations(), m.teams.All(), m.employees.All(), m.calendar.All(), m.schedules.All(), m.leave.All(), m.requests.All(), m.attendance.All(), m.reports.All(), m.roles.All(), m.accounts.All())
	m.authority, err = authority.New(runner, bindings, authority.DefaultCapabilities(), nil, operations...)
	return m, err
}

func (m modules) register(group *httpapi.Group, origin string) error {
	if err := (setting.Routes{Settings: setting.NewService(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (team.Routes{Teams: m.teams.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (employee.Routes{Employees: m.employees.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (workcalendar.Routes{Calendar: m.calendar.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (workschedule.Routes{Schedules: m.schedules.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (leave.Routes{Leave: m.leave.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (workrequest.Routes{Requests: m.requests.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (attendance.Routes{Attendance: m.attendance.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (report.Routes{Reports: m.reports.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	if err := (role.Routes{Roles: m.roles.Bind(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	return administration.Routes{Accounts: m.accounts.Bind(m.authority, m.issuer), Origin: origin}.Register(group)
}
