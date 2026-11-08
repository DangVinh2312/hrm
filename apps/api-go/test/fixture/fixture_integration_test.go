//go:build integration

package fixture_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

type release struct {
	Sequence          string `json:"sequence"`
	Hash              string `json:"hash"`
	RuntimeCapability int    `json:"runtimeCapability"`
	Declarations      struct {
		Resources []json.RawMessage `json:"resources"`
	} `json:"declarations"`
	Roles []struct {
		Key string `json:"key"`
	} `json:"roles"`
	DefaultGrants []json.RawMessage `json:"defaultGrants"`
}

func readContract(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "contract", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatal(err)
	}
}

func superuser(t *testing.T, s *test.Stack) *pgx.Conn {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatalf("connect: %s", test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(t.Context()); err != nil {
			t.Error(test.Redact(err))
		}
	})
	return conn
}

func scalar[T any](t *testing.T, conn *pgx.Conn, sql string, args ...any) T {
	t.Helper()
	var value T
	if err := conn.QueryRow(t.Context(), sql, args...).Scan(&value); err != nil {
		t.Fatalf("%s: %s", sql, test.Redact(err))
	}
	return value
}

func TestTheTemplateHoldsTheCodeOwnedFacts(t *testing.T) {
	var contract release
	readContract(t, "release.json", &contract)
	s := test.NewDatabase(t)
	conn := superuser(t, s)

	var state struct {
		hash, sequence, materialized string
		capability                   int
	}
	if err := conn.QueryRow(t.Context(),
		`SELECT encode(manifest_hash,'hex'),release_sequence::text,coalesce(encode(materialized_hash,'hex'),''),min_runtime_capability FROM authz_state WHERE singleton`,
	).Scan(&state.hash, &state.sequence, &state.materialized, &state.capability); err != nil {
		t.Fatal(test.Redact(err))
	}
	if state.hash != contract.Hash || state.sequence != contract.Sequence || state.capability != contract.RuntimeCapability {
		t.Errorf("authz_state %s/%s/%d, release %s/%s/%d", state.hash, state.sequence, state.capability, contract.Hash, contract.Sequence, contract.RuntimeCapability)
	}
	if len(state.materialized) != 64 {
		t.Errorf("materialized hash %q", state.materialized)
	}

	roles := scalar[[]string](t, conn, `SELECT coalesce(array_agg(convert_from(role_key,'UTF8') ORDER BY role_key),'{}') FROM role_definition WHERE managed_by='code'`)
	var want []string
	for _, role := range contract.Roles {
		want = append(want, role.Key)
	}
	slices.Sort(want)
	if !slices.Equal(roles, want) {
		t.Errorf("code roles %v, release %v", roles, want)
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM policy_rule WHERE managed_by='code'`); got != len(contract.DefaultGrants) {
		t.Errorf("code grants %d, release %d", got, len(contract.DefaultGrants))
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM resource_type`); got != len(contract.Declarations.Resources) {
		t.Errorf("resource types %d, release %d", got, len(contract.Declarations.Resources))
	}

	anchors := map[string]string{
		"hr_company":     "00000000-0000-4000-8000-000000000c01",
		"work_calendar":  "00000000-0000-4000-8000-000000000c02",
		"setting_anchor": "00000000-0000-4000-8000-000000000c03",
		"role_anchor":    "00000000-0000-4000-8000-000000000c04",
	}
	for table, id := range anchors {
		ids := scalar[[]string](t, conn, `SELECT coalesce(array_agg(c.id::text),'{}') FROM `+table+` c JOIN object_ref o ON o.object_id=c.object_id AND o.key_bytes=convert_to(c.id::text,'UTF8')`)
		if !slices.Equal(ids, []string{id}) {
			t.Errorf("%s anchors %v", table, ids)
		}
	}
	if got := scalar[bool](t, conn, `SELECT enabled FROM oidc_provider WHERE issuer=$1`, test.FixtureIssuer); !got {
		t.Error("the fixture provider is disabled")
	}
}

func TestThePrivilegeProbePasses(t *testing.T) {
	var contract struct {
		ApplicationPrivileges map[database.Purpose][]string `json:"applicationPrivileges"`
	}
	readContract(t, "privileges.json", &contract)
	s := test.NewDatabase(t)
	if len(s.Pools) != 6 {
		t.Fatalf("%d pools", len(s.Pools))
	}
	if err := database.VerifyPrivileges(t.Context(), s.Pools, contract.ApplicationPrivileges); err != nil {
		t.Fatal(err)
	}
}

