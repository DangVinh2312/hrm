//go:build integration

package app_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"hrm/api-go/internal/app"
	"hrm/api-go/internal/config"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

const (
	bootAttempts = 5
	statusWait   = time.Minute
)

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

// fixtureIssuer answers the discovery of Run over TLS, at its own address.
func fixtureIssuer(t *testing.T) *httptest.Server {
	t.Helper()
	var issuer string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write([]byte(`{"issuer":"` + issuer + `","authorization_endpoint":"` + issuer + `/authorize","token_endpoint":"` + issuer + `/token","jwks_uri":"` + issuer + `/jwks"}`)); err != nil {
			t.Error(err)
		}
	}))
	issuer = server.URL
	t.Cleanup(server.Close)
	return server
}

func configOf(t *testing.T, stack *test.Stack, issuer string, port int, upstream string) config.Config {
	t.Helper()
	cfg, err := config.Load(map[string]string{
		"NODE_ENV":                       "test",
		"PORT":                           strconv.Itoa(port),
		"APP_ORIGIN":                     "http://localhost:3000",
		"OIDC_PROVIDERS_JSON":            `[{"issuer":"` + issuer + `","clientId":"fixture-client","redirectUri":"http://localhost:3000/api/auth/oidc/callback","version":"1","assuranceMappings":[]}]`,
		"MFA_ENCRYPTION_KEYS":            "fixture:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
		"MFA_ENCRYPTION_KEY_ID":          "fixture",
		"PRODUCT_DATA_DATABASE_URL":      stack.LoginURL("data"),
		"PRODUCT_IDENTITY_DATABASE_URL":  stack.LoginURL("identity"),
		"PRODUCT_AUTHORITY_DATABASE_URL": stack.LoginURL("authority"),
		"PRODUCT_SYNC_DATABASE_URL":      stack.LoginURL("sync"),
		"API_UPSTREAM_URL":               upstream,
	})
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

// runThroughSlowPools runs the boot and tries again when the logins got no answer in the 2 s each has: on
// a loaded machine that happens before anything this file tests. Every other failure stays as it is.
func runThroughSlowPools(ctx context.Context, cfg config.Config, client *http.Client) error {
	for attempt := 1; ; attempt++ {
		err := app.RunWithClient(ctx, cfg, slog.New(slog.DiscardHandler), client)
		step, boot := errors.AsType[*app.BootError](err)
		if !boot || step.Step != "pools" || !test.DidNotAnswer(err) || attempt == bootAttempts {
			return err
		}
		fmt.Fprintf(os.Stderr, "boot attempt %d: %s\n", attempt, test.Redact(err))
	}
}

// waitStatus polls until the time is up or the boot ended, which is then the reason it never answered.
func waitStatus(ctx context.Context, finished <-chan error, url string, want int) error {
	var last int
	deadline := time.Now().Add(statusWait)
	for time.Now().Before(deadline) {
		select {
		case err := <-finished:
			return fmt.Errorf("the server stopped: %v", err)
		default:
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
		if err != nil {
			return err
		}
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			last = response.StatusCode
			if err := response.Body.Close(); err != nil {
				return err
			}
			if last == want {
				return nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("status %d, want %d", last, want)
}

func TestRunServesAfterTheRealPrivilegeProbe(t *testing.T) {
	stack := test.NewDatabase(t)
	var upstreamStatus atomic.Int64
	upstreamStatus.Store(http.StatusServiceUnavailable)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(upstreamStatus.Load()))
	}))
	defer upstream.Close()
	port := freePort(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan error, 1)
	issuer := fixtureIssuer(t)
	cfg := configOf(t, stack, issuer.URL, port, upstream.URL)
	go func() { finished <- runThroughSlowPools(ctx, cfg, issuer.Client()) }()
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	if err := waitStatus(ctx, finished, base+"/api/health/live", 200); err != nil {
		t.Fatal(err)
	}
	if err := waitStatus(ctx, finished, base+"/api/health/ready", 503); err != nil {
		t.Fatalf("upstream not ready: %v", err)
	}
	upstreamStatus.Store(http.StatusOK)
	if err := waitStatus(ctx, finished, base+"/api/health/ready", 200); err != nil {
		t.Fatalf("upstream ready: %v", err)
	}
	cancel()
	if err := <-finished; err != nil {
		t.Errorf("shutdown: %v", err)
	}
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second); err == nil {
		t.Error("still listening after shutdown")
	}
}

func TestAPrivilegeDriftStopsTheBoot(t *testing.T) {
	stack := test.NewDatabase(t)
	connection, err := stack.Cluster.ConnectSuperuser(t.Context(), stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), "GRANT DELETE ON app_user TO product_data"); err != nil {
		t.Fatal(test.Redact(err))
	}
	port := freePort(t)
	issuer := fixtureIssuer(t)
	err = runThroughSlowPools(t.Context(), configOf(t, stack, issuer.URL, port, "http://127.0.0.1:1"), issuer.Client())
	step, boot := errors.AsType[*app.BootError](err)
	drift, drifted := errors.AsType[*database.PrivilegeDriftError](err)
	if !boot || step.Step != "privileges" || !drifted || drift.Purpose != database.PurposeData || len(drift.Unexpected) == 0 {
		t.Fatalf("%v, %s", err, test.Redact(err))
	}
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second); err == nil {
		t.Error("listening after a failed boot")
	}
}
