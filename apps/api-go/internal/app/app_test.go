package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"hrm/api-go/contract"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/config"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/health"
	"hrm/api-go/internal/httpapi"
)

type recorder struct {
	mutex sync.Mutex
	calls []string
}

func (r *recorder) add(call string) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.calls = append(r.calls, call)
}

func (r *recorder) list() []string {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	return slices.Clone(r.calls)
}

// testSteps boots against the real contract with no database and a listener on a free port.
func testSteps(t *testing.T, calls *recorder) steps {
	t.Helper()
	using := productSteps(&http.Client{})
	for _, checks := range [][]bootStep{using.afterPrivileges, using.afterKeys} {
		for index := range checks {
			name := checks[index].name
			checks[index].run = func(context.Context, config.Config, database.Pools) error { calls.add(name); return nil }
		}
	}
	using.openPools = func(context.Context, map[database.Purpose]string, database.TLSMode) (database.Pools, error) {
		calls.add("pools")
		return database.Pools{}, nil
	}
	using.closePools = func(database.Pools) { calls.add("close pools") }
	using.verify = func(context.Context, database.Pools, map[database.Purpose][]string) error {
		calls.add("verify")
		return nil
	}
	using.listen = func(ctx context.Context, _ int) (net.Listener, error) {
		calls.add("listen")
		return (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
	}
	using.providers = func(context.Context, []config.ProductOidcProviderConfig) ([]*authentication.OidcProvider, error) {
		calls.add("providers")
		return nil, nil
	}
	using.keyCoverage = func(context.Context, *authentication.MfaService) error {
		calls.add("key coverage")
		return nil
	}
	return using
}

func testConfig() config.Config {
	return config.Config{NodeEnv: "test"}
}

func quietLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

func TestBootOrderEndsInListen(t *testing.T) {
	calls := &recorder{}
	running, err := boot(t.Context(), testConfig(), quietLogger(), testSteps(t, calls))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"pools", "providers", "verify", "permission protection", "key coverage", "manifest", "oidc provider sync", "company anchor", "work calendar anchor", "setting anchor", "role anchor", "domain schema", "work calendar schema", "setting schema", "listen"}; !slices.Equal(calls.list(), want) {
		t.Errorf("%v", calls.list())
	}
	if gin.Mode() != gin.ReleaseMode {
		t.Errorf("gin mode %s", gin.Mode())
	}
	running.release()
	if err := running.listener.Close(); err != nil {
		t.Error(err)
	}
}

