package authentication

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/httpapi"
)

type CurrentSessionPort interface {
	CurrentSession(context.Context, string) (SessionIdentity, error)
}

type MenuPort interface {
	SessionMenus(context.Context, string) ([]keys.MeMenu, error)
	MeMenus(context.Context, string) ([]keys.MeMenu, error)
}

type SessionRoutes struct {
	Identity CurrentSessionPort
	Menus    MenuPort
	Origin   string
}

func (r SessionRoutes) Register(group *httpapi.Group) error {
	if r.Identity == nil || r.Menus == nil {
		return errors.New("session routes require identity and menus")
	}
	for _, route := range []struct {
		path   string
		handle func(*gin.Context) error
	}{
		{"/api/auth/session", r.current},
		{"/api/auth/me", r.me},
	} {
		handler := func(c *gin.Context) {
			if err := route.handle(c); err != nil {
				httpapi.WriteError(c, err)
			}
		}
		if err := httpapi.Register(group, http.MethodGet, route.path, enforcement.Authenticated(), handler); err != nil {
			return err
		}
	}
	return nil
}

type currentSessionAnswer struct {
	UserID    string        `json:"userId"`
	Method    string        `json:"method"`
	Assurance string        `json:"assurance"`
	Menus     []keys.MeMenu `json:"menus"`
}

type meAnswer struct {
	UserID string        `json:"userId"`
	Menus  []keys.MeMenu `json:"menus"`
}

func (r SessionRoutes) current(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	identity, err := r.Identity.CurrentSession(c.Request.Context(), secret)
	if err != nil {
		return err
	}
	menus, err := r.Menus.SessionMenus(c.Request.Context(), secret)
	if err != nil {
		return err
	}
	return writeAnswer(c, currentSessionAnswer{identity.UserID, identity.Method, identity.Assurance, menus})
}

func (r SessionRoutes) me(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	identity, err := r.Identity.CurrentSession(c.Request.Context(), secret)
	if err != nil {
		return err
	}
	menus, err := r.Menus.MeMenus(c.Request.Context(), secret)
	if err != nil {
		return err
	}
	return writeAnswer(c, meAnswer{identity.UserID, menus})
}
