// Package enforcement classifies routes and rejects a request before its handler. It never reads
// the database: the session and facts are resolved by the services, under the application fence.
package enforcement

import (
	"errors"
	"net/http"

	"hrm/api-go/internal/apperror"
)

type kind int

const (
	kindNone kind = iota
	kindPublic
	kindAuthenticated
	kindAuthorize
)

// Classification is the one class of a route. Its zero value is no class and is refused.
type Classification struct {
	kind     kind
	resource string
	action   string
}

func Public() Classification { return Classification{kind: kindPublic} }

func Authenticated() Classification { return Classification{kind: kindAuthenticated} }

func Authorize(resource, action string) Classification {
	return Classification{kind: kindAuthorize, resource: resource, action: action}
}

// ParseClassification reads the class the contract writes; an unknown kind fails.
func ParseClassification(kind, resource, action string) (Classification, error) {
	switch kind {
	case "public":
		return Public(), nil
	case "authenticated":
		return Authenticated(), nil
	case "authorize":
		return Authorize(resource, action), nil
	}
	return Classification{}, errNoClassification
}

// RequestAuth is the early check by the shape of the session cookie, installed at the composition root.
type RequestAuth interface {
	Authenticate(request *http.Request) error
}

var (
	errNoClassification  = errors.New("product route must have exactly one classification")
	errUnknownPermission = errors.New("authorize route permission is not declared")
)

// Registrable fails for a classification no route may be registered with.
func (c Classification) Registrable(permissions ...func(resource, action string) bool) error {
	switch c.kind {
	case kindPublic, kindAuthenticated:
		return nil
	case kindAuthorize:
		if len(permissions) != 1 || permissions[0] == nil || !permissions[0](c.resource, c.action) {
			return errUnknownPermission
		}
		return nil
	case kindNone:
		return errNoClassification
	}
	return errNoClassification
}

// Check runs the early request check; authority operations resolve permissions under their fence.
func (c Classification) Check(request *http.Request, auth RequestAuth) error {
	switch c.kind {
	case kindPublic:
		return nil
	case kindAuthenticated, kindAuthorize:
		if auth == nil {
			return apperror.ErrAccessDenied
		}
		return auth.Authenticate(request)
	case kindNone:
		return apperror.ErrAccessDenied
	}
	return apperror.ErrAccessDenied
}
