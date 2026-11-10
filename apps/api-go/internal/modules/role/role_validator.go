package role

import (
	"math"
	"regexp"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/grant"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/httpapi"
)

const (
	maxKeyLength = 160
	maxLabel     = 120
)

var digestGrammar = regexp.MustCompile(`^[0-9a-f]{64}$`)

// createBody: grants is a pointer so a missing or null list is refused, while [] is a role with no grant.
type createBody struct {
	Key    string       `json:"key"`
	Label  string       `json:"label"`
	Grants *[]GrantPair `json:"grants"`
}

type updateBody struct {
	Label          string       `json:"label"`
	Grants         *[]GrantPair `json:"grants"`
	ExpectedDigest string       `json:"expectedDigest"`
}

func parseKey(value string) (string, error) {
	if !grant.IsRuntimeRoleKey(value) {
		return "", apperror.ErrInvalidRequest
	}
	return value, nil
}

// parseGrants takes at most keys.MaxRoleGrants grants and refuses a repeated one.
func parseGrants(value *[]GrantPair) ([]GrantPair, error) {
	if value == nil || len(*value) > keys.MaxRoleGrants {
		return nil, apperror.ErrInvalidRequest
	}
	grants := make([]GrantPair, 0, len(*value))
	seen := make(map[GrantPair]bool, len(*value))
	for _, pair := range *value {
		if len(pair.Permission) > maxKeyLength || len(pair.Template.Key) > maxKeyLength || pair.Template.Version < 1 || pair.Template.Version > math.MaxInt32 || seen[pair] {
			return nil, apperror.ErrInvalidRequest
		}
		seen[pair] = true
		grants = append(grants, pair)
	}
	return grants, nil
}

func parseCreate(body createBody) (CreateInput, error) {
	key, err := parseKey(body.Key)
	if err != nil {
		return CreateInput{}, err
	}
	label, err := httpapi.InputText(body.Label, maxLabel)
	if err != nil {
		return CreateInput{}, err
	}
	grants, err := parseGrants(body.Grants)
	if err != nil {
		return CreateInput{}, err
	}
	return CreateInput{Key: key, Label: label, Grants: grants}, nil
}

// parseUpdate: the key of the route is immutable, so the body carries none.
func parseUpdate(key string, body updateBody) (UpdateInput, error) {
	roleKey, err := parseKey(key)
	if err != nil {
		return UpdateInput{}, err
	}
	if !digestGrammar.MatchString(body.ExpectedDigest) {
		return UpdateInput{}, apperror.ErrInvalidRequest
	}
	created, err := parseCreate(createBody{Key: roleKey, Label: body.Label, Grants: body.Grants})
	if err != nil {
		return UpdateInput{}, err
	}
	return UpdateInput{CreateInput: created, ExpectedDigest: body.ExpectedDigest}, nil
}

func specs(grants []GrantPair) []grant.RoleGrantSpec {
	out := make([]grant.RoleGrantSpec, len(grants))
	for i, pair := range grants {
		out[i] = grant.RoleGrantSpec{Permission: pair.Permission, Template: core.RelationRef{Key: pair.Template.Key, Version: pair.Template.Version}}
	}
	return out
}

// checkCatalog: declared permissions with a template of the same resource, no `document` (a fixture of the
// core, not assignable through the API) and no `approvals` without `decideFinal`.
func checkCatalog(declarations *core.ValidatedDeclarations, label string, grants []GrantPair) error {
	if text, err := httpapi.InputText(label, maxLabel); err != nil || text != label {
		return apperror.ErrInvalidRequest
	}
	if grant.CheckRoleGrants(declarations, specs(grants)) != grant.GrantsOK || lacksFinalDecision(grants) {
		return apperror.ErrInvalidRequest
	}
	for _, pair := range grants {
		if isDocument(pair.Permission) {
			return apperror.ErrInvalidRequest
		}
	}
	return nil
}
