package app

import (
	"slices"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/employee"
	"hrm/api-go/internal/modules/setting"
	"hrm/api-go/internal/modules/team"
	"hrm/api-go/internal/modules/workcalendar"
	"hrm/api-go/internal/modules/workschedule"
)

// modules are the migrated modules bound to the authority. The operations are the ones registered with
// it, since the authority runs only the pointers it registered.
type modules struct {
	authority *authority.Authorization
	teams     *team.Operations
	employees *employee.Operations
	calendar  *workcalendar.Operations
	schedules *workschedule.Operations
}

func newModules(runner *database.Runner) (modules, error) {
	m := modules{teams: team.NewOperations(), employees: employee.NewOperations(), calendar: workcalendar.NewOperations(), schedules: workschedule.NewOperations()}
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
	operations := slices.Concat(setting.Operations(), m.teams.All(), m.employees.All(), m.calendar.All(), m.schedules.All())
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
	return workschedule.Routes{Schedules: m.schedules.Bind(m.authority), Origin: origin}.Register(group)
}
