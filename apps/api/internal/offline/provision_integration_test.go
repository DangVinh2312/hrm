//go:build integration

package offline_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"hrm/api/internal/database"
	"hrm/api/internal/offline"
	"hrm/api/test"
)

const (
	productDatabase = "hrm"
	offlineActor    = "00000000-0000-4000-8000-000000000001"
)

type cluster struct {
	postgres  *test.Postgres
	env       []string
	passwords offline.Passwords
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func startCluster(t *testing.T, ctx context.Context) *cluster {
	t.Helper()
	postgres, err := test.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := postgres.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	secrets := make([]string, 7)
	for i := range secrets {
		if secrets[i], err = test.RandomSecret(); err != nil {
			t.Fatal(err)
		}
	}
	db := &cluster{
		postgres: postgres,
		passwords: offline.Passwords{
			Data: secrets[0], Identity: secrets[1], Authority: secrets[2], Sync: secrets[3],
			Migration: secrets[4], Bootstrap: secrets[5], Outbox: secrets[6],
		},
	}
	db.env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"DATABASE_ADMIN_URL=" + postgres.SuperuserURL("postgres"),
		"PRODUCT_DATABASE_NAME=" + productDatabase,
		"PRODUCT_DATA_PASSWORD=" + db.passwords.Data,
		"PRODUCT_IDENTITY_PASSWORD=" + db.passwords.Identity,
		"PRODUCT_AUTHORITY_PASSWORD=" + db.passwords.Authority,
		"PRODUCT_SYNC_PASSWORD=" + db.passwords.Sync,
		"PRODUCT_MIGRATION_PASSWORD=" + db.passwords.Migration,
		"PRODUCT_BOOTSTRAP_PASSWORD=" + db.passwords.Bootstrap,
		"PRODUCT_OUTBOX_PASSWORD=" + db.passwords.Outbox,
		"PRODUCT_MIGRATION_DATABASE_URL=" + postgres.LoginURL("product_migration", db.passwords.Migration, productDatabase),
	}
	return db
}

func (s *cluster) admin() offline.Connection {
	return offline.Connection{
		Host: s.postgres.Host(), Port: s.postgres.Port(),
		Username: test.Superuser(), Password: s.postgres.SuperuserPassword(),
		Database: productDatabase, TLS: database.TLSDisabled,
	}
}

func runCommand(ctx context.Context, dir string, env []string, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = dir
	command.Env = env
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	return output.String(), err
}

func buildHrmctl(t *testing.T, ctx context.Context) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "hrmctl")
	if output, err := runCommand(ctx, moduleRoot(t), os.Environ(), "go", "build", "-o", binary, "./cmd/hrmctl"); err != nil {
		t.Fatalf("build hrmctl: %v\n%s", err, output)
	}
	return binary
}

func runHrmctl(t *testing.T, ctx context.Context, binary string, db *cluster, command string) {
	t.Helper()
	if output, err := runCommand(ctx, t.TempDir(), db.env, binary, command); err != nil {
		t.Fatalf("hrmctl %s: %v\n%s", command, err, output)
	}
}

func integrationContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func superExec(t *testing.T, ctx context.Context, db *cluster, statements ...string) {
	t.Helper()
	conn, err := db.postgres.ConnectSuperuser(ctx, productDatabase)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	}()
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

func superLines(t *testing.T, ctx context.Context, db *cluster, query string) []string {
	t.Helper()
	conn, err := db.postgres.ConnectSuperuser(ctx, productDatabase)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	}()
	lines, err := collectLines(ctx, conn, query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return lines
}

func dumps(t *testing.T, ctx context.Context, db *cluster) ([]string, []string) {
	t.Helper()
	catalog, err := catalogDump(ctx, db.postgres, productDatabase)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := schemaDump(ctx, db.postgres, productDatabase)
	if err != nil {
		t.Fatal(err)
	}
	return catalog, schema
}

func TestProvisionBuildsAWorkingDatabase(t *testing.T) {
	ctx := integrationContext(t)
	db := startCluster(t, ctx)
	binary := buildHrmctl(t, ctx)
	runHrmctl(t, ctx, binary, db, "provision")

	t.Run("goose applied every migration in order", func(t *testing.T) {
		migrations, err := database.Migrations()
		if err != nil {
			t.Fatal(err)
		}
		files, err := fs.Glob(migrations, "*.sql")
		if err != nil {
			t.Fatal(err)
		}
		var want []string
		for _, file := range files {
			version, _, _ := strings.Cut(file, "_")
			want = append(want, version)
		}
		if got := superLines(t, ctx, db, "SELECT version_id::text FROM goose_db_version WHERE version_id>0 ORDER BY id"); !slices.Equal(got, want) {
			t.Fatalf("applied %v, files %v", got, want)
		}
	})

	t.Run("the probe passes", func(t *testing.T) {
		verifyProbe(t, ctx, db)
	})

	t.Run("a repeat changes nothing", func(t *testing.T) {
		catalog, schema := dumps(t, ctx, db)
		runHrmctl(t, ctx, binary, db, "provision")
		runHrmctl(t, ctx, binary, db, "migrate")
		catalogAgain, schemaAgain := dumps(t, ctx, db)
		assertSame(t, "catalog", catalog, catalogAgain)
		assertSame(t, "pg_dump", schema, schemaAgain)
	})
}

