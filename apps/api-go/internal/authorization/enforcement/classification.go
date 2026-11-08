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
	errNoClassification = errors.New("product route must have exactly one classification")
	// shortcut: authorize needs the declarations check of the route inventory, add it with the declarations (plan Task 8).
	errAuthorizeUnsupported = errors.New("authorize routes cannot be registered yet")
)

// Registrable fails for a classification no route may be registered with.
func (c Classification) Registrable() error {
	switch c.kind {
	case kindPublic, kindAuthenticated:
		return nil
	case kindAuthorize:
		return errAuthorizeUnsupported
	case kindNone:
		return errNoClassification
	}
	return errNoClassification
}

// Check runs before the handler; a classification that cannot register denies.
func (c Classification) Check(request *http.Request, auth RequestAuth) error {
	switch c.kind {
	case kindPublic:
		return nil
	case kindAuthenticated:
		if auth == nil {
			return apperror.ErrAccessDenied
		}
		return auth.Authenticate(request)
	case kindNone, kindAuthorize:
		return apperror.ErrAccessDenied
	}
	return apperror.ErrAccessDenied
}
