package employee

import (
	"github.com/gin-gonic/gin"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
	"net/http"
)

func (r Routes) registerWrites(group *httpapi.Group) error {
	for _, route := range []struct {
		method, path, resource, action string
		handle                         func(*gin.Context) error
	}{
		{"POST", "/api/hr/employees", "hrCompany", "createEmployee", r.create},
		{"PATCH", "/api/hr/employees/:id", "employee", "update", r.update},
		{"POST", "/api/hr/employees/:id/official", "employee", "update", r.official},
		{"POST", "/api/hr/employees/:id/termination", "employee", "update", r.terminate},
		{"POST", "/api/hr/employees/:id/leave-rates", "employee", "adjustLeaveRate", r.adjustRate},
		{"PUT", "/api/hr/employees/:id/identity", "employeeIdentity", "update", r.updateIdentity},
		{"PUT", "/api/hr/employees/:id/account", "employee", "linkAccount", r.linkAccount},
	} {
		if err := httpapi.Register(group, route.method, route.path, enforcement.Authorize(route.resource, route.action), func(c *gin.Context) {
			if err := route.handle(c); err != nil {
				httpapi.WriteError(c, err)
			}
		}); err != nil {
			return err
		}
	}
	return nil
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
	value, err := r.Employees.Create(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusCreated, value)
}
func (r Routes) update(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[updateBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseUpdate(c.Param("id"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Employees.Update(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}
func (r Routes) official(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[officialBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseOfficial(c.Param("id"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Employees.Official(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}
func (r Routes) terminate(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[terminationBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseTermination(c.Param("id"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Employees.Terminate(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}
func (r Routes) updateIdentity(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[identityUpdateBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseIdentityUpdate(c.Param("id"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Employees.UpdateIdentity(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}
func (r Routes) adjustRate(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[leaveRateBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseLeaveRate(c.Param("id"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Employees.AdjustLeaveRate(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusCreated, value)
}
func (r Routes) linkAccount(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[accountLinkBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseAccountLink(c.Param("id"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Employees.LinkAccount(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeEmployeeAnswer(c, http.StatusOK, value)
}
