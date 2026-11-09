package team

import (
	"encoding/json/v2"
	"net/http"

	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/httpapi"

	"github.com/gin-gonic/gin"
)

type Routes struct {
	Teams  HTTPPort
	Origin string
}

func (r Routes) Register(group *httpapi.Group) error {
	resource := string(keys.TeamResourceTeam)
	read := enforcement.Authorize(resource, string(keys.TeamActionRead))
	assign := enforcement.Authorize(resource, string(keys.TeamActionAssign))
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/hr/teams", read, r.list},
		{http.MethodPost, "/api/hr/teams", enforcement.Authorize(string(keys.CompanyResourceCompany), string(keys.CompanyActionCreateTeam)), r.create},
		{http.MethodGet, "/api/hr/teams/:id", read, r.detail},
		{http.MethodPatch, "/api/hr/teams/:id", enforcement.Authorize(resource, string(keys.TeamActionUpdate)), r.rename},
		{http.MethodPut, "/api/hr/teams/:id/lead", assign, r.assignLead},
		{http.MethodPost, "/api/hr/teams/:id/members", assign, r.addMember},
		{http.MethodDelete, "/api/hr/teams/:id/members/:employeeId", assign, r.endMembership},
		{http.MethodPost, "/api/hr/teams/:id/members/:employeeId/primary", assign, r.setPrimary},
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
func writeTeamAnswer[T any](c *gin.Context, status int, value T) error {
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
	page, err := httpapi.InputPageQuery(c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	value, err := r.Teams.List(c.Request.Context(), secret, ListQuery{Limit: page.Limit, Offset: page.Offset})
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusOK, value)
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
	value, err := r.Teams.Detail(c.Request.Context(), secret, id)
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusOK, value)
}
func (r Routes) create(c *gin.Context) error {
	input, err := parseCreate(c, r.Origin)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Teams.Create(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusCreated, value)
}
func (r Routes) rename(c *gin.Context) error {
	input, err := parseRename(c, r.Origin)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Teams.Rename(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusOK, value)
}
func (r Routes) addMember(c *gin.Context) error {
	input, err := parseMember(c, r.Origin)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Teams.AddMember(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusOK, value)
}
func (r Routes) assignLead(c *gin.Context) error {
	input, err := parseLead(c, r.Origin)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	value, err := r.Teams.AssignLead(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusOK, value)
}
func (r Routes) endMembership(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseMembership(c.Param("id"), c.Param("employeeId"))
	if err != nil {
		return err
	}
	value, err := r.Teams.EndMembership(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusOK, value)
}
func (r Routes) setPrimary(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseMembership(c.Param("id"), c.Param("employeeId"))
	if err != nil {
		return err
	}
	value, err := r.Teams.SetPrimary(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return writeTeamAnswer(c, http.StatusOK, value)
}
