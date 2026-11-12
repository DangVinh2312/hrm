package test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/authorization/values"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/permission"
)

const (
	// FixtureIssuer is the enabled OIDC provider of the template; sessions and the Root bind to it.
	FixtureIssuer = "https://idp.fixture"

	// runnerCluster is the superuser URL of the cluster the integration runner shares between packages.
	runnerCluster = "HRM_TEST_POSTGRES_URL"

	templateDatabase = "tpl_fixture"
	templateBuilding = "tpl_fixture_building"
	buildTimeout     = 5 * time.Minute
	commandTimeout   = time.Minute
	databaseTimeout  = time.Minute
	poolRetryPause   = time.Second
	revokeTemp       = "DO $$BEGIN EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC',current_database()); END$$"
	insertProvider   = "INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true) ON CONFLICT (issuer) DO NOTHING"
)

var logins = []string{"data", "identity", "authority", "sync", "migration", "bootstrap", "outbox"}

var runtimePurposes = []database.Purpose{
	database.PurposeData, database.PurposeIdentity, database.PurposeAuthority,
	database.PurposeSync, database.PurposeBootstrap, database.PurposeOutbox,
}

// cluster is the one container of a test binary. Roles are cluster-wide and provisioning keeps the password
// of an existing role, so every database of the cluster uses the same synthetic passwords.
type cluster struct {
	postgres  *Postgres
	passwords map[string]string
	binary    string
	// clone serializes CREATE DATABASE … TEMPLATE, which fails while another session uses the template.
	clone sync.Mutex
}

var (
	sharedOnce    sync.Once
	sharedCluster *cluster
	errShared     error
)

// Stack is one database cloned from the template, with a pool per runtime login.
type Stack struct {
	Cluster  *Postgres
	Database string
	Pools    database.Pools
	Runner   *database.Runner
	shared   *cluster
}

// LoginURL is a connection URL of a product login on this database; never print it.
func (s *Stack) LoginURL(login string) string {
	return s.Cluster.LoginURL("product_"+login, s.shared.passwords[login], s.Database)
}

// Hrmctl runs a command of the hrmctl binary against this database. Its output carries no secret by
// contract of the command.
func (s *Stack) Hrmctl(ctx context.Context, command string, args ...string) (string, error) {
	return s.shared.hrmctl(ctx, s.Database, command, args...)
}

// Redact keeps the SQLSTATE, the code or the type of an error: driver messages can carry the URL or data.
func Redact(err error) string {
	var driver *pgconn.PgError
	if errors.As(err, &driver) {
		return "SQLSTATE " + driver.Code
	}
	var unavailable *database.UnavailableError
	if errors.As(err, &unavailable) {
		return fmt.Sprintf("%T %s", unavailable, unavailable.Code)
	}
	return fmt.Sprintf("%T", err)
}

