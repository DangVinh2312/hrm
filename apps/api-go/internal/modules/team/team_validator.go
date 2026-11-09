package team

import (
	"encoding/json/v2"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/httpapi"
)

type memberBody struct {
	EmployeeID string `json:"employeeId"`
	Primary    *bool  `json:"primary"`
}
type nullableEmployee struct {
	Present bool
	Value   *string
}

func (v *nullableEmployee) UnmarshalJSON(data []byte) error {
	v.Present = true
	return json.Unmarshal(data, &v.Value)
}

type leadBody struct {
	EmployeeID nullableEmployee `json:"employeeId"`
}

func parseCreate(c *gin.Context, origin string) (CreateInput, error) {
	input, err := httpapi.DecodeCommand[CreateInput](c, origin)
	if err != nil {
		return CreateInput{}, err
	}
	input.Name, err = httpapi.InputText(input.Name, 200)
	return input, err
}
func parseRename(c *gin.Context, origin string) (RenameInput, error) {
	input, err := httpapi.DecodeCommand[RenameInput](c, origin)
	if err != nil {
		return RenameInput{}, err
	}
	if input.TeamID, err = httpapi.InputUUID(c.Param("id")); err != nil {
		return RenameInput{}, err
	}
	if input.ExpectedVersion, err = httpapi.InputVersion(input.ExpectedVersion); err != nil {
		return RenameInput{}, err
	}
	input.Name, err = httpapi.InputText(input.Name, 200)
	return input, err
}
func parseMember(c *gin.Context, origin string) (MemberInput, error) {
	body, err := httpapi.DecodeCommand[memberBody](c, origin)
	if err != nil {
		return MemberInput{}, err
	}
	ref, err := parseMembership(c.Param("id"), body.EmployeeID)
	if err != nil {
		return MemberInput{}, err
	}
	primary, err := httpapi.InputBoolean(body.Primary)
	return MemberInput{TeamID: ref.TeamID, EmployeeID: ref.EmployeeID, Primary: primary}, err
}
func parseLead(c *gin.Context, origin string) (LeadInput, error) {
	body, err := httpapi.DecodeCommand[leadBody](c, origin)
	if err != nil {
		return LeadInput{}, err
	}
	teamID, err := httpapi.InputUUID(c.Param("id"))
	if err != nil {
		return LeadInput{}, err
	}
	if !body.EmployeeID.Present {
		return LeadInput{}, apperror.ErrInvalidRequest
	}
	if body.EmployeeID.Value != nil {
		id, err := httpapi.InputUUID(*body.EmployeeID.Value)
		if err != nil {
			return LeadInput{}, err
		}
		body.EmployeeID.Value = &id
	}
	return LeadInput{TeamID: teamID, EmployeeID: body.EmployeeID.Value}, nil
}
func parseMembership(teamID, employeeID string) (MembershipRef, error) {
	team, err := httpapi.InputUUID(teamID)
	if err != nil {
		return MembershipRef{}, err
	}
	employee, err := httpapi.InputUUID(employeeID)
	return MembershipRef{team, employee}, err
}
