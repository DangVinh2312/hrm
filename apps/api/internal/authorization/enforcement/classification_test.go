package enforcement_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/enforcement"
)

type countingAuth struct {
	calls  int
	answer error
	seen   *http.Request
}

func (a *countingAuth) Authenticate(request *http.Request) error {
	a.calls++
	a.seen = request
	return a.answer
}

func TestPublicNeverAuthenticates(t *testing.T) {
	auth := &countingAuth{answer: apperror.ErrAuthenticationFailed}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	if err := enforcement.Public().Check(request, auth); err != nil {
		t.Fatal(err)
	}
	if auth.calls != 0 {
		t.Errorf("a public route authenticated %d times", auth.calls)
	}
}

func TestAuthenticatedPassesTheRequestAndItsAnswer(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, answer := range []error{nil, apperror.ErrAuthenticationFailed, apperror.ErrInvalidRequest} {
		auth := &countingAuth{answer: answer}
		if err := enforcement.Authenticated().Check(request, auth); !errors.Is(err, answer) || (answer == nil && err != nil) {
			t.Errorf("answer %v, got %v", answer, err)
		}
		if auth.calls != 1 || auth.seen != request {
			t.Errorf("calls %d, same request %v", auth.calls, auth.seen == request)
		}
	}
}

func TestOnlyPublicAndAuthenticatedRegister(t *testing.T) {
	for name, c := range map[string]enforcement.Classification{
		"public":        enforcement.Public(),
		"authenticated": enforcement.Authenticated(),
	} {
		if err := c.Registrable(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, c := range map[string]enforcement.Classification{
		"zero value": {},
		"authorize":  enforcement.Authorize("item", "read"),
	} {
		if c.Registrable() == nil {
			t.Errorf("%s registers", name)
		}
	}
}

func TestAuthorizeChecksRegisteredPermissionAndOnlyCookieShape(t *testing.T) {
	c := enforcement.Authorize("item", "read")
	if c.Registrable(func(resource, action string) bool { return resource == "item" && action == "read" }) != nil {
		t.Fatal("known permission refused")
	}
	if c.Registrable(func(string, string) bool { return false }) == nil {
		t.Fatal("unknown permission registered")
	}
	auth := &countingAuth{answer: apperror.ErrAuthenticationFailed}
	if err := c.Check(httptest.NewRequest(http.MethodGet, "/", nil), auth); !errors.Is(err, apperror.ErrAuthenticationFailed) || auth.calls != 1 {
		t.Fatal("authorize did not delegate to cookie check")
	}
}

func TestAnUnregistrableClassificationDeniesAndNeverAuthenticates(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	for name, c := range map[string]enforcement.Classification{
		"zero value": {},
	} {
		auth := &countingAuth{}
		if err := c.Check(request, auth); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s: %v", name, err)
		}
		if auth.calls != 0 {
			t.Errorf("%s authenticated", name)
		}
	}
}

func TestAMissingRequestAuthDenies(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	if err := enforcement.Authenticated().Check(request, nil); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("got %v", err)
	}
}