func TestEachDatabaseIsItsOwnCopy(t *testing.T) {
	a := test.NewDatabase(t)
	b := test.NewDatabase(t)
	if a.Database == b.Database {
		t.Fatal("same database twice")
	}
	account := fixture.Account(t, a, fixture.AccountSpec{})
	if got := scalar[int](t, superuser(t, b), `SELECT count(*)::int FROM app_user WHERE id=$1`, account.ID); got != 0 {
		t.Errorf("an account of one database is in the other")
	}
}

type resolved struct {
	user, kind, state string
	fresh             bool
}

func resolve(t *testing.T, s *test.Stack, secret string) []resolved {
	t.Helper()
	digest := sha256.Sum256([]byte(secret))
	rows, err := s.Pools[database.PurposeData].Query(t.Context(),
		`SELECT user_id::text,kind,state,reauthenticated_at IS NOT NULL FROM public.resolve_session($1)`, digest[:])
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (resolved, error) {
		var r resolved
		return r, row.Scan(&r.user, &r.kind, &r.state, &r.fresh)
	})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return found
}

func TestASessionIsResolved(t *testing.T) {
	s := test.NewDatabase(t)
	account := fixture.Account(t, s, fixture.AccountSpec{Email: "person@example.test"})

	plain := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	if raw, err := base64.RawURLEncoding.DecodeString(plain); err != nil || len(raw) != 32 {
		t.Fatalf("the secret is not 32 bytes of base64url")
	}
	if got := resolve(t, s, plain); !slices.Equal(got, []resolved{{account.ID, "iam", "active", false}}) {
		t.Errorf("plain session %v", got)
	}
	fresh := fixture.Session(t, s, account.ID, fixture.SessionSpec{Fresh: true})
	if got := resolve(t, s, fresh); !slices.Equal(got, []resolved{{account.ID, "iam", "active", true}}) {
		t.Errorf("fresh session %v", got)
	}
	if plain == fresh {
		t.Error("two sessions share a secret")
	}
	if got := resolve(t, s, plain+"x"); len(got) != 0 {
		t.Errorf("an unknown secret resolved to %v", got)
	}

	conn := superuser(t, s)
	if _, err := conn.Exec(t.Context(), `UPDATE app_user SET auth_epoch=auth_epoch+1 WHERE id=$1`, account.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	if got := resolve(t, s, plain); len(got) != 0 {
		t.Errorf("a session of an older epoch resolved to %v", got)
	}

	suspended := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, suspended.ID, fixture.SessionSpec{})
	if _, err := conn.Exec(t.Context(), `UPDATE app_user SET state='suspended' WHERE id=$1`, suspended.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	if got := resolve(t, s, secret); len(got) != 0 {
		t.Errorf("a session of a suspended account resolved to %v", got)
	}
}

// recorder stops the fixture at its first Fatal instead of failing the test.
type recorder struct {
	*testing.T
	fatal string
}

func (r *recorder) Fatal(args ...any) { r.fatal = fmt.Sprint(args...); runtime.Goexit() }

func (r *recorder) Fatalf(format string, args ...any) {
	r.fatal = fmt.Sprintf(format, args...)
	runtime.Goexit()
}

func TestASessionNeedsAnEnabledBinding(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	unbound := fixture.Account(t, s, fixture.AccountSpec{})
	if _, err := conn.Exec(t.Context(), `DELETE FROM external_identity WHERE user_id=$1`, unbound.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	r := &recorder{T: t}
	var secret string
	done := make(chan struct{})
	go func() {
		defer close(done)
		secret = fixture.Session(r, s, unbound.ID, fixture.SessionSpec{})
	}()
	<-done
	if r.fatal == "" {
		t.Errorf("a session without binding was handed out (%d characters)", len(secret))
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM application_session WHERE user_id=$1`, unbound.ID); got != 0 {
		t.Errorf("%d sessions stored", got)
	}
}

func TestAnAccountHasItsRolesAndBinding(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	before := scalar[int64](t, conn, `SELECT revision FROM authz_state WHERE singleton`)
	account := fixture.Account(t, s, fixture.AccountSpec{Email: "roles@example.test", Roles: []string{"hr.employee", "hr.admin"}})

	roles := scalar[[]string](t, conn, `SELECT array_agg(convert_from(role_key,'UTF8') ORDER BY role_key) FROM user_role WHERE user_id=$1`, account.ID)
	if !slices.Equal(roles, []string{"hr.admin", "hr.employee"}) {
		t.Errorf("roles %v", roles)
	}
	if after := scalar[int64](t, conn, `SELECT revision FROM authz_state WHERE singleton`); after <= before {
		t.Errorf("revision %d after %d: roles are security facts", after, before)
	}
	var email, state, kind, issuer, subject string
	var verified bool
	if err := conn.QueryRow(t.Context(),
		`SELECT u.email_canonical,u.state,u.kind,u.email_verified,e.issuer,e.subject FROM app_user u JOIN external_identity e ON e.user_id=u.id AND e.enabled WHERE u.id=$1`,
		account.ID).Scan(&email, &state, &kind, &verified, &issuer, &subject); err != nil {
		t.Fatal(test.Redact(err))
	}
	if email != account.Email || state != "active" || kind != "iam" || !verified || issuer != test.FixtureIssuer || subject != account.Subject {
		t.Errorf("account %s %s %s %t %s %s", email, state, kind, verified, issuer, subject)
	}

	bare := fixture.Account(t, s, fixture.AccountSpec{})
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM app_user WHERE id=$1 AND email_canonical IS NULL`, bare.ID); got != 1 {
		t.Error("an account without email got one")
	}
}

func TestAnEmployeeIsRegisteredAndLinked(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	linked := fixture.Employee(t, s, fixture.EmployeeSpec{Code: "NV-001", FullName: "Nhân viên một", AccountID: account.ID})
	alone := fixture.Employee(t, s, fixture.EmployeeSpec{})

	var code, name, hired, owner string
	if err := conn.QueryRow(t.Context(),
		`SELECT e.code,e.full_name,to_char(e.hired_on,'YYYY-MM-DD'),coalesce(e.account_id::text,'') FROM employee e
		   JOIN object_ref o ON o.object_id=e.object_id AND o.type_key=convert_to('employee','UTF8') AND o.key_bytes=convert_to(e.id::text,'UTF8')
		  WHERE e.id=$1 AND e.object_id=$2`, linked.ID, linked.ObjectID).Scan(&code, &name, &hired, &owner); err != nil {
		t.Fatal(test.Redact(err))
	}
	if code != "NV-001" || name != "Nhân viên một" || hired != linked.HiredOn || owner != account.ID {
		t.Errorf("employee %s %s %s %s", code, name, hired, owner)
	}
	if alone.Code == "" || alone.Code == linked.Code || alone.FullName == "" || alone.AccountID != "" {
		t.Errorf("defaults %+v", alone)
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM employee WHERE id=$1 AND account_id IS NULL`, alone.ID); got != 1 {
		t.Error("an employee without account got one")
	}
}

func TestTheRootIsBootstrappedByTheCommand(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	root := fixture.Root(t, s)

	var kind, state, email, operation, target string
	var verified, initialized bool
	if err := conn.QueryRow(t.Context(),
		`SELECT u.kind,u.state,u.email_canonical,u.email_verified,b.operation_id::text,b.target_user_id::text,b.initialized_at IS NOT NULL
		   FROM security_bootstrap_state b JOIN app_user u ON u.id=$1 WHERE b.singleton`, root.ID).
		Scan(&kind, &state, &email, &verified, &operation, &target, &initialized); err != nil {
		t.Fatal(test.Redact(err))
	}
	if kind != "root" || state != "active" || !verified || email != root.Email {
		t.Errorf("root %s %s %t %s", kind, state, verified, email)
	}
	if operation != root.OperationID || target != root.ID || !initialized {
		t.Errorf("marker %s %s %t", operation, target, initialized)
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM app_user WHERE kind='root'`); got != 1 {
		t.Errorf("%d roots", got)
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM oidc_email_enrollment WHERE user_id=$1`, root.ID); got != 0 {
		t.Errorf("%d enrollments of the Root left", got)
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM one_time_token WHERE user_id=$1 AND consumed_at IS NULL`, root.ID); got != 0 {
		t.Errorf("%d activation tokens left open", got)
	}
	if got := scalar[int](t, conn, `SELECT count(*)::int FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='root.bootstrap' AND safe_metadata->>'targetUserId'=$1`, root.ID); got != 1 {
		t.Errorf("%d bootstrap audit events", got)
	}

	session := fixture.Session(t, s, root.ID, fixture.SessionSpec{})
	if got := resolve(t, s, session); !slices.Equal(got, []resolved{{root.ID, "root", "active", false}}) {
		t.Errorf("root session %v", got)
	}
}
