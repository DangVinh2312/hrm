package role

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/httpapi"
)

// Routes are the role matrix, an account's effective grants and the runtime role writes.
type Routes struct {
	Roles  HTTPPort
	Origin string
}

func (r Routes) Register(group *httpapi.Group) error {
	role := string(keys.RoleResourceRole)
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/administration/roles", enforcement.Authorize(role, string(keys.RoleActionRead)), r.matrix},
		{http.MethodGet, "/api/administration/accounts/:id/permissions", enforcement.Authorize(string(keys.AccountResourceAccount), string(keys.AccountActionReadPermissions)), r.accountPermissions},
		{http.MethodPost, "/api/administration/roles", enforcement.Authorize(role, string(keys.RoleActionCreate)), r.create},
		{http.MethodPut, "/api/administration/roles/:key", enforcement.Authorize(role, string(keys.RoleActionUpdate)), r.update},
		{http.MethodDelete, "/api/administration/roles/:key", enforcement.Authorize(role, string(keys.RoleActionDelete)), r.remove},
	} {
		handler := func(c *gin.Context) {
			if err := route.handle(c); err != nil {
				httpapi.WriteError(c, err)
			}
		}
		if err := httpapi.Register(group, route.method, route.path, route.class, handler); err != nil {
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

func answerFound[T any](c *gin.Context, value T, ok bool, err error) error {
	if err == nil && !ok {
		return apperror.ErrNotFound
	}
	return answer(c, http.StatusOK, value, err)
}

func (r Routes) matrix(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	view, ok, err := r.Roles.Matrix(c.Request.Context(), secret)
	return answerFound(c, view, ok, err)
}

func (r Routes) accountPermissions(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	view, ok, err := r.Roles.AccountPermissions(c.Request.Context(), secret, c.Param("id"))
	return answerFound(c, view, ok, err)
}

func (r Routes) create(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[createBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseCreate(body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Roles.Create(c.Request.Context(), secret, input)
	return answer(c, http.StatusCreated, result, err)
}

func (r Routes) update(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[updateBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseUpdate(c.Param("key"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Roles.Update(c.Request.Context(), secret, input)
	return answer(c, http.StatusOK, result, err)
}

func (r Routes) remove(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	key, err := parseKey(c.Param("key"))
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Roles.Remove(c.Request.Context(), secret, key)
	return answer(c, http.StatusOK, result, err)
}
