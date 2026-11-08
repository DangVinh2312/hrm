package authentication_test

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/httpapi"
)

const routesOrigin = "https://app.fixture"

// checksOnly serves the routes with no service behind them, so a request that gets past the checks before
// the services panics and answers 503.
func checksOnly(t *testing.T) http.Handler {
	t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: routesOrigin})
	if err := (authentication.Routes{Origin: routesOrigin}).Register(group); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
	return httpapi.NewHandler(engine)
}

func checkRequest(method, target, body, session string) *http.Request {
	token := strings.Repeat("c", 43)
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Origin", routesOrigin)
	request.Header.Set("X-Csrf-Token", token)
	request.Header.Set("Cookie", "__Host-authz_session="+session+"; __Host-authz_csrf="+token)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func answerOf(handler http.Handler, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestABodyOutsideTheContractIs400BeforeAnyService(t *testing.T) {
	handler := checksOnly(t)
	session := strings.Repeat("s", 43)
	fullWidth := strings.Repeat(string(rune(0xff11)), 6)
	long := strings.Repeat("x", 2049)
	for route, bodies := range map[string][]string{
		"POST /api/auth/mfa/totp/setup":     {`{"extra":1}`, `[]`, `null`, `{`},
		"POST /api/auth/mfa/recovery-codes": {`{"extra":1}`, `[]`},
		"POST /api/auth/mfa/totp/confirm": {
			`{}`, `{"code":"12345"}`, `{"code":"1234567"}`, `{"code":"` + fullWidth + `"}`, `{"code":"123456","x":1}`, `{"code":123456}`,
			`{"code":null}`, `{"code":"12345a"}`, `{"Code":"123456"}`, `{"code":"123456\n"}`, `{"code":"123456","code":"123456"}`,
		},
		"POST /api/auth/mfa/verify": {
			`{}`, `{"code":"12345"}`, `{"code":"123456","recoveryCode":"AAAAAAAAAAAAAAAA"}`, `{"recoveryCode":"not-a-code"}`, `{"recoveryCode":42}`,
			`{"recoveryCode":null}`, `{"recoveryCode":null,"code":"123456"}`, `{"code":null,"recoveryCode":"AAAAAAAAAAAAAAAA"}`, `{"recoveryCode":"` + long + `"}`,
			`{"recoveryCode":"AAAA` + "\x5cu0000" + `AAAAAAAAAAAA"}`,
		},
		"POST /api/auth/oidc/begin": {
			`{}`, `{"issuer":1}`, `{"issuer":null}`, `{"issuer":"x","extra":1}`, `{"Issuer":"x"}`, `{"issuer":"` + long + `"}`, `[]`,
		},
		"POST /api/auth/oidc/activate": {
			`{}`, `{"issuer":"x"}`, `{"token":"x"}`, `{"issuer":"x","token":1}`, `{"issuer":"x","token":null}`, `{"issuer":"` + long + `","token":"x"}`, `{"issuer":"x","token":"` + long + `"}`,
			`{"issuer":"x","token":"y","extra":1}`,
		},
	} {
		method, target, _ := strings.Cut(route, " ")
		for _, body := range bodies {
			answer := answerOf(handler, checkRequest(method, target, body, session))
			if answer.Code != http.StatusBadRequest || answer.Body.String() != `{"statusCode":400,"code":"error.invalidRequest"}` {
				t.Errorf("%s %q: %d %s", route, body, answer.Code, answer.Body)
			}
		}
	}
}

func TestAContentTypeOtherThanJSONIs400(t *testing.T) {
	handler := checksOnly(t)
	for _, target := range []string{"/api/auth/mfa/totp/setup", "/api/auth/mfa/totp/confirm", "/api/auth/oidc/begin"} {
		request := checkRequest(http.MethodPost, target, `{}`, strings.Repeat("s", 43))
		request.Header.Set("Content-Type", "text/plain")
		if answer := answerOf(handler, request); answer.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", target, answer.Code, answer.Body)
		}
	}
}

// With no service behind the routes, an answer of 401 or 403 proves no transaction was opened.
func TestTheChecksBeforeTheServicesKeepTheirOrder(t *testing.T) {
	handler := checksOnly(t)
	authenticated := []struct{ method, target, body string }{
		{http.MethodPost, "/api/auth/logout", ""},
		{http.MethodPost, "/api/auth/logout-all", ""},
		{http.MethodGet, "/api/auth/account", ""},
		{http.MethodPost, "/api/auth/mfa/totp/setup", ""},
		{http.MethodPost, "/api/auth/mfa/totp/confirm", `{"code":"123456"}`},
		{http.MethodPost, "/api/auth/mfa/verify", `{"code":"123456"}`},
		{http.MethodPost, "/api/auth/mfa/recovery-codes", ""},
		{http.MethodDelete, "/api/auth/mfa/totp", ""},
	}
	for _, route := range authenticated {
		for _, session := range []string{"", "not-a-session", strings.Repeat("A", 42), strings.Repeat("A", 42) + "=", strings.Repeat("A", 42) + "B"} {
			answer := answerOf(handler, checkRequest(route.method, route.target, route.body, session))
			if answer.Code != http.StatusUnauthorized || answer.Body.String() != `{"statusCode":401,"code":"error.authenticationFailed"}` {
				t.Errorf("%s %s with session %q: %d %s", route.method, route.target, session, answer.Code, answer.Body)
			}
		}
		repeated := checkRequest(route.method, route.target, route.body, strings.Repeat("s", 43))
		repeated.Header.Add("Cookie", "__Host-authz_session="+strings.Repeat("t", 43))
		if answer := answerOf(handler, repeated); answer.Code != http.StatusBadRequest {
			t.Errorf("%s %s with a repeated cookie: %d %s", route.method, route.target, answer.Code, answer.Body)
		}
		if route.method == http.MethodGet {
			continue
		}
		noCSRF := checkRequest(route.method, route.target, "{", strings.Repeat("s", 43))
		noCSRF.Header.Del("X-Csrf-Token")
		if answer := answerOf(handler, noCSRF); answer.Code != http.StatusForbidden {
			t.Errorf("%s %s without CSRF and a broken body: %d %s", route.method, route.target, answer.Code, answer.Body)
		}
	}
}

func TestTheRemovedSignInRoutesAre404(t *testing.T) {
	handler := checksOnly(t)
	for _, route := range []string{
		"POST /api/auth/oidc/link", "GET /api/auth/oidc/link/pending", "DELETE /api/auth/oidc/link/pending",
		"POST /api/auth/oidc/link/confirm", "POST /api/auth/oidc/unlink", "POST /api/auth/oidc/reauthenticate",
		"POST /api/auth/login", "POST /api/auth/activate", "POST /api/auth/reauthenticate", "POST /api/auth/password",
		"POST /api/auth/recovery/request", "POST /api/auth/recovery/reset",
	} {
		method, target, _ := strings.Cut(route, " ")
		answer := answerOf(handler, checkRequest(method, target, "", strings.Repeat("s", 43)))
		if answer.Code != http.StatusNotFound || answer.Body.String() != `{"statusCode":404,"code":"error.notFound"}` {
			t.Errorf("%s: %d %s", route, answer.Code, answer.Body)
		}
	}
}

func TestARepeatedBrowserCookieIsNotALoginFailure(t *testing.T) {
	handler := checksOnly(t)
	request := httptest.NewRequest(http.MethodGet, "/api/auth/oidc/callback?state=a", http.NoBody)
	request.Header.Add("Cookie", "__Host-authz_browser=a; __Host-authz_browser=b")
	answer := answerOf(handler, request)
	if answer.Code != http.StatusBadRequest || answer.Body.String() != `{"statusCode":400,"code":"error.invalidRequest"}` {
		t.Errorf("%d %s", answer.Code, answer.Body)
	}
}