func verifyProbe(t *testing.T, ctx context.Context, db *cluster) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(moduleRoot(t), "contract", "privileges.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		ApplicationPrivileges map[database.Purpose][]string `json:"applicationPrivileges"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	urls := map[database.Purpose]string{}
	for purpose, password := range map[database.Purpose]string{
		database.PurposeData: db.passwords.Data, database.PurposeIdentity: db.passwords.Identity,
		database.PurposeAuthority: db.passwords.Authority, database.PurposeSync: db.passwords.Sync,
		database.PurposeBootstrap: db.passwords.Bootstrap, database.PurposeOutbox: db.passwords.Outbox,
	} {
		urls[purpose] = db.postgres.LoginURL("product_"+string(purpose), password, productDatabase)
	}
	pools, err := database.OpenPools(ctx, urls, database.TLSDisabled)
	if err != nil {
		t.Fatal(err)
	}
	defer pools.Close()
	if err := database.VerifyPrivileges(ctx, pools, contract.ApplicationPrivileges); err != nil {
		t.Fatal(err)
	}
}

const (
	accountPending   = "11111111-1111-4111-8111-111111111111"
	accountActive    = "22222222-2222-4222-8222-222222222222"
	accountSuspended = "33333333-3333-4333-8333-333333333333"
	accountHolder    = "44444444-4444-4444-8444-444444444444"
	accountRoot      = "55555555-5555-4555-8555-555555555555"
)

// accountsWithoutRole places the data the migration has to fix. Replica mode skips the triggers, so the
// fixture needs no manifest sync and no Root flow.
func accountsWithoutRole(t *testing.T, ctx context.Context, db *cluster) {
	t.Helper()
	superExec(t, ctx, db,
		"SET session_replication_role=replica; "+
			"INSERT INTO app_user(id,email_canonical,state) VALUES ('"+accountPending+"','pending@example.test','pending'),('"+accountActive+"','active@example.test','active'),('"+accountSuspended+"','suspended@example.test','suspended'),('"+accountHolder+"','holder@example.test','active');"+
			"INSERT INTO app_user(id,email_canonical,state,kind) VALUES ('"+accountRoot+"','root@example.test','active','root');"+
			"INSERT INTO role_definition(role_key,managed_by,label) VALUES (convert_to('hr.admin','UTF8'),'code','Admin');"+
			"INSERT INTO user_role(user_id,role_key) VALUES ('"+accountHolder+"',convert_to('hr.admin','UTF8'));"+
			"UPDATE authz_state SET revision=41 WHERE singleton;")
}

func addEmployeeRole(t *testing.T, ctx context.Context, db *cluster) {
	t.Helper()
	superExec(t, ctx, db, "SET session_replication_role=replica; INSERT INTO role_definition(role_key,managed_by,label) VALUES (convert_to('hr.employee','UTF8'),'code','Employee')")
}

type upgradeResult struct {
	roles, audit, revision, assigned []string
}

func readUpgrade(t *testing.T, ctx context.Context, db *cluster) upgradeResult {
	t.Helper()
	return upgradeResult{
		roles: superLines(t, ctx, db, `SELECT user_id::text||'|'||convert_from(role_key,'UTF8') FROM user_role ORDER BY 1`),
		audit: superLines(t, ctx, db, `SELECT actor_id::text||'|'||convert_from(event_kind,'UTF8')||'|'||convert_from(permission_key,'UTF8')||'|'||object_id::text||'|'||policy_revision::text||'|'||safe_metadata::text
			FROM audit_outbox ORDER BY object_id`),
		revision: superLines(t, ctx, db, `SELECT revision::text FROM authz_state`),
		assigned: superLines(t, ctx, db, `SELECT count(*)::text||'|'||count(DISTINCT event_id)::text||'|'||COALESCE(bool_and(occurred_at IS NOT NULL),true)::text FROM audit_outbox`),
	}
}

