//go:build integration

package database_test

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/database"
	"hrm/api/internal/offline"
)

func loginConnection(t *testing.T, ctx context.Context, login, password string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(ctx, cluster.LoginURL(login, password, databaseName)+"?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return conn
}

func sqlState(err error) string {
	var driver *pgconn.PgError
	if errors.As(err, &driver) {
		return driver.Code
	}
	return ""
}

func TestRuntimeLoginsCannotEscalateOrAlterSchema(t *testing.T) {
	ctx := testContext(t)
	for _, purpose := range []database.Purpose{database.PurposeData, database.PurposeIdentity, database.PurposeAuthority, database.PurposeSync} {
		conn := loginConnection(t, ctx, "product_"+string(purpose), passwordOf(purpose))
		var user string
		if err := conn.QueryRow(ctx, "SELECT current_user::text").Scan(&user); err != nil {
			t.Fatal(err)
		}
		if user != "product_"+string(purpose) {
			t.Fatalf("connected as %s", user)
		}
		for _, statement := range []string{"SET ROLE product_migration", "CREATE TABLE public.forbidden(id integer)"} {
			if _, err := conn.Exec(ctx, statement); sqlState(err) != "42501" {
				t.Errorf("%s: %s: %v", purpose, statement, err)
			}
		}
	}
	for login, statement := range map[string]string{
		"data":      "SELECT * FROM mfa_totp",
		"authority": "DELETE FROM application_session",
		"identity":  "DELETE FROM user_role",
	} {
		purpose := database.Purpose(login)
		conn := loginConnection(t, ctx, "product_"+login, passwordOf(purpose))
		if _, err := conn.Exec(ctx, statement); sqlState(err) != "42501" {
			t.Errorf("%s: %s: %v", login, statement, err)
		}
	}
}

func TestEveryLoginIsRefusedCreateTempAndReplicaByPostgres(t *testing.T) {
	ctx := testContext(t)
	for _, purpose := range runtimeLogins {
		conn := loginConnection(t, ctx, "product_"+string(purpose), passwordOf(purpose))
		for _, statement := range []string{
			"CREATE TABLE public.forbidden(id integer)",
			"CREATE TEMP TABLE forbidden_temp(id integer)",
			"CREATE SCHEMA forbidden_schema",
			"SET session_replication_role=replica",
		} {
			if _, err := conn.Exec(ctx, statement); sqlState(err) != "42501" {
				t.Errorf("%s: %s: %v", purpose, statement, err)
			}
		}
	}
}

func TestCodeRowsAndOwnershipTransitionsAreProtected(t *testing.T) {
	ctx := testContext(t)
	key := []byte("coded")
	syncPool, authority := pools[database.PurposeSync], pools[database.PurposeAuthority]
	if _, err := syncPool.Exec(ctx, "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'code','Coded')", key); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		"UPDATE role_definition SET label='hijack' WHERE role_key=$1",
		"UPDATE role_definition SET managed_by='runtime' WHERE role_key=$1",
		"DELETE FROM role_definition WHERE role_key=$1",
	} {
		if _, err := authority.Exec(ctx, statement, key); err == nil {
			t.Errorf("authority ran %s", statement)
		}
	}
	kept := []byte("custom.kept")
	if _, err := authority.Exec(ctx, "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','Runtime')", kept); err != nil {
		t.Fatal(err)
	}
	if _, err := syncPool.Exec(ctx, "UPDATE role_definition SET managed_by='code' WHERE role_key=$1", kept); err == nil {
		t.Error("sync took a runtime role")
	}
}

