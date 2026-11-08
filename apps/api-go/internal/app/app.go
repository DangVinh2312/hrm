// Package app is the composition root: the order of the boot, and who owns what until shutdown.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"hrm/api-go/contract"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/config"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/health"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/openapi"
)

const (
	shutdownTimeout = 10 * time.Second
	// pool.Close waits for connections pgx is still cancelling in the background, up to 15 s each. They
	// hold no work of this process by then, and exiting drops the sockets, so the wait is bounded.
	poolCloseTimeout = 5 * time.Second
)

// BootError names the step that failed; its text is safe to print. The cause is kept for errors.Is and
// is not, except an httpapi.InventoryError, which names only routes.
type BootError struct {
	Step string
	Err  error
}

func (e *BootError) Error() string {
	if inventory, ok := errors.AsType[*httpapi.InventoryError](e.Err); ok {
		return "boot step failed: " + inventory.Error()
	}
	return "boot step failed: " + e.Step
}

func (e *BootError) Unwrap() error { return e.Err }

// ShutdownError means the server did not stop cleanly after the signal; its text is safe to print, the
// cause is kept for errors.Is and is not.
type ShutdownError struct {
	Err error
}

func (e *ShutdownError) Error() string { return "shutdown failed" }

func (e *ShutdownError) Unwrap() error { return e.Err }

var (
	errUpstreamRequired = errors.New("API_UPSTREAM_URL is required while routes are proxied")
	errUpstreamRefused  = errors.New("API_UPSTREAM_URL must be absent when every route is migrated")
)

// steps are what the boot reaches outside the process.
type steps struct {
	routes     string
	privileges string
	openPools  func(ctx context.Context, urls map[database.Purpose]string, mode database.TLSMode) (database.Pools, error)
	closePools func(database.Pools)
	verify     func(ctx context.Context, pools database.Pools, expected map[database.Purpose][]string) error
	listen     func(ctx context.Context, port int) (net.Listener, error)
	// providers runs the discovery of every configured IdP.
	providers func(ctx context.Context, settings []config.ProductOidcProviderConfig) ([]*authentication.OidcProvider, error)
	// keyCoverage is the check that every stored second factor has its key in the ring.
	keyCoverage func(ctx context.Context, mfa *authentication.MfaService) error
	// register adds the routes this process serves itself.
	register func(engine *gin.Engine, group *httpapi.Group, gate *health.Gate, upstream health.Upstream, auth authentication.Routes) error
}

// productSteps takes the client that reaches the IdPs, which carries the trust roots of the process.
func productSteps(oidcClient *http.Client) steps {
	return steps{
		routes:     contract.Routes(),
		privileges: contract.Privileges(),
		openPools:  database.OpenPools,
		closePools: database.Pools.Close,
		verify:     database.VerifyPrivileges,
		listen: func(ctx context.Context, port int) (net.Listener, error) {
			return (&net.ListenConfig{}).Listen(ctx, "tcp", ":"+strconv.Itoa(port))
		},
		providers: discover(oidcClient),
		keyCoverage: func(ctx context.Context, mfa *authentication.MfaService) error {
			return mfa.VerifyKeyCoverage(ctx)
		},
		register: registerMigrated,
	}
}

func registerMigrated(_ *gin.Engine, group *httpapi.Group, gate *health.Gate, upstream health.Upstream, auth authentication.Routes) error {
	if err := health.Register(group, gate, upstream); err != nil {
		return err
	}
	if err := httpapi.RegisterAuth(group, auth.Origin); err != nil {
		return err
	}
	if err := auth.Register(group); err != nil {
		return err
	}
	return openapi.Register(group, contract.OpenAPI())
}

