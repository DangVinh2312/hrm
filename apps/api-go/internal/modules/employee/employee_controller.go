package employee

import (
	"encoding/json/v2"
	"github.com/gin-gonic/gin"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
	"net/http"
)

type Routes struct {
	Employees HTTPPort
	Origin    string
}

func (r Routes) Register(group *httpapi.Group) error {
	for _, route := range []struct {
		path   string
		class  enforcement.Classification
		handle func(*gin.Context) error
	}{
		{"/api/hr/employees", enforcement.Authorize("employee", "read"), r.list},
		{"/api/hr/employees/:id", enforcement.Authorize("employee", "read"), r.detail},
		{"/api/hr/employees/:id/identity", enforcement.Authorize("employeeIdentity", "read"), r.identity},
		{"/api/hr/employees/:id/leave-rates", enforcement.Authorize("leaveRate", "read"), r.rates},
		{"/api/hr/employees/me", enforcement.Authenticated(), r.profile},
	} {
		if err := httpapi.Register(group, http.MethodGet, route.path, route.class, func(c *gin.Context) {
			if err := route.handle(c); err != nil {
				httpapi.WriteError(c, err)
			}
		}); err != nil {
			return err
		}
	}
	return nil
}

func writeEmployeeAnswer[T any](c *gin.Context, status int, value T) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, status, body)
	return nil
}

func (r Routes) list(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseList(c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	value, err := r.Employees.List(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}

func (r Routes) detail(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	id, err := httpapi.InputUUID(c.Param("id"))
	if err != nil {
		return err
	}
	value, err := r.Employees.Detail(c.Request.Context(), secret, id)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}

func (r Routes) identity(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	id, err := httpapi.InputUUID(c.Param("id"))
	if err != nil {
		return err
	}
	value, err := r.Employees.Identity(c.Request.Context(), secret, id)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}

func (r Routes) rates(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	id, err := httpapi.InputUUID(c.Param("id"))
	if err != nil {
		return err
	}
	value, err := r.Employees.LeaveRates(c.Request.Context(), secret, id)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}

func (r Routes) profile(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Employees.Profile(c.Request.Context(), secret)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}