func TestAFailedStepNeverListens(t *testing.T) {
	boom := errors.New("CANARY driver text")
	withOut := func(path string) string {
		routes, err := httpapi.ParseContractRoutes(contract.Routes())
		if err != nil {
			t.Fatal(err)
		}
		var kept []string
		for _, route := range routes {
			if route.Path != path {
				kept = append(kept, `{"method":"`+route.Method+`","path":"`+route.Path+`","classification":{"kind":"public"}}`)
			}
		}
		return "[" + strings.Join(kept, ",") + "]"
	}
	cases := map[string]struct {
		change func(*steps, *recorder)
		step   string
		calls  []string
	}{
		"pools": {func(s *steps, _ *recorder) {
			s.openPools = func(context.Context, map[database.Purpose]string, database.TLSMode) (database.Pools, error) {
				return nil, boom
			}
		}, "pools", nil},
		"a migrated route the contract lost": {func(s *steps, _ *recorder) {
			s.routes = withOut("/api/health/live")
		}, "route inventory", []string{"pools", "providers", "close pools"}},
		"a route outside Register": {func(s *steps, _ *recorder) {
			s.register = func(engine *gin.Engine, group *httpapi.Group, gate *health.Gate, auth authentication.Routes, mods modules) error {
				engine.GET("/api/raw", func(*gin.Context) {})
				return registerMigrated(engine, group, gate, auth, mods)
			}
		}, "route inventory", []string{"pools", "providers", "close pools"}},
		"a route the migrated table does not list": {func(s *steps, _ *recorder) {
			s.register = func(engine *gin.Engine, group *httpapi.Group, gate *health.Gate, auth authentication.Routes, mods modules) error {
				if err := httpapi.Register(group, http.MethodGet, "/api/health/unlisted", enforcement.Public(), func(*gin.Context) {}); err != nil {
					return err
				}
				return registerMigrated(engine, group, gate, auth, mods)
			}
		}, "route inventory", []string{"pools", "providers", "close pools"}},
		"a migrated route that is not registered": {func(s *steps, _ *recorder) {
			s.register = func(*gin.Engine, *httpapi.Group, *health.Gate, authentication.Routes, modules) error {
				return nil
			}
		}, "route inventory", []string{"pools", "providers", "close pools"}},
		"a contract route nothing serves": {func(s *steps, _ *recorder) {
			s.routes = strings.TrimSuffix(strings.TrimSpace(contract.Routes()), "]") + `,{"method":"GET","path":"/api/health/unserved","classification":{"kind":"public"}}]`
		}, "route inventory", []string{"pools", "providers", "close pools"}},
		"providers": {func(s *steps, calls *recorder) {
			s.providers = func(context.Context, []config.ProductOidcProviderConfig) ([]*authentication.OidcProvider, error) {
				calls.add("providers")
				return nil, boom
			}
		}, "oidc providers", []string{"pools", "providers", "close pools"}},
		"privileges": {func(s *steps, calls *recorder) {
			s.verify = func(context.Context, database.Pools, map[database.Purpose][]string) error {
				calls.add("verify")
				return boom
			}
		}, "privileges", []string{"pools", "providers", "verify", "close pools"}},
		"key coverage": {func(s *steps, calls *recorder) {
			s.keyCoverage = func(context.Context, *authentication.MfaService) error {
				calls.add("key coverage")
				return boom
			}
		}, "key coverage", []string{"pools", "providers", "verify", "permission protection", "key coverage", "close pools"}},
		"listen": {func(s *steps, calls *recorder) {
			s.listen = func(context.Context, int) (net.Listener, error) {
				calls.add("listen")
				return nil, boom
			}
		}, "listen", []string{"pools", "providers", "verify", "permission protection", "key coverage", "manifest", "oidc provider sync", "company anchor", "work calendar anchor", "setting anchor", "role anchor", "domain schema", "work calendar schema", "setting schema", "listen", "close pools"}},
		"a route the contract repeats": {func(s *steps, _ *recorder) {
			s.routes = strings.TrimSuffix(withOut(""), "]") + `,{"method":"GET","path":"/api/health/live","classification":{"kind":"public"}}]`
		}, "route inventory", nil},
		"broken contract":   {func(s *steps, _ *recorder) { s.routes = "{" }, "route inventory", nil},
		"broken privileges": {func(s *steps, _ *recorder) { s.privileges = "{" }, "privileges", nil},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			calls := &recorder{}
			using := testSteps(t, calls)
			c.change(&using, calls)
			_, err := boot(t.Context(), testConfig(), quietLogger(), using)
			step, ok := errors.AsType[*BootError](err)
			if !ok || step.Step != c.step {
				t.Fatalf("%v", err)
			}
			if strings.Contains(step.Error(), "CANARY") {
				t.Errorf("%s", step)
			}
			if _, inventory := errors.AsType[*httpapi.InventoryError](err); inventory && !strings.Contains(step.Error(), " GET /api/") {
				t.Errorf("the routes are not named: %s", step)
			}
			if !slices.Equal(calls.list(), c.calls) {
				t.Errorf("%v, want %v", calls.list(), c.calls)
			}
		})
	}
}

func listeningAddress(t *testing.T, running *application) string {
	t.Helper()
	return running.listener.Addr().String()
}

