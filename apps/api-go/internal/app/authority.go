package app

import (
	"slices"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/setting"
	"hrm/api-go/internal/modules/team"
)

func newAuthority(runner *database.Runner, teams *team.Operations) (*authority.Authorization, error) {
	c, err := declarations.NewCore()
	if err != nil {
		return nil, err
	}
	validated, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		return nil, err
	}
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	if err != nil {
		return nil, err
	}
	return authority.New(runner, bindings, authority.DefaultCapabilities(), nil, slices.Concat(setting.Operations(), teams.All())...)
}

// modules are the migrated modules bound to the authority; teams must be the operations given to
// newAuthority, since the authority runs only the pointers it registered.
type modules struct {
	authority *authority.Authorization
	teams     *team.Operations
}

func (m modules) register(group *httpapi.Group, origin string) error {
	if err := (setting.Routes{Settings: setting.NewService(m.authority), Origin: origin}).Register(group); err != nil {
		return err
	}
	return team.Routes{Teams: m.teams.Bind(m.authority), Origin: origin}.Register(group)
}
