package authentication_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/httpapi"
)

const origin = "https://hrm.example.test"

func withCookies(cookies ...string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "/api/auth/account", nil)
	for _, cookie := range cookies {
		request.Header.Add("Cookie", cookie)
	}
	return request
}

func TestRequestAuthChecksOnlyTheShapeOfTheSessionCookie(t *testing.T) {
	name := httpapi.CookieName(origin, httpapi.SessionCookie)
	secret := credential.NewSessionSecret()
	if err := (authentication.RequestAuth{Origin: origin}).Authenticate(withCookies(name + "=" + secret)); err != nil {
		t.Errorf("well formed: %v", err)
	}
	for label, request := range map[string]*http.Request{
		"no cookie":        withCookies(),
		"empty":            withCookies(name + "="),
		"short":            withCookies(name + "=" + secret[:42]),
		"spare bits":       withCookies(name + "=" + strings.Repeat("A", 42) + "B"),
		"other app's name": withCookies("session=" + secret),
	} {
		if err := (authentication.RequestAuth{Origin: origin}).Authenticate(request); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: %v", label, err)
		}
	}
	if err := (authentication.RequestAuth{Origin: origin}).Authenticate(withCookies(name+"="+secret, name+"="+secret)); err == nil {
		t.Error("a repeated session cookie passed")
	}
}