func TestRepeatProvisionIsANoOpAndKeepsRuntimeFacts(t *testing.T) {
	ctx := testContext(t)
	key := []byte("custom.survives")
	if _, err := pools[database.PurposeAuthority].Exec(ctx, "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','Runtime')", key); err != nil {
		t.Fatal(err)
	}
	versions := querySuperuser(t, "SELECT count(*)::text FROM goose_db_version")
	if err := offline.Provision(ctx, admin, passwords); err != nil {
		t.Fatal(err)
	}
	if got := querySuperuser(t, "SELECT count(*)::text FROM goose_db_version"); got != versions {
		t.Fatalf("%s versions, %s before", got, versions)
	}
	if got := querySuperuser(t, "SELECT label FROM role_definition WHERE role_key=$1", key); got != "Runtime" {
		t.Fatalf("label %q", got)
	}
	assertClean(t)
	if got := querySuperuser(t, "SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='product_migration'"); got != "0" {
		t.Fatalf("the migration login kept %s memberships", got)
	}
}

func TestProvisionRefusesUnsafeRoles(t *testing.T) {
	ctx := testContext(t)
	for alter, restore := range map[string]string{
		"ALTER ROLE product_data REPLICATION": "ALTER ROLE product_data NOREPLICATION",
		"ALTER ROLE product_sync SUPERUSER":   "ALTER ROLE product_sync NOSUPERUSER",
		"ALTER ROLE product_outbox NOLOGIN":   "ALTER ROLE product_outbox LOGIN",
	} {
		asSuperuser(t, alter)
		err := offline.Provision(ctx, admin, passwords)
		asSuperuser(t, restore)
		if !errors.Is(err, offline.ErrUnsafeRole) {
			t.Errorf("%s: got %v", alter, err)
		}
	}
	asSuperuser(t, "ALTER ROLE product_fence_owner LOGIN")
	err := offline.Provision(ctx, admin, passwords)
	asSuperuser(t, "ALTER ROLE product_fence_owner NOLOGIN")
	if !errors.Is(err, offline.ErrUnsafeOwner) {
		t.Errorf("owner with LOGIN: got %v", err)
	}
}

func TestProvisionRefusesAMissingCredential(t *testing.T) {
	for name, change := range map[string]func(*offline.Passwords){
		"empty":   func(p *offline.Passwords) { p.Outbox = "" },
		"has NUL": func(p *offline.Passwords) { p.Sync = "a\x00b" },
	} {
		missing := passwords
		change(&missing)
		if err := offline.Provision(testContext(t), admin, missing); !errors.Is(err, offline.ErrMissingCredential) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

// assertMigrationAccessClosed checks what provisioning opens only while it migrates.
func assertMigrationAccessClosed(t *testing.T) {
	t.Helper()
	if got := querySuperuser(t, "SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='product_migration'"); got != "0" {
		t.Errorf("the migration login kept %s memberships", got)
	}
	if got := querySuperuser(t, "SELECT count(*)::text FROM pg_namespace n,aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname='public' AND a.privilege_type='CREATE' AND r.rolname=ANY($1)", database.FunctionOwners()); got != "0" {
		t.Errorf("%s owners kept CREATE on public", got)
	}
}

func TestProvisionRevokesWhatItGrantedWhenAGrantFails(t *testing.T) {
	// The cycle fails the last grant, after the owners received CREATE on the schema.
	asSuperuser(t, "GRANT product_migration TO product_fence_owner")
	defer asSuperuser(t, "REVOKE product_migration FROM product_fence_owner")
	if err := offline.Provision(testContext(t), admin, passwords); sqlState(err) != "0LP01" {
		t.Fatalf("got %v", err)
	}
	assertMigrationAccessClosed(t)
}

func TestProvisionClosesTheSchemaAfterACancelledMigration(t *testing.T) {
	ctx := testContext(t)
	conn, err := cluster.ConnectSuperuser(ctx, databaseName)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	}()
	lock, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lock.Exec(ctx, "LOCK TABLE goose_db_version IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	provisioning, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- offline.Provision(provisioning, admin, passwords) }()
	for limit := time.Now().Add(30 * time.Second); querySuperuser(t, "SELECT count(*)::text FROM pg_stat_activity WHERE usename='product_migration' AND wait_event_type='Lock'") == "0"; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(limit) {
			cancel()
			t.Fatalf("the migration never waited on the lock, then returned %v", <-done)
		}
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("a cancelled provision reported success")
	}
	if err := lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertMigrationAccessClosed(t)
}

func TestProvisionRevokesOnANewConnectionWhenTheFirstDied(t *testing.T) {
	ctx := testContext(t)
	conn, err := cluster.ConnectSuperuser(ctx, databaseName)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	}()
	var holder string
	if err := conn.QueryRow(ctx, "SELECT pg_backend_pid()::text").Scan(&holder); err != nil {
		t.Fatal(err)
	}
	lock, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lock.Exec(ctx, "LOCK TABLE goose_db_version IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- offline.Provision(ctx, admin, passwords) }()
	for limit := time.Now().Add(30 * time.Second); querySuperuser(t, "SELECT count(*)::text FROM pg_stat_activity WHERE usename='product_migration' AND wait_event_type='Lock'") == "0"; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(limit) {
			t.Fatalf("the migration never waited on the lock, then returned %v", <-done)
		}
	}
	// Provisioning holds its session while it migrates, its last statement the grant to the migration login.
	// A poll session that just closed can still be listed, so the statement picks the session.
	if got := querySuperuser(t, "SELECT count(pg_terminate_backend(pid))::text FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid() AND pid<>$1::int AND query LIKE 'GRANT % TO product_migration WITH ADMIN OPTION'", holder); got != "1" {
		t.Fatalf("terminated %s sessions", got)
	}
	if err := lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("got %v", err)
	}
	assertMigrationAccessClosed(t)
}

