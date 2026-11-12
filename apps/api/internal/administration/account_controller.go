package administration

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/httpapi"
)

// Routes are the account list, provisioning, suspend/reactivate, the role and boundary holdings of an account
// and the commands on its global identity (email, second factor, Google binding).
type Routes struct {
	Accounts HTTPPort
	Origin   string
}

func (r Routes) Register(group *httpapi.Group) error {
	account := string(keys.AccountResourceAccount)
	for _, route := range []struct {
		method, path string
		action       keys.AccountAction
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/administration/accounts", keys.AccountActionRead, r.list},
		{http.MethodPost, "/api/administration/accounts", keys.AccountActionProvision, r.provision},
		{http.MethodPost, "/api/administration/users/:id/suspend", keys.AccountActionSuspend, r.suspend},
		{http.MethodPost, "/api/administration/users/:id/reactivate", keys.AccountActionReactivate, r.reactivate},
		{http.MethodPost, "/api/administration/accounts/:id/roles", keys.AccountActionAssignRole, r.assignRole},
		{http.MethodDelete, "/api/administration/accounts/:id/roles/:roleKey", keys.AccountActionRevokeRole, r.revokeRole},
		{http.MethodPost, "/api/administration/accounts/:id/boundaries", keys.AccountActionBindBoundary, r.bindBoundary},
		{http.MethodDelete, "/api/administration/accounts/:id/boundaries/:key/:version", keys.AccountActionUnbindBoundary, r.unbindBoundary},
		{http.MethodPut, "/api/administration/accounts/:id/email", keys.AccountActionChangeEmail, r.changeEmail},
		{http.MethodPost, "/api/administration/accounts/:id/mfa/reset", keys.AccountActionResetMfa, r.resetMfa},
		{http.MethodPost, "/api/administration/accounts/:id/google/reset", keys.AccountActionResetGoogleBinding, r.resetGoogleBinding},
	} {
		handler := func(c *gin.Context) {
			if err := route.handle(c); err != nil {
				httpapi.WriteError(c, err)
			}
		}
		if err := httpapi.Register(group, route.method, route.path, enforcement.Authorize(account, string(route.action)), handler); err != nil {
			return err
		}
	}
	return nil
}

func answer[T any](c *gin.Context, status int, value T, err error) error {
	if err != nil {
		return err
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, status, body)
	return nil
}

func done(c *gin.Context, status string, err error) error {
	return answer(c, http.StatusOK, Status{Status: status}, err)
}

func (r Routes) list(c *gin.Context) error {
	page, err := httpapi.InputPageQuery(c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Accounts.List(c.Request.Context(), secret, page.Limit, page.Offset)
	return answer(c, http.StatusOK, result, err)
}

func (r Routes) provision(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[provisionBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseProvision(body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Accounts.Provision(c.Request.Context(), secret, input)
	return answer(c, http.StatusCreated, result, err)
}

func (r Routes) suspend(c *gin.Context) error {
	if err := httpapi.DecodeEmptyCommand(c, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "suspended", r.Accounts.Suspend(c.Request.Context(), secret, c.Param("id")))
}

func (r Routes) reactivate(c *gin.Context) error {
	if err := httpapi.DecodeEmptyCommand(c, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "reactivated", r.Accounts.Reactivate(c.Request.Context(), secret, c.Param("id")))
}

func (r Routes) assignRole(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[roleBody](c, r.Origin)
	if err != nil {
		return err
	}
	roleKey, err := parseRoleBody(body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "assigned", r.Accounts.AssignRole(c.Request.Context(), secret, c.Param("id"), roleKey))
}

func (r Routes) revokeRole(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	param := c.Param("roleKey")
	roleKey, err := inputRoleKey(&param)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "revoked", r.Accounts.RevokeRole(c.Request.Context(), secret, c.Param("id"), roleKey))
}

func (r Routes) bindBoundary(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[boundaryBody](c, r.Origin)
	if err != nil {
		return err
	}
	ref, err := inputBoundaryRef(body.Key, body.Version)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "bound", r.Accounts.BindBoundary(c.Request.Context(), secret, c.Param("id"), ref))
}

func (r Routes) unbindBoundary(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	key := c.Param("key")
	ref, err := inputBoundaryRef(&key, inputBoundaryVersionParam(c.Param("version")))
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "unbound", r.Accounts.UnbindBoundary(c.Request.Context(), secret, c.Param("id"), ref))
}

func (r Routes) changeEmail(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[emailBody](c, r.Origin)
	if err != nil {
		return err
	}
	email, err := parseEmailBody(body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "changed", r.Accounts.ChangeEmail(c.Request.Context(), secret, c.Param("id"), email))
}

func (r Routes) resetMfa(c *gin.Context) error {
	if err := httpapi.DecodeEmptyCommand(c, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "reset", r.Accounts.ResetMfa(c.Request.Context(), secret, c.Param("id")))
}

func (r Routes) resetGoogleBinding(c *gin.Context) error {
	if err := httpapi.DecodeEmptyCommand(c, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	return done(c, "reset", r.Accounts.ResetGoogleBinding(c.Request.Context(), secret, c.Param("id")))
}