// discover runs before any transaction of the boot, one bounded round per provider in the order configured:
// an IdP that does not answer stops the boot rather than the first sign-in.
func discover(client *http.Client) func(context.Context, []config.ProductOidcProviderConfig) ([]*authentication.OidcProvider, error) {
	return func(ctx context.Context, settings []config.ProductOidcProviderConfig) ([]*authentication.OidcProvider, error) {
		providers := make([]*authentication.OidcProvider, 0, len(settings))
		for _, setting := range settings {
			provider, err := authentication.NewOidcProvider(ctx, setting, client)
			if err != nil {
				return nil, err
			}
			providers = append(providers, provider)
		}
		return providers, nil
	}
}

// authRoutes composes the services of auth/*; cfg.Origin is the one source of the origin they and the
// RequestAuth of the group use.
func (a *application) authRoutes(ctx context.Context, cfg config.Config) (authentication.Routes, error) {
	runner, err := database.NewRunner(a.pools, database.RunnerOptions{})
	if err != nil {
		return authentication.Routes{}, &BootError{"runner", err}
	}
	providers, err := a.steps.providers(ctx, cfg.OidcProviders)
	if err != nil {
		return authentication.Routes{}, &BootError{"oidc providers", err}
	}
	identity := authentication.NewService(runner)
	oidc, err := authentication.NewOidcService(identity, providers)
	if err != nil {
		return authentication.Routes{}, &BootError{"oidc providers", err}
	}
	return authentication.Routes{
		Identity: identity, Mfa: authentication.NewMfaService(identity, cfg.MfaKeys), Oidc: oidc,
		Origin: cfg.Origin, TrustProxy: cfg.TrustProxy,
	}, nil
}

type application struct {
	server   *http.Server
	listener net.Listener
	upstream *httpapi.Upstream
	pools    database.Pools
	steps    steps
	logger   *slog.Logger

	shutdownTimeout  time.Duration
	poolCloseTimeout time.Duration
}

// Run boots, serves until ctx ends, and shuts down.
func Run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	return run(ctx, cfg, logger, &http.Client{})
}

func run(ctx context.Context, cfg config.Config, logger *slog.Logger, oidcClient *http.Client) error {
	running, err := boot(ctx, cfg, logger, productSteps(oidcClient))
	if err != nil {
		return err
	}
	return running.serve(ctx)
}

// boot follows ProductRuntime and main.ts: pools, discovery, route inventory, privileges, key coverage,
// ready, listen. Nothing listens unless every step passed; a later plan task adds the steps NestJS has and
// this does not, and until then the readiness of the upstream covers them.
func boot(ctx context.Context, cfg config.Config, logger *slog.Logger, using steps) (*application, error) {
	gin.SetMode(gin.ReleaseMode)
	contractRoutes, err := httpapi.ParseContractRoutes(using.routes)
	if err != nil {
		return nil, &BootError{"route inventory", err}
	}
	upstream, err := newUpstream(cfg, logger, len(contractRoutes), len(httpapi.MigratedRoutes))
	if err != nil {
		return nil, &BootError{"upstream", err}
	}
	var expected struct {
		Application map[database.Purpose][]string `json:"applicationPrivileges"`
	}
	if err := json.Unmarshal([]byte(using.privileges), &expected); err != nil {
		return nil, &BootError{"privileges", err}
	}
	pools, err := using.openPools(ctx, map[database.Purpose]string{
		database.PurposeData:      cfg.Databases.Data,
		database.PurposeIdentity:  cfg.Databases.Identity,
		database.PurposeAuthority: cfg.Databases.Authority,
		database.PurposeSync:      cfg.Databases.Sync,
	}, database.TLSForEnvironment(cfg.NodeEnv))
	if err != nil {
		return nil, &BootError{"pools", err}
	}
	running := &application{
		upstream: upstream, pools: pools, steps: using, logger: logger,
		shutdownTimeout: shutdownTimeout, poolCloseTimeout: poolCloseTimeout,
	}
	if err := running.start(ctx, cfg, contractRoutes, expected.Application); err != nil {
		running.release()
		return nil, err
	}
	return running, nil
}

