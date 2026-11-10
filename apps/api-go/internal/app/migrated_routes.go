package app

import (
	"github.com/gin-gonic/gin"

	"hrm/api-go/contract"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/health"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/openapi"
)

func registerMigrated(_ *gin.Engine, group *httpapi.Group, gate *health.Gate, upstream health.Upstream, auth authentication.Routes, mods modules) error {
	if err := health.Register(group, gate, upstream, mods.metrics); err != nil {
		return err
	}
	if err := httpapi.RegisterAuth(group, auth.Origin); err != nil {
		return err
	}
	if err := auth.Register(group); err != nil {
		return err
	}
	if err := mods.register(group, auth.Origin); err != nil {
		return err
	}
	if err := (authentication.SessionRoutes{Identity: auth.Identity, Menus: menuPort{authority: mods.authority, employees: mods.employees.Bind(mods.authority)}, Origin: auth.Origin}).Register(group); err != nil {
		return err
	}
	return openapi.Register(group, contract.OpenAPI())
}
