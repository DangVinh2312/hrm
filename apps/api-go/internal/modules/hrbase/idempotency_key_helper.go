package hrbase

import (
	"regexp"

	"hrm/api-go/internal/apperror"
)

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func ParseIdempotencyKey(values []string) (string, error) {
	if len(values) != 1 || !uuidV4.MatchString(values[0]) {
		return "", apperror.ErrInvalidRequest
	}
	return values[0], nil
}
