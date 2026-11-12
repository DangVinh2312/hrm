//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"testing"
	"time"

	"hrm/api/internal/app"
	"hrm/api/internal/config"
	"hrm/api/internal/database"
	"hrm/api/internal/httpapi"
	"hrm/api/test"
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

func configOf(t *testing.T, stack *test.Stack, issuer string, port int) config.Config {
	t.Helper()
	connection, err := stack.Cluster.ConnectSuperuser(t.Context(), stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	_, deleteErr := connection.Exec(t.Context(), "DELETE FROM oidc_provider WHERE issuer=$1", test.FixtureIssuer)
	closeErr := connection.Close(context.WithoutCancel(t.Context()))
	if deleteErr != nil || closeErr != nil {
		t.Fatal(test.Redact(errors.Join(deleteErr, closeErr)))
	}
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

type metricRow struct {
	Metric  string `json:"metric"`
	Mode    string `json:"mode"`
	Count   int64  `json:"count"`
	Buckets []struct {
		Count int64 `json:"count"`
	} `json:"buckets"`
}

// get answers the status and the body of one request with an optional cookie.
func get(ctx context.Context, t *testing.T, url, cookie string) (int, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if err := errors.Join(err, response.Body.Close()); err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, body
}

func TestRunServesEveryRouteWithoutAnUpstream(t *testing.T) {
	stack := test.NewDatabase(t)
	port := freePort(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan error, 1)
	issuer := fixtureIssuer(t)
	cfg := configOf(t, stack, issuer.URL, port)
	go func() { finished <- runThroughSlowPools(ctx, cfg, issuer.Client()) }()
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	if err := waitStatus(ctx, finished, base+"/api/health/ready", 200); err != nil {
		t.Fatal(err)
	}
	// A well-formed session nobody holds still resolves in a read transaction of the runner.
	if status, body := get(ctx, t, base+"/api/administration/roles", "authz_session="+httpapi.NewCSRF()); status != http.StatusUnauthorized {
		t.Fatalf("%d %s", status, body)
	}
	status, body := get(ctx, t, base+"/api/health/metrics", "")
	var rows []metricRow
	if err := json.Unmarshal(body, &rows); status != http.StatusOK || err != nil {
		t.Fatalf("%d %s %v", status, body, err)
	}
	read := slices.IndexFunc(rows, func(row metricRow) bool { return row.Metric == "transaction" && row.Mode == "read" })
	if read < 0 || rows[read].Count < 1 || len(rows[read].Buckets) != 11 || rows[read].Buckets[10].Count > rows[read].Count {
		t.Errorf("%s", body)
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
	err = runThroughSlowPools(t.Context(), configOf(t, stack, issuer.URL, port), issuer.Client())
	step, boot := errors.AsType[*app.BootError](err)
	drift, drifted := errors.AsType[*database.PrivilegeDriftError](err)
	if !boot || step.Step != "privileges" || !drifted || drift.Purpose != database.PurposeData || len(drift.Unexpected) == 0 {
		t.Fatalf("%v, %s", err, test.Redact(err))
	}
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second); err == nil {
		t.Error("listening after a failed boot")
	}
}