func newUpstream(cfg config.Config, logger *slog.Logger, total, migrated int) (*httpapi.Upstream, error) {
	if migrated >= total {
		if cfg.UpstreamURL != "" {
			return nil, errUpstreamRefused
		}
		return nil, nil
	}
	if cfg.UpstreamURL == "" {
		return nil, errUpstreamRequired
	}
	return httpapi.NewUpstream(cfg.UpstreamURL, cfg.TrustProxy, logger)
}

func (a *application) start(ctx context.Context, cfg config.Config, contractRoutes []httpapi.ContractRoute, expected map[database.Purpose][]string) error {
	gate := &health.Gate{}
	auth, err := a.authRoutes(ctx, cfg)
	if err != nil {
		return err
	}
	engine, err := a.routes(contractRoutes, gate, auth)
	if err != nil {
		return &BootError{"route inventory", err}
	}
	if err := a.steps.verify(ctx, a.pools, expected); err != nil {
		return &BootError{"privileges", err}
	}
	if err := a.steps.keyCoverage(ctx, auth.Mfa); err != nil {
		return &BootError{"key coverage", err}
	}
	gate.MarkReady()
	listener, err := a.steps.listen(ctx, cfg.Port)
	if err != nil {
		return &BootError{"listen", err}
	}
	a.listener = listener
	a.server = httpapi.NewServer(httpapi.NewHandler(engine), cfg.Port)
	return nil
}

func (a *application) routes(contractRoutes []httpapi.ContractRoute, gate *health.Gate, auth authentication.Routes) (*gin.Engine, error) {
	engine := httpapi.NewEngine(a.logger)
	group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: auth.Origin})
	var ready health.Upstream
	if a.upstream != nil {
		ready = a.upstream
	}
	if err := a.steps.register(engine, group, gate, ready, auth); err != nil {
		return nil, err
	}
	served := map[httpapi.Route]bool{}
	for _, route := range group.Routes() {
		served[route.Route] = true
	}
	for _, route := range contractRoutes {
		if served[route.Route] || a.upstream == nil {
			continue
		}
		if err := httpapi.RegisterProxied(group, route.Route, a.upstream); err != nil {
			return nil, fmt.Errorf("proxy %s: %w", route.Route, err)
		}
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		return nil, err
	}
	if err := httpapi.CheckInventory(group.Routes(), contractRoutes); err != nil {
		return nil, err
	}
	return engine, nil
}

// serve owns the server until it stops, then shuts down in the order that leaves nothing using what
// goes next: no new request, requests in flight finished, then the upstream and the pools.
func (a *application) serve(ctx context.Context) error {
	stopped := make(chan error, 1)
	go func() { stopped <- a.server.Serve(a.listener) }()
	var failure error
	select {
	case err := <-stopped:
		failure = &BootError{"serve", err}
	case <-ctx.Done():
		failure = a.stopServer(ctx, stopped)
	}
	a.release()
	return failure
}

func (a *application) stopServer(ctx context.Context, stopped <-chan error) error {
	deadline, cancel := context.WithTimeout(context.WithoutCancel(ctx), a.shutdownTimeout)
	defer cancel()
	err := a.server.Shutdown(deadline)
	if err != nil {
		a.logger.Error("shutdown cut requests in flight")
		err = errors.Join(err, a.server.Close())
	}
	if served := <-stopped; !errors.Is(served, http.ErrServerClosed) {
		err = errors.Join(err, served)
	}
	if err != nil {
		return &ShutdownError{err}
	}
	return nil
}

// release runs once, on a failed boot or after the server stopped.
func (a *application) release() {
	if a.upstream != nil {
		a.upstream.Close()
	}
	closed := make(chan struct{})
	go func() {
		a.steps.closePools(a.pools)
		close(closed)
	}()
	wait := time.NewTimer(a.poolCloseTimeout)
	defer wait.Stop()
	select {
	case <-closed:
	case <-wait.C:
		a.logger.Warn("database pools still closing at exit")
	}
}
