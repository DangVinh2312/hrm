package app

import (
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/database"
)

func newAuthority(runner *database.Runner) (*authority.Authorization, error) {
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
	return authority.New(runner, bindings, authority.DefaultCapabilities(), nil)
}
