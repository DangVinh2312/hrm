//go:build integration

package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"

	"hrm/api-go/contract"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/config"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	revokeSession = `UPDATE application_session SET revoked_at=statement_timestamp()`
	insertFactor  = `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('ab',12),'hex'),'retired')`
)

// stepsOver is the steps of the product over the pools of a test database, with no IdP to discover.
func stepsOver(stack *test.Stack) steps {
	using := productSteps(&http.Client{})
	using.openPools = func(context.Context, map[database.Purpose]string, database.TLSMode) (database.Pools, error) {
		return stack.Pools, nil
	}
	using.closePools = func(database.Pools) {}
	using.providers = func(context.Context, []config.ProductOidcProviderConfig) ([]*authentication.OidcProvider, error) {
		return nil, nil
	}
	using.listen = func(ctx context.Context, _ int) (net.Listener, error) {
		return (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
	}
	return using
}

func configOver() config.Config {
	return config.Config{NodeEnv: "test", Origin: httpTestOrigin, OidcProviders: []config.ProductOidcProviderConfig{{Issuer: test.FixtureIssuer, Version: "1"}}}
}

// Bodies of the routes that read one, so the request gets as far as the session. A new authenticated route
// with a body answers 400 here until it is listed.
var validBodies = map[httpapi.Route]string{
	{Method: http.MethodPost, Path: "/api/auth/mfa/totp/confirm"}:    `{"code":"123456"}`,
	{Method: http.MethodPost, Path: "/api/auth/mfa/verify"}:          `{"code":"123456"}`,
	{Method: http.MethodPost, Path: "/api/hr/requests/:id/decision"}: `{"expectedVersion":"1","decision":"approve"}`,
	{Method: http.MethodPost, Path: "/api/hr/requests/:id/cancel"}:   `{"expectedVersion":"1"}`,
}

// validKeys are the routes that read an Idempotency-Key before the session.
var validKeys = map[httpapi.Route]bool{
	{Method: http.MethodPost, Path: "/api/hr/requests/:id/decision"}: true,
	{Method: http.MethodPost, Path: "/api/hr/requests/:id/cancel"}:   true,
}

// RequestAuth reads only the shape of the cookie, so a route that does not resolve the session in a
// transaction answers here with data or success. A route is in this test by being served as authenticated.
func TestEveryAuthenticatedRouteResolvesTheSession(t *testing.T) {
	stack := test.NewDatabase(t)
	running, err := boot(t.Context(), configOver(), quietLogger(), stepsOver(stack))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		running.release()
		if err := running.listener.Close(); err != nil {
			t.Error(err)
		}
	})
	contractRoutes, err := httpapi.ParseContractRoutes(contract.Routes())
	if err != nil {
		t.Fatal(err)
	}
	revoked := fixture.Session(t, stack, fixture.Account(t, stack, fixture.AccountSpec{Email: "revoked@example.test"}).ID, fixture.SessionSpec{})
	connection, err := stack.Cluster.ConnectSuperuser(t.Context(), stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), revokeSession); err != nil {
		t.Fatal(test.Redact(err))
	}
	token := httpapi.NewCSRF()
	served := 0
	for _, route := range contractRoutes {
		if route.Classification != enforcement.Authenticated() || !slices.Contains(httpapi.MigratedRoutes, route.Route) {
			continue
		}
		served++
		for name, secret := range map[string]string{"no such session": httpapi.NewCSRF(), "revoked": revoked} {
			body := validBodies[route.Route]
			target := routeParameter.ReplaceAllString(route.Path, "00000000-0000-4000-8000-000000000000")
			request := httptest.NewRequest(route.Method, target, strings.NewReader(body))
			if body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			request.Header.Set("Origin", httpTestOrigin)
			request.Header.Set("X-Csrf-Token", token)
			request.Header.Set("Cookie", "authz_session="+secret+"; authz_csrf="+token)
			if validKeys[route.Route] {
				request.Header.Set("Idempotency-Key", "0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21")
			}
			recorder := httptest.NewRecorder()
			running.server.Handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusUnauthorized || recorder.Body.String() != `{"statusCode":401,"code":"error.authenticationFailed"}` {
				t.Errorf("%s, %s: %d %s", route.Route, name, recorder.Code, recorder.Body)
			}
		}
	}
	if served < 8 {
		t.Errorf("%d authenticated routes served", served)
	}
}

