package app

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"

	"hrm/api-go/contract"
	"hrm/api-go/internal/config"
	"hrm/api-go/internal/httpapi"
)

const httpTestOrigin = "http://localhost:3000"

var routeParameter = regexp.MustCompile(`:[^/]+`)

// bootedHandler is the handler of a real boot over no database: a request that passes the checks before
// the services fails on the empty pools with something other than what these tests expect.
func bootedHandler(t *testing.T, origin string) http.Handler {
	t.Helper()
	cfg := testConfig("")
	cfg.Origin = origin
	running, err := boot(t.Context(), cfg, quietLogger(), testSteps(t, &recorder{}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		running.release()
		if err := running.listener.Close(); err != nil {
			t.Error(err)
		}
	})
	return running.server.Handler
}

// migratedWrites is every route served here whose method is not safe; CheckInventory holds MigratedRoutes
// equal to what the boot registered, so a new route is in this list by being served.
func migratedWrites() []httpapi.Route {
	var writes []httpapi.Route
	for _, route := range httpapi.MigratedRoutes {
		if route.Method != http.MethodGet && route.Method != http.MethodHead {
			writes = append(writes, route)
		}
	}
	return writes
}

func TestEveryMigratedWriteRefusesAMissingCSRF(t *testing.T) {
	handler := bootedHandler(t, httpTestOrigin)
	writes := migratedWrites()
	if len(writes) < 9 {
		t.Fatalf("%d writes", len(writes))
	}
	token, other, session := httpapi.NewCSRF(), httpapi.NewCSRF(), httpapi.NewCSRF()
	full := func(r *http.Request) {
		r.Header.Set("Origin", httpTestOrigin)
		r.Header.Set("X-Csrf-Token", token)
		r.Header.Set("Cookie", "authz_session="+session+"; authz_csrf="+token)
	}
	refusals := map[string]func(*http.Request){
		"no token":       func(r *http.Request) { r.Header.Del("X-Csrf-Token") },
		"another token":  func(r *http.Request) { r.Header.Set("X-Csrf-Token", other) },
		"no csrf cookie": func(r *http.Request) { r.Header.Set("Cookie", "authz_session="+session) },
		"no origin":      func(r *http.Request) { r.Header.Del("Origin") },
		"another origin": func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") },
		"a repeated token": func(r *http.Request) {
			r.Header.Add("X-Csrf-Token", token)
		},
	}
	send := func(route httpapi.Route, body string, change func(*http.Request)) *httptest.ResponseRecorder {
		target := routeParameter.ReplaceAllString(route.Path, "00000000-0000-4000-8000-000000000000")
		request := httptest.NewRequest(route.Method, target, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		full(request)
		change(request)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	for _, route := range writes {
		for name, change := range refusals {
			for _, body := range []string{"", "{", `{"extra":1}`} {
				answer := send(route, body, change)
				if answer.Code != http.StatusForbidden || answer.Body.String() != `{"statusCode":403,"code":"error.accessDenied"}` {
					t.Errorf("%s, %s, body %q: %d %s", route, name, body, answer.Code, answer.Body)
				}
			}
		}
		if answer := send(route, "", func(*http.Request) {}); answer.Code == http.StatusForbidden {
			t.Errorf("%s refuses a request with its CSRF: %s", route, answer.Body)
		}
	}
}

func TestTheRoutesOfAuthCarryTheConfiguration(t *testing.T) {
	calls := &recorder{}
	running := &application{steps: testSteps(t, calls), logger: quietLogger()}
	cfg := testConfig("")
	cfg.Origin, cfg.TrustProxy = "https://app.test", 3
	routes, err := running.authRoutes(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if routes.Origin != cfg.Origin || routes.TrustProxy != 3 || routes.Identity == nil || routes.Mfa == nil || routes.Oidc == nil {
		t.Errorf("%+v", routes)
	}
}

// Statuses a handler of auth/* can answer, written from reading the handlers: 400 needs a repeated cookie at
// the least, 409 a transaction out of retries, 503 a fault or a panic, 401 a dead session, 403 a missing CSRF or
// step-up. csrf and options read no cookie and open no transaction.
var authRouteStatuses = map[httpapi.Route][]string{
	{Method: http.MethodGet, Path: "/api/auth/csrf"}:                {"200", "503"},
	{Method: http.MethodGet, Path: "/api/auth/options"}:             {"200", "503"},
	{Method: http.MethodPost, Path: "/api/auth/logout"}:             {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodPost, Path: "/api/auth/logout-all"}:         {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodGet, Path: "/api/auth/account"}:             {"200", "400", "401", "409", "503"},
	{Method: http.MethodPost, Path: "/api/auth/mfa/totp/setup"}:     {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodPost, Path: "/api/auth/mfa/totp/confirm"}:   {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodPost, Path: "/api/auth/mfa/verify"}:         {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodPost, Path: "/api/auth/mfa/recovery-codes"}: {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodDelete, Path: "/api/auth/mfa/totp"}:         {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodPost, Path: "/api/auth/oidc/begin"}:         {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodPost, Path: "/api/auth/oidc/activate"}:      {"200", "400", "401", "403", "409", "503"},
	{Method: http.MethodGet, Path: "/api/auth/oidc/callback"}:       {"303", "400", "409", "503"},
}

// It compares two lists written by hand and runs no handler: a handler that starts answering a new status stays
// green until the table changes.
func TestTheOpenAPIOfAuthMatchesTheTableOfStatuses(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal([]byte(contract.OpenAPI()), &document); err != nil {
		t.Fatal(err)
	}
	for route, want := range authRouteStatuses {
		var operation struct {
			Responses map[string]json.RawMessage `json:"responses"`
		}
		if err := json.Unmarshal(document.Paths[route.Path][strings.ToLower(route.Method)], &operation); err != nil {
			t.Fatalf("%s: %v", route, err)
		}
		if got := slices.Sorted(maps.Keys(operation.Responses)); !slices.Equal(got, want) {
			t.Errorf("%s: %v, want %v", route, got, want)
		}
	}
}

func TestTheGuardAndTheCookiesOfAuthUseOneOrigin(t *testing.T) {
	const origin = "https://app.test"
	handler := bootedHandler(t, origin)
	token, session := httpapi.NewCSRF(), httpapi.NewCSRF()
	send := func(cookie string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/auth/logout", http.NoBody)
		request.Header.Set("Origin", origin)
		request.Header.Set("X-Csrf-Token", token)
		request.Header.Set("Cookie", cookie)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	if answer := send("authz_session=" + session + "; authz_csrf=" + token); answer.Code != http.StatusUnauthorized {
		t.Errorf("the names of HTTP on an HTTPS origin: %d %s", answer.Code, answer.Body)
	}
	if answer := send(httpapi.CookieName(origin, httpapi.SessionCookie) + "=" + session + "; authz_csrf=" + token); answer.Code != http.StatusForbidden {
		t.Errorf("the guard's cookie with the CSRF cookie of another origin: %d %s", answer.Code, answer.Body)
	}
	if answer := send(httpapi.CookieName(origin, httpapi.SessionCookie) + "=" + session + "; " +
		httpapi.CookieName(origin, httpapi.CSRFCookie) + "=" + token); answer.Code == http.StatusForbidden || answer.Code == http.StatusUnauthorized {
		t.Errorf("the cookies of the origin: %d %s", answer.Code, answer.Body)
	}
}

func discoveryServer(t *testing.T, calls *recorder, status int) *httptest.Server {
	t.Helper()
	var issuer string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		calls.add("discovery")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if _, err := w.Write([]byte(`{"issuer":"` + issuer + `","authorization_endpoint":"` + issuer + `/authorize","token_endpoint":"` + issuer + `/token","jwks_uri":"` + issuer + `/jwks"}`)); err != nil {
			t.Error(err)
		}
	}))
	issuer = server.URL
	t.Cleanup(server.Close)
	return server
}

func TestDiscoveryRunsInTheBootAndAFailureStopsIt(t *testing.T) {
	for name, c := range map[string]struct {
		status int
		want   []string
		step   string
	}{
		"answers": {http.StatusOK, []string{"pools", "discovery", "verify", "permission protection", "key coverage", "manifest", "oidc provider sync", "company anchor", "work calendar anchor", "setting anchor", "role anchor", "domain schema", "work calendar schema", "setting schema", "listen"}, ""},
		"fails":   {http.StatusInternalServerError, []string{"pools", "discovery", "close pools"}, "oidc providers"},
	} {
		t.Run(name, func(t *testing.T) {
			calls := &recorder{}
			server := discoveryServer(t, calls, c.status)
			using := testSteps(t, calls)
			using.providers = productSteps(server.Client()).providers
			cfg := testConfig("")
			cfg.OidcProviders = []config.ProductOidcProviderConfig{{
				Issuer: server.URL, ClientID: "client", RedirectURI: httpTestOrigin + "/api/auth/oidc/callback", Version: "1",
			}}
			running, err := boot(t.Context(), cfg, quietLogger(), using)
			if !slices.Equal(calls.list(), c.want) {
				t.Errorf("%v, want %v", calls.list(), c.want)
			}
			if c.step != "" {
				if step, ok := errors.AsType[*BootError](err); !ok || step.Step != c.step {
					t.Fatalf("%v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			running.release()
			if err := running.listener.Close(); err != nil {
				t.Error(err)
			}
		})
	}
}
