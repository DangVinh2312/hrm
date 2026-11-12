package administration

import (
	"math"
	"regexp"
	"strconv"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/grant"
)

const maxBodyText = 2048

var (
	boundaryKeyGrammar     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,95}$`)
	boundaryVersionGrammar = regexp.MustCompile(`^[1-9][0-9]{0,9}$`)
)

type provisionBody struct {
	Email   *string `json:"email"`
	RoleKey *string `json:"roleKey"`
}

type roleBody struct {
	RoleKey *string `json:"roleKey"`
}

type boundaryBody struct {
	Key     *string `json:"key"`
	Version *int64  `json:"version"`
}

type emailBody struct {
	Email *string `json:"email"`
}

// validBoundaryRef: the version is the integer column and the audit detail, 1 to 2^31-1.
func validBoundaryRef(ref BoundaryRef) bool {
	return boundaryKeyGrammar.MatchString(ref.Key) && ref.Version >= 1 && ref.Version <= math.MaxInt32
}

// inputBoundaryRef is a boundary version by key and number: only the shape is known here, the command decides
// the rest.
func inputBoundaryRef(key *string, version *int64) (BoundaryRef, error) {
	if key == nil || version == nil || !validBoundaryRef(BoundaryRef{Key: *key, Version: *version}) {
		return BoundaryRef{}, apperror.ErrInvalidRequest
	}
	return BoundaryRef{Key: *key, Version: *version}, nil
}

// inputBoundaryVersionParam is a version taken from a URL segment: decimal digits without a leading zero, no
// other form; nil when it is not one.
func inputBoundaryVersionParam(text string) *int64 {
	if !boundaryVersionGrammar.MatchString(text) {
		return nil
	}
	version, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return nil
	}
	return &version
}

func parseEmailBody(body emailBody) (string, error) {
	if body.Email == nil || len(*body.Email) > maxBodyText {
		return "", apperror.ErrInvalidRequest
	}
	return *body.Email, nil
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