func TestIdentityOnlyActivatesAndAuthorityOnlySuspends(t *testing.T) {
	ctx := testContext(t)
	identity, authority := pools[database.PurposeIdentity], pools[database.PurposeAuthority]
	id := "10000000-0000-4000-8000-000000000011"
	if _, err := identity.Exec(ctx, "INSERT INTO app_user(id,email_canonical,state) VALUES($1,'lifecycle@example.test','pending')", id); err != nil {
		t.Fatal(err)
	}
	if _, err := identity.Exec(ctx, "UPDATE app_user SET state='active' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	if _, err := authority.Exec(ctx, "UPDATE app_user SET state='suspended' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		"UPDATE app_user SET state='active' WHERE id=$1",
		"UPDATE app_user SET state='pending' WHERE id=$1",
		"UPDATE app_user SET email_canonical='taken@example.test' WHERE id=$1",
	} {
		if _, err := identity.Exec(ctx, statement, id); sqlState(err) != "42501" {
			t.Errorf("identity: %s: %v", statement, err)
		}
	}
	pending := "10000000-0000-4000-8000-000000000012"
	if _, err := identity.Exec(ctx, "INSERT INTO app_user(id,email_canonical,state) VALUES($1,'pending-lifecycle@example.test','pending')", pending); err != nil {
		t.Fatal(err)
	}
	for _, target := range [][2]string{{id, "active"}, {id, "pending"}, {pending, "active"}} {
		if _, err := authority.Exec(ctx, "UPDATE app_user SET state=$2 WHERE id=$1", target[0], target[1]); sqlState(err) != "42501" {
			t.Errorf("authority moved %s to %s: %v", target[0], target[1], err)
		}
	}
	if _, err := authority.Exec(ctx, "UPDATE app_user SET state='suspended' WHERE id=$1", pending); err != nil {
		t.Fatal(err)
	}
}

func randomDigest(t *testing.T) []byte {
	t.Helper()
	digest := make([]byte, 32)
	if _, err := rand.Read(digest); err != nil {
		t.Fatal(err)
	}
	return digest
}