func rawExchange(t *testing.T, address, request string) string {
	t.Helper()
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(connection)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func TestTheBootedServerHasEveryLayer(t *testing.T) {
	calls := &recorder{}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	running, err := boot(ctx, testConfig(), quietLogger(), testSteps(t, calls))
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- running.serve(ctx) }()
	address := listeningAddress(t, running)
	for _, c := range []struct{ request, want string }{
		{"GET /api/health/live HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `200 OK`},
		{"GET /api/health/ready HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `200 OK`},
		{"GET /api/openapi.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `200 OK`},
		{"GET /api/%ZZ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `400 Bad Request`},
		{"GET /api/%FF HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `"code":"error.invalidRequest"`},
		{"GET /api/missing HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `"code":"error.notFound"`},
		{"GET /api/auth/csrf HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `"csrfToken":"`},
		{"GET /api/auth/options HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", `{"methods":["oidc"]}`},
		{"GET /api/health/metrics HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", "\r\n\r\n[]"},
	} {
		if answer := rawExchange(t, address, c.request); !strings.Contains(answer, c.want) {
			t.Errorf("%q: %q", c.request, answer)
		}
	}
	cancel()
	if err := <-finished; err != nil {
		t.Errorf("shutdown: %v", err)
	}
}

// A request in flight when the signal comes ends before anything it could use goes away.
func TestShutdownFinishesRequestsBeforeThePools(t *testing.T) {
	calls := &recorder{}
	using := testSteps(t, calls)
	started, release := make(chan struct{}), make(chan struct{})
	using.routes = `[{"method":"GET","path":"/api/health/live","classification":{"kind":"public"}},` +
		`{"method":"GET","path":"/api/health/ready","classification":{"kind":"public"}},` +
		`{"method":"GET","path":"/api/health/metrics","classification":{"kind":"public"}},` +
		`{"method":"GET","path":"/api/openapi.json","classification":{"kind":"public"}}]`
	using.register = func(_ *gin.Engine, group *httpapi.Group, gate *health.Gate, _ authentication.Routes, _ modules) error {
		if err := httpapi.Register(group, http.MethodGet, "/api/openapi.json", enforcement.Public(), func(c *gin.Context) {
			close(started)
			<-release
			calls.add("request finished")
			httpapi.WriteJSONBytes(c, http.StatusOK, []byte(`{}`))
		}); err != nil {
			return err
		}
		return health.Register(group, gate, &health.Metrics{})
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	running, err := boot(ctx, testConfig(), quietLogger(), using)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- running.serve(ctx) }()
	answer := make(chan string, 1)
	go func() {
		answer <- rawExchange(t, listeningAddress(t, running), "GET /api/openapi.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	}()
	<-started
	cancel()
	time.Sleep(50 * time.Millisecond)
	if slices.Contains(calls.list(), "close pools") {
		t.Error("pools closed under a request")
	}
	close(release)
	if got := <-answer; !strings.Contains(got, "200 OK") {
		t.Errorf("%q", got)
	}
	if err := <-finished; err != nil {
		t.Error(err)
	}
	list := calls.list()
	if slices.Index(list, "request finished") > slices.Index(list, "close pools") || !slices.Contains(list, "close pools") {
		t.Errorf("%v", list)
	}
}

func TestAStuckRequestDoesNotHoldShutdown(t *testing.T) {
	calls := &recorder{}
	using := testSteps(t, calls)
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	using.routes = `[{"method":"GET","path":"/api/health/live","classification":{"kind":"public"}},` +
		`{"method":"GET","path":"/api/health/ready","classification":{"kind":"public"}},` +
		`{"method":"GET","path":"/api/health/metrics","classification":{"kind":"public"}},` +
		`{"method":"GET","path":"/api/openapi.json","classification":{"kind":"public"}}]`
	using.register = func(_ *gin.Engine, group *httpapi.Group, gate *health.Gate, _ authentication.Routes, _ modules) error {
		if err := httpapi.Register(group, http.MethodGet, "/api/openapi.json", enforcement.Public(), func(*gin.Context) {
			close(started)
			<-release
		}); err != nil {
			return err
		}
		return health.Register(group, gate, &health.Metrics{})
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	running, err := boot(ctx, testConfig(), quietLogger(), using)
	if err != nil {
		t.Fatal(err)
	}
	running.shutdownTimeout = 50 * time.Millisecond
	finished := make(chan error, 1)
	go func() { finished <- running.serve(ctx) }()
	connection, err := net.Dial("tcp", listeningAddress(t, running))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := connection.Write([]byte("GET /api/openapi.json HTTP/1.1\r\nHost: x\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	<-started
	cancel()
	select {
	case err := <-finished:
		if _, shutdown := errors.AsType[*ShutdownError](err); !shutdown || !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown waited for a stuck request")
	}
	if !slices.Contains(calls.list(), "close pools") {
		t.Error("pools not closed")
	}
	if err := connection.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(connection); errors.Is(err, os.ErrDeadlineExceeded) {
		t.Error("the stuck connection stayed open")
	}
}

func TestSlowPoolsDoNotHoldExit(t *testing.T) {
	calls := &recorder{}
	using := testSteps(t, calls)
	released := make(chan struct{})
	defer close(released)
	using.closePools = func(database.Pools) { <-released }
	running, err := boot(t.Context(), testConfig(), quietLogger(), using)
	if err != nil {
		t.Fatal(err)
	}
	running.poolCloseTimeout = 20 * time.Millisecond
	done := make(chan struct{})
	go func() {
		running.release()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("release waited for the pools")
	}
	if err := running.listener.Close(); err != nil {
		t.Error(err)
	}
}

func TestPortIsPassedToListen(t *testing.T) {
	calls := &recorder{}
	using := testSteps(t, calls)
	var port string
	inner := using.listen
	using.listen = func(ctx context.Context, requested int) (net.Listener, error) {
		port = strconv.Itoa(requested)
		return inner(ctx, requested)
	}
	cfg := testConfig()
	cfg.Port = 4321
	running, err := boot(t.Context(), cfg, quietLogger(), using)
	if err != nil {
		t.Fatal(err)
	}
	running.release()
	if err := running.listener.Close(); err != nil {
		t.Error(err)
	}
	if port != "4321" {
		t.Errorf("%s", port)
	}
}

func TestNewAccountsEnrollOnlyAtTheOneProvider(t *testing.T) {
	one := config.ProductOidcProviderConfig{Issuer: "https://one.example.test"}
	two := config.ProductOidcProviderConfig{Issuer: "https://two.example.test"}
	for name, c := range map[string]struct {
		providers []config.ProductOidcProviderConfig
		want      string
	}{"none": {nil, ""}, "one": {[]config.ProductOidcProviderConfig{one}, one.Issuer}, "two": {[]config.ProductOidcProviderConfig{one, two}, ""}} {
		if got := provisioningIssuer(c.providers); got != c.want {
			t.Errorf("%s: %q", name, got)
		}
	}
}