func assertUpgrade(t *testing.T, got upgradeResult) {
	t.Helper()
	wantRoles := []string{
		accountPending + "|hr.employee", accountActive + "|hr.employee", accountSuspended + "|hr.employee", accountHolder + "|hr.admin",
	}
	if !slices.Equal(got.roles, wantRoles) {
		t.Errorf("roles %q", got.roles)
	}
	if !slices.Equal(got.revision, []string{"42"}) {
		t.Errorf("revision %q", got.revision)
	}
	if !slices.Equal(got.assigned, []string{"3|3|true"}) {
		t.Errorf("audit counts %q", got.assigned)
	}
	for _, id := range []string{accountPending, accountActive, accountSuspended} {
		found := false
		for _, line := range got.audit {
			if strings.HasPrefix(line, offlineActor+"|permission.role-assign|account.assignRole|"+id+"|41|") {
				found = true
			}
		}
		if !found {
			t.Errorf("no audit event for %s: %q", id, got.audit)
		}
	}
}

func TestRoleRequiredAssignsTheEmployeeRoleFromALiteralActor(t *testing.T) {
	ctx := integrationContext(t)
	db := startCluster(t, ctx)
	binary := buildHrmctl(t, ctx)
	conn, err := db.postgres.ConnectSuperuser(ctx, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE "`+productDatabase+`"`); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := offline.ProvisionUpTo(ctx, db.admin(), db.passwords, 1792108800005); err != nil {
		t.Fatal(err)
	}
	accountsWithoutRole(t, ctx, db)

	t.Run("a missing role definition fails on the foreign key", func(t *testing.T) {
		output, err := runCommand(ctx, t.TempDir(), db.env, binary, "provision")
		if err == nil {
			t.Fatal("provision passed")
		}
		if !strings.Contains(output, "23503") {
			t.Errorf("no SQLSTATE in %q", output)
		}
		for _, secret := range []string{db.passwords.Migration, db.postgres.SuperuserPassword()} {
			if strings.Contains(output, secret) {
				t.Error("the output holds a password")
			}
		}
		after := readUpgrade(t, ctx, db)
		if !slices.Equal(after.revision, []string{"41"}) || len(after.audit) != 0 {
			t.Errorf("the failed migration left %q and %d events", after.revision, len(after.audit))
		}
		ownersCreate := "SELECT count(*)::text FROM pg_namespace n,aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname='public' AND a.privilege_type='CREATE' AND r.rolname IN ('" + strings.Join(database.FunctionOwners(), "','") + "')"
		if got := superLines(t, ctx, db, "SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='product_migration'"); !slices.Equal(got, []string{"0"}) {
			t.Errorf("the migration login kept memberships: %q", got)
		}
		if got := superLines(t, ctx, db, ownersCreate); !slices.Equal(got, []string{"0"}) {
			t.Errorf("the owners kept CREATE on public: %q", got)
		}
	})

	addEmployeeRole(t, ctx, db)
	runHrmctl(t, ctx, binary, db, "provision")
	got := readUpgrade(t, ctx, db)
	assertUpgrade(t, got)

	t.Run("a repeat assigns nothing more", func(t *testing.T) {
		runHrmctl(t, ctx, binary, db, "provision")
		after := readUpgrade(t, ctx, db)
		if !slices.Equal(after.revision, got.revision) || len(after.audit) != len(got.audit) {
			t.Fatalf("revision %q, %d events", after.revision, len(after.audit))
		}
	})

	t.Run("the actor is a literal uuid", func(t *testing.T) {
		files, err := database.Migrations()
		if err != nil {
			t.Fatal(err)
		}
		content, err := fs.ReadFile(files, "1792108800006_account_role_required.sql")
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(content, []byte("'"+offlineActor+"'::uuid")) || bytes.Contains(content, []byte("$1")) {
			t.Fatal("the migration does not carry the literal")
		}
	})
}

func TestHrmctlPrintsNoSecretOnFailure(t *testing.T) {
	ctx := integrationContext(t)
	binary := buildHrmctl(t, ctx)
	for name, env := range map[string][]string{
		"no variables":    {},
		"unknown command": nil,
		"wrong password": {
			"DATABASE_ADMIN_URL=postgres://nobody:do-not-print-me@127.0.0.1:1/postgres",
			"PRODUCT_DATABASE_NAME=hrm",
		},
		"bad database name": {
			"DATABASE_ADMIN_URL=postgres://nobody:do-not-print-me@127.0.0.1:1/postgres",
			"PRODUCT_DATABASE_NAME=Not-Valid",
		},
		"bad url": {"DATABASE_ADMIN_URL=postgres://nobody:do-not-print-me%zz@127.0.0.1:1/postgres"},
	} {
		t.Run(name, func(t *testing.T) {
			command := "provision"
			if name == "unknown command" {
				command = "other"
			}
			output, err := runCommand(ctx, t.TempDir(), env, binary, command)
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 1 {
				t.Fatalf("got %v", err)
			}
			if strings.Contains(output, "do-not-print-me") {
				t.Fatalf("prints a password: %q", output)
			}
			if !strings.Contains(output, "Product operation failed") {
				t.Fatalf("output %q", output)
			}
		})
	}
}