func sessionRows(t *testing.T, ctx context.Context, digest []byte) []map[string]any {
	t.Helper()
	rows, err := pools[database.PurposeData].Query(ctx, "SELECT * FROM public.resolve_session($1)", digest)
	if err != nil {
		t.Fatal(err)
	}
	found, err := pgx.CollectRows(rows, pgx.RowToMap)
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestSessionProjectionHidesSecretsAndChecksBinding(t *testing.T) {
	ctx := testContext(t)
	id := "10000000-0000-4000-8000-000000000099"
	issuer := "https://projection.fixture"
	digest := randomDigest(t)
	owner := loginConnection(t, ctx, "product_migration", passwords.Migration)
	if _, err := owner.Exec(ctx, "INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)", issuer); err != nil {
		t.Fatal(err)
	}
	identity := pools[database.PurposeIdentity]
	if _, err := identity.Exec(ctx, "INSERT INTO app_user(id,email_verified,state) VALUES($1,true,'active')", id); err != nil {
		t.Fatal(err)
	}
	if _, err := identity.Exec(ctx, "INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'projection-subject',$2)", issuer, id); err != nil {
		t.Fatal(err)
	}
	if _, err := identity.Exec(ctx, "INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,expires_at) VALUES($1,$2,1,'oidc','oidc',$3,'projection-subject',1,1,statement_timestamp(),statement_timestamp()+interval '1 hour')", digest, id, issuer); err != nil {
		t.Fatal(err)
	}
	found := sessionRows(t, ctx, digest)
	if len(found) != 1 {
		t.Fatalf("%d rows", len(found))
	}
	if fmt.Sprint(found[0]["kind"]) != "iam" {
		t.Fatalf("kind %v", found[0]["kind"])
	}
	for _, hidden := range []string{"authority_level", "external_subject", "email_canonical"} {
		if _, present := found[0][hidden]; present {
			t.Errorf("the projection exposes %s", hidden)
		}
	}
	for _, step := range []struct {
		statement string
		rows      int
	}{
		{"UPDATE external_identity SET binding_version=2 WHERE user_id='" + id + "'", 0},
		{"UPDATE external_identity SET binding_version=1 WHERE user_id='" + id + "'", 1},
		{"UPDATE oidc_provider SET version=2 WHERE issuer='" + issuer + "'", 0},
		{"UPDATE oidc_provider SET version=1 WHERE issuer='" + issuer + "'", 1},
	} {
		if _, err := owner.Exec(ctx, step.statement); err != nil {
			t.Fatal(err)
		}
		if got := len(sessionRows(t, ctx, digest)); got != step.rows {
			t.Fatalf("%s: %d rows", step.statement, got)
		}
	}
	if _, err := identity.Exec(ctx, "UPDATE app_user SET auth_epoch=2 WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	if got := len(sessionRows(t, ctx, digest)); got != 0 {
		t.Fatalf("a new epoch left %d rows", got)
	}
}

func TestBootstrapMarkerAndRevisionCannotGoBack(t *testing.T) {
	ctx := testContext(t)
	target := "10000000-0000-4000-8000-000000000077"
	if _, err := pools[database.PurposeIdentity].Exec(ctx, "INSERT INTO app_user(id) VALUES($1)", target); err != nil {
		t.Fatal(err)
	}
	bootstrap, syncPool := pools[database.PurposeBootstrap], pools[database.PurposeSync]
	if _, err := bootstrap.Exec(ctx, "UPDATE security_bootstrap_state SET operation_id=$1,target_user_id=$2,initialized_at=statement_timestamp() WHERE singleton", "20000000-0000-4000-8000-000000000077", target); err != nil {
		t.Fatal(err)
	}
	if _, err := bootstrap.Exec(ctx, "UPDATE security_bootstrap_state SET operation_id=NULL,target_user_id=NULL,initialized_at=NULL WHERE singleton"); err == nil || !strings.Contains(err.Error(), "permanent") {
		t.Errorf("reset of the marker: %v", err)
	}
	if _, err := database.Run(ctx, newRunner(t, database.RunnerOptions{}), database.ModeAdmin, none(1), database.RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := syncPool.Exec(ctx, "UPDATE authz_state SET revision=1 WHERE singleton"); err == nil || !strings.Contains(err.Error(), "cannot downgrade") {
		t.Errorf("revision downgrade: %v", err)
	}
	sequence := querySuperuser(t, "SELECT (release_sequence+10)::text FROM authz_state")
	if _, err := syncPool.Exec(ctx, "UPDATE authz_state SET release_sequence=$1 WHERE singleton", sequence); err != nil {
		t.Fatal(err)
	}
	if _, err := syncPool.Exec(ctx, "UPDATE authz_state SET release_sequence=release_sequence-1 WHERE singleton"); err == nil || !strings.Contains(err.Error(), "cannot downgrade") {
		t.Errorf("sequence downgrade: %v", err)
	}
}

func TestProviderVersionChangeDoesNotReviveSessions(t *testing.T) {
	ctx := testContext(t)
	id := "10000000-0000-4000-8000-000000000066"
	issuer := "https://issuer.fixture.invalid"
	digest := randomDigest(t)
	identity, syncPool := pools[database.PurposeIdentity], pools[database.PurposeSync]
	if _, err := identity.Exec(ctx, "INSERT INTO app_user(id,state) VALUES($1,'active')", id); err != nil {
		t.Fatal(err)
	}
	if _, err := identity.Exec(ctx, "INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'subject',$2)", issuer, id); err != nil {
		t.Fatal(err)
	}
	if _, err := syncPool.Exec(ctx, "INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)", issuer); err != nil {
		t.Fatal(err)
	}
	if _, err := identity.Exec(ctx, "INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,authenticated_at,expires_at,external_issuer,external_subject,binding_version,provider_version) VALUES($1,$2,1,'oidc','oidc',statement_timestamp(),statement_timestamp()+interval '1 hour',$3,'subject',1,1)", digest, id, issuer); err != nil {
		t.Fatal(err)
	}
	if got := len(sessionRows(t, ctx, digest)); got != 1 {
		t.Fatalf("%d rows", got)
	}
	if _, err := syncPool.Exec(ctx, "UPDATE oidc_provider SET enabled=false,version=2 WHERE issuer=$1", issuer); err != nil {
		t.Fatal(err)
	}
	if got := len(sessionRows(t, ctx, digest)); got != 0 {
		t.Fatalf("a disabled provider left %d rows", got)
	}
	if _, err := syncPool.Exec(ctx, "UPDATE oidc_provider SET enabled=true WHERE issuer=$1", issuer); err != nil {
		t.Fatal(err)
	}
	if got := len(sessionRows(t, ctx, digest)); got != 0 {
		t.Fatalf("the re-enabled provider revived %d sessions", got)
	}
}

func TestResolveSessionHasItsExactACL(t *testing.T) {
	got := querySuperuser(t, `SELECT string_agg(r.rolname||'>'||COALESCE(g.rolname,'PUBLIC')||':'||a.privilege_type,',' ORDER BY COALESCE(g.rolname,'PUBLIC'))
		FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner,aclexplode(p.proacl) a
		LEFT JOIN pg_roles g ON g.oid=a.grantee
		WHERE p.oid='public.resolve_session(bytea)'::regprocedure`)
	want := "product_session_owner>product_authority:EXECUTE,product_session_owner>product_data:EXECUTE,product_session_owner>product_identity:EXECUTE,product_session_owner>product_session_owner:EXECUTE"
	if got != want {
		t.Fatalf("ACL %s", got)
	}
	if got := querySuperuser(t, "SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND column_name='authority_level'"); got != "0" {
		t.Fatalf("%s authority_level columns", got)
	}
	if got := querySuperuser(t, "SELECT COALESCE(to_regprocedure('public.require_root_marker()')::text,'-')||COALESCE(to_regprocedure('public.protect_system_activation()')::text,'-')||COALESCE(to_regclass('public.account_rank')::text,'-')||COALESCE(to_regclass('public.iam_account')::text,'-')"); got != "---iam_account" {
		t.Fatalf("objects %s", got)
	}
}
