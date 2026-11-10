package administration

import (
	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/grant"
)

const maxBodyText = 2048

type provisionBody struct {
	Email   *string `json:"email"`
	RoleKey *string `json:"roleKey"`
}

type roleBody struct {
	RoleKey *string `json:"roleKey"`
}

// inputRoleKey is a role key (code or runtime) as a request names it: only its size is known here, the command
// decides the rest.
func inputRoleKey(value *string) (string, error) {
	if value == nil || !grant.IsRoleKeyReference(*value) {
		return "", apperror.ErrInvalidRequest
	}
	return *value, nil
}

func parseProvision(body provisionBody) (ProvisionInput, error) {
	if body.Email == nil || len(*body.Email) > maxBodyText {
		return ProvisionInput{}, apperror.ErrInvalidRequest
	}
	roleKey, err := inputRoleKey(body.RoleKey)
	if err != nil {
		return ProvisionInput{}, err
	}
	return ProvisionInput{Email: *body.Email, RoleKey: roleKey}, nil
}

func parseRoleBody(body roleBody) (string, error) {
	return inputRoleKey(body.RoleKey)
}