func fixtureKeyRing(t *testing.T) config.MfaKeyRing {
	t.Helper()
	ring, err := config.ParseMfaKeyRing("retired:"+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)), "retired")
	if err != nil {
		t.Fatal(err)
	}
	return ring
}

func TestAStoredFactorUnderAKeyTheRingHasBoots(t *testing.T) {
	stack := test.NewDatabase(t)
	user := fixture.Account(t, stack, fixture.AccountSpec{Email: "factor@example.test"})
	connection, err := stack.Cluster.ConnectSuperuser(t.Context(), stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), insertFactor, user.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	cfg := configOver()
	cfg.MfaKeys = fixtureKeyRing(t)
	running, err := boot(t.Context(), cfg, quietLogger(), stepsOver(stack))
	if err != nil {
		t.Fatalf("%v: %s", err, test.Redact(err))
	}
	running.release()
	if err := running.listener.Close(); err != nil {
		t.Error(err)
	}
}

// The boot as the product has it, but for the database and the listener: discovery at a real TLS server, the
// provider it gave answering at the route, and the hop of the configuration choosing the client of the limiter.
func TestTheProductStepsServeASignInBehindTheConfiguredHop(t *testing.T) {
	stack := test.NewDatabase(t)
	calls := &recorder{}
	server := discoveryServer(t, calls, http.StatusOK)
	connection, err := stack.Cluster.ConnectSuperuser(t.Context(), stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), "DELETE FROM oidc_provider WHERE issuer=$1", test.FixtureIssuer); err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := connection.Exec(t.Context(), `INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)`, server.URL); err != nil {
		t.Fatal(test.Redact(err))
	}
	using := stepsOver(stack)
	using.providers = productSteps(server.Client()).providers
	cfg := configOver()
	cfg.TrustProxy = 1
	cfg.OidcProviders = []config.ProductOidcProviderConfig{{
		Issuer: server.URL, ClientID: "client", RedirectURI: httpTestOrigin + "/api/auth/oidc/callback", Version: "1",
	}}
	running, err := boot(t.Context(), cfg, quietLogger(), using)
	if err != nil {
		t.Fatalf("%v: %s", err, test.Redact(err))
	}
	t.Cleanup(func() {
		running.release()
		if err := running.listener.Close(); err != nil {
			t.Error(err)
		}
	})
	if !slices.Contains(calls.list(), "discovery") {
		t.Errorf("no discovery: %v", calls.list())
	}
	token := httpapi.NewCSRF()
	begin := func(address string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/auth/oidc/begin", strings.NewReader(`{"issuer":"`+server.URL+`"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", httpTestOrigin)
		request.Header.Set("X-Csrf-Token", token)
		request.Header.Set("Cookie", "authz_csrf="+token)
		request.Header.Set("X-Forwarded-For", address)
		recorder := httptest.NewRecorder()
		running.server.Handler.ServeHTTP(recorder, request)
		return recorder
	}
	for n := range 21 {
		answer := begin("198.51.100." + strconv.Itoa(n+1))
		if answer.Code != http.StatusOK || !strings.Contains(answer.Body.String(), server.URL+"/authorize?") {
			t.Fatalf("client %d: %d %s", n, answer.Code, answer.Body)
		}
	}
	for n := range 20 {
		if answer := begin("203.0.113.5"); answer.Code != http.StatusOK {
			t.Fatalf("attempt %d of one client: %d %s", n, answer.Code, answer.Body)
		}
	}
	if answer := begin("203.0.113.5"); answer.Code != http.StatusUnauthorized {
		t.Errorf("the client's 21st begin: %d %s", answer.Code, answer.Body)
	}
}

func TestAStoredFactorUnderAKeyTheRingLacksStopsTheBoot(t *testing.T) {
	stack := test.NewDatabase(t)
	user := fixture.Account(t, stack, fixture.AccountSpec{Email: "factor@example.test"})
	connection, err := stack.Cluster.ConnectSuperuser(t.Context(), stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), insertFactor, user.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	using := stepsOver(stack)
	listened := false
	using.listen = func(context.Context, int) (net.Listener, error) {
		listened = true
		return nil, errors.New("the boot listened")
	}
	_, err = boot(t.Context(), configOver(), quietLogger(), using)
	step, ok := errors.AsType[*BootError](err)
	if !ok || step.Step != "key coverage" || !errors.Is(err, authentication.ErrKeyCoverage) {
		t.Fatalf("%v", err)
	}
	if listened {
		t.Error("listened after a failed key coverage")
	}
}