// NewDatabase clones the template into a new database dropped when the test ends. The container and the
// template are built once per test binary; the testcontainers reaper removes the container at exit.
func NewDatabase(t testing.TB) *Stack {
	t.Helper()
	sharedOnce.Do(func() { sharedCluster, errShared = startCluster() })
	if errShared != nil {
		t.Fatalf("fixture cluster: %v", errShared)
	}
	c := sharedCluster
	name, err := RandomSecret()
	if err != nil {
		t.Fatal(err)
	}
	name = "t_" + name[:16]
	ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), databaseTimeout)
	defer cancel()
	if err := c.cloneTemplate(ctx, name); err != nil {
		t.Fatalf("clone the template: %s", Redact(err))
	}
	s := &Stack{Cluster: c.postgres, Database: name, shared: c}
	t.Cleanup(func() {
		if s.Pools != nil {
			s.Pools.Close()
		}
		drop, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), databaseTimeout)
		defer cancel()
		if err := c.superExec(drop, "postgres", `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop %s: %s", name, Redact(err))
		}
	})
	// The ACL of a database is not part of the template; this is the one database-level grant provisioning makes.
	if err := c.superExec(ctx, name, revokeTemp); err != nil {
		t.Fatalf("revoke TEMP: %s", Redact(err))
	}
	urls := map[database.Purpose]string{}
	for _, purpose := range runtimePurposes {
		urls[purpose] = s.LoginURL(string(purpose))
	}
	// Its own time: a clone on a starved cluster can take most of a minute, and the logins then wait longest.
	open, cancelOpen := context.WithTimeout(context.WithoutCancel(t.Context()), databaseTimeout)
	defer cancelOpen()
	if s.Pools, err = openPools(open, t, urls); err != nil {
		t.Fatalf("open pools: %v", err)
	}
	if s.Runner, err = database.NewRunner(s.Pools, database.RunnerOptions{}); err != nil {
		t.Fatal(err)
	}
	return s
}

// DidNotAnswer says a login got no answer in time, or no connection, and PostgreSQL refused nothing. On a
// loaded machine the 2 s each login gets can run out, so a test may try again; a SQLSTATE is a real answer.
func DidNotAnswer(err error) bool {
	var unavailable *database.UnavailableError
	return errors.As(err, &unavailable) && (unavailable.Code == "deadline" || unavailable.Code == "connection")
}

// openPools waits for the cluster until ctx ends, with the time and the last code in the error.
func openPools(ctx context.Context, t testing.TB, urls map[database.Purpose]string) (database.Pools, error) {
	started := time.Now()
	for attempt := 1; ; attempt++ {
		pools, err := database.OpenPools(ctx, urls, database.TLSDisabled)
		if err == nil {
			return pools, nil
		}
		t.Logf("open pools: attempt %d after %s: %s", attempt, time.Since(started).Round(time.Millisecond), Redact(err))
		if !DidNotAnswer(err) || ctx.Err() != nil {
			return nil, fmt.Errorf("%d attempts in %s: %s", attempt, time.Since(started).Round(time.Millisecond), Redact(err))
		}
		select {
		case <-ctx.Done():
		case <-time.After(poolRetryPause):
		}
	}
}

func startCluster() (*cluster, error) {
	ctx, cancel := context.WithTimeout(context.Background(), buildTimeout)
	defer cancel()
	binary, err := buildHrmctl(ctx)
	if err != nil {
		return nil, err
	}
	c := &cluster{passwords: map[string]string{}, binary: binary}
	if target := os.Getenv(runnerCluster); target != "" {
		if c.postgres, err = attachPostgres(target); err != nil {
			return nil, err
		}
		// Roles are per cluster: every package of the run has to give a login the same password.
		for _, login := range logins {
			sum := sha256.Sum256([]byte(c.postgres.password + ":" + login))
			c.passwords[login] = hex.EncodeToString(sum[:20])
		}
		return c, c.shareTemplate(ctx)
	}
	if c.postgres, err = StartPostgres(ctx); err != nil {
		return nil, fmt.Errorf("start PostgreSQL: %w", err)
	}
	for _, login := range logins {
		if c.passwords[login], err = RandomSecret(); err != nil {
			return nil, err
		}
	}
	return c, c.buildTemplate(ctx, templateDatabase)
}

func (c *cluster) buildTemplate(ctx context.Context, name string) error {
	if output, err := c.hrmctl(ctx, name, "provision"); err != nil {
		return fmt.Errorf("hrmctl provision: %T\n%s", err, output)
	}
	if err := c.syncManifest(ctx, name); err != nil {
		return fmt.Errorf("go manifest: %s", Redact(err))
	}
	if err := c.loginExec(ctx, "sync", name, insertProvider, FixtureIssuer); err != nil {
		return fmt.Errorf("fixture provider: %s", Redact(err))
	}
	return nil
}

func (c *cluster) syncManifest(ctx context.Context, name string) error {
	urls := map[database.Purpose]string{}
	for _, purpose := range []database.Purpose{database.PurposeData, database.PurposeIdentity, database.PurposeAuthority, database.PurposeSync} {
		urls[purpose] = c.postgres.LoginURL("product_"+string(purpose), c.passwords[string(purpose)], name)
	}
	pools, err := database.OpenPools(ctx, urls, database.TLSDisabled)
	if err != nil {
		return err
	}
	defer pools.Close()
	core, err := core.New(values.Codecs())
	if err != nil {
		return err
	}
	release, err := manifest.Prepare(declarations.Source(), core)
	if err != nil {
		return err
	}
	runner, err := database.NewRunner(pools, database.RunnerOptions{})
	if err != nil {
		return err
	}
	reconciler, err := manifest.NewReconciler(runner, core, declarations.RuntimeCapabilities())
	if err != nil {
		return err
	}
	if _, err := manifest.Reconcile(ctx, reconciler, release); err != nil {
		return err
	}
	for _, ensure := range []func(*database.Tx) error{permission.EnsureCompany, permission.EnsureWorkCalendar, permission.EnsureSetting, permission.EnsureRole} {
		if _, err := database.Run(ctx, runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (struct{}, error) { return struct{}{}, ensure(tx) }, database.RunOptions{}); err != nil {
			return err
		}
	}
	return nil
}

func (c *cluster) cloneTemplate(ctx context.Context, name string) error {
	c.clone.Lock()
	defer c.clone.Unlock()
	return c.superExec(ctx, "postgres", `CREATE DATABASE "`+name+`" TEMPLATE `+templateDatabase)
}

func (c *cluster) superExec(ctx context.Context, database, sql string) error {
	conn, err := c.postgres.ConnectSuperuser(ctx, database)
	if err != nil {
		return err
	}
	_, err = conn.Exec(ctx, sql)
	return errors.Join(err, conn.Close(ctx))
}

func (c *cluster) loginExec(ctx context.Context, login, database, sql string, args ...any) error {
	conn, err := pgx.Connect(ctx, c.postgres.LoginURL("product_"+login, c.passwords[login], database)+"?sslmode=disable")
	if err != nil {
		return err
	}
	_, err = conn.Exec(ctx, sql, args...)
	return errors.Join(err, conn.Close(ctx))
}

// Direct go test runs have no runner-owned binary; their work directory is removed by go test.
func buildHrmctl(ctx context.Context) (string, error) {
	if binary := os.Getenv("HRM_TEST_HRMCTL"); binary != "" {
		return binary, nil
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("test: no caller")
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	binary := filepath.Join(filepath.Dir(executable), "hrmctl")
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, "./cmd/hrmctl") //nolint:gosec // the output path is the directory of the test binary itself
	build.Dir = filepath.Join(filepath.Dir(file), "..")
	if output, err := build.CombinedOutput(); err != nil {
		return "", fmt.Errorf("build hrmctl: %w\n%s", err, output)
	}
	return binary, nil
}

func (c *cluster) hrmctl(ctx context.Context, database, command string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cli := exec.CommandContext(ctx, c.binary, append([]string{command}, args...)...) //nolint:gosec // only test code chooses the command and its flags
	cli.Env = c.env(database)
	var output bytes.Buffer
	cli.Stdout = &output
	cli.Stderr = &output
	err := cli.Run()
	return output.String(), err
}

func (c *cluster) env(database string) []string {
	env := []string{
		"DATABASE_ADMIN_URL=" + c.postgres.SuperuserURL("postgres"),
		"PRODUCT_DATABASE_NAME=" + database,
	}
	for _, login := range logins {
		upper := strings.ToUpper(login)
		env = append(env,
			"PRODUCT_"+upper+"_PASSWORD="+c.passwords[login],
			"PRODUCT_"+upper+"_DATABASE_URL="+c.postgres.LoginURL("product_"+login, c.passwords[login], database),
		)
	}
	return env
}
