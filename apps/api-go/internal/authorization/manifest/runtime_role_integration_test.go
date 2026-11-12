//go:build integration

package manifest_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	runtimeInsertRole = `INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to(CAST($1 AS text),'UTF8'),$2,'Fixture')`
	runtimeDeleteRole = `DELETE FROM role_definition WHERE role_key=convert_to(CAST($1 AS text),'UTF8')`
	runtimeInsertRule = `INSERT INTO policy_rule(rule_id,permission_key,user_id,role_key,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to('account.read','UTF8'),CAST($1 AS uuid),convert_to(CAST($2 AS text),'UTF8'),$3,convert_to('allAccounts','UTF8'),1,'{}',$4)`
	runtimeHold       = `INSERT INTO user_role(user_id,role_key) VALUES(CAST($1 AS uuid),convert_to(CAST($2 AS text),'UTF8'))`
	runtimeOnlyAllows = "authority may only write allow rules of runtime roles"
)

type runtimeLogin interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type runtimeRule struct{ user, role, effect, managedBy string }

func (r runtimeRule) args() []any {
	args := []any{nil, nil, "allow", "runtime"}
	if r.user != "" {
		args[0] = r.user
	}
	if r.role != "" {
		args[1] = r.role
	}
	if r.effect != "" {
		args[2] = r.effect
	}
	if r.managedBy != "" {
		args[3] = r.managedBy
	}
	return args
}

type runtimeWorld struct {
	s         *test.Stack
	super     *pgx.Conn
	owner     *pgx.Conn
	authority runtimeLogin
	sync      runtimeLogin
}

func newRuntimeWorld(t *testing.T) *runtimeWorld {
	t.Helper()
	w := &runtimeWorld{s: test.NewDatabase(t)}
	w.authority, w.sync = w.s.Pools[database.PurposeAuthority], w.s.Pools[database.PurposeSync]
	var err error
	if w.super, err = w.s.Cluster.ConnectSuperuser(t.Context(), w.s.Database); err != nil {
		t.Fatal(test.Redact(err))
	}
	if w.owner, err = pgx.Connect(t.Context(), w.s.LoginURL("migration")+"?sslmode=disable"); err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		ctx := context.WithoutCancel(t.Context())
		if err := errors.Join(w.super.Close(ctx), w.owner.Close(ctx)); err != nil {
			t.Error(test.Redact(err))
		}
	})
	return w
}

func (w *runtimeWorld) must(t *testing.T, login runtimeLogin, sql string, args ...any) {
	t.Helper()
	if _, err := login.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

// refused is the SQLSTATE, the constraint and the message PostgreSQL refused the statement with.
func (w *runtimeWorld) refused(t *testing.T, login runtimeLogin, sql string, args ...any) *pgconn.PgError {
	t.Helper()
	_, err := login.Exec(t.Context(), sql, args...)
	refusal, ok := errors.AsType[*pgconn.PgError](err)
	if !ok {
		t.Fatalf("the statement was not refused by PostgreSQL: %s", test.Redact(err))
	}
	return refusal
}

func (w *runtimeWorld) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := w.super.QueryRow(t.Context(), sql, args...).Scan(&n); err != nil {
		t.Fatal(test.Redact(err))
	}
	return n
}

// hashes are the hash of the protected rows as the reconciler computes it and the one authz_state publishes.
func (w *runtimeWorld) hashes(t *testing.T) (string, string) {
	t.Helper()
	computed, err := database.Run(t.Context(), w.s.Runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (string, error) {
		return manifest.ProtectedStateHash(tx)
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	var published string
	if err := w.super.QueryRow(t.Context(), `SELECT encode(materialized_hash,'hex') FROM authz_state WHERE singleton`).Scan(&published); err != nil {
		t.Fatal(test.Redact(err))
	}
	return computed, published
}

func TestTheReleaseHoldsNoRuntimeRoleAndOnlyAuthorityCreatesOne(t *testing.T) {
	w := newRuntimeWorld(t)
	if roles := w.count(t, `SELECT count(*)::int FROM role_definition`); roles == 0 {
		t.Fatal("the release has no role")
	}
	for name, sql := range map[string]string{
		"roles not owned by the release":   `SELECT count(*)::int FROM role_definition WHERE managed_by<>'code'`,
		"roles under the runtime prefix":   `SELECT count(*)::int FROM role_definition WHERE substring(role_key FROM 1 FOR 7)=convert_to('custom.','UTF8')`,
		"rows the constraint would refuse": `SELECT count(*)::int FROM role_definition WHERE (managed_by='runtime') <> (substring(role_key FROM 1 FOR 7)=convert_to('custom.','UTF8'))`,
		"runtime rules":                    `SELECT count(*)::int FROM policy_rule WHERE managed_by='runtime'`,
		"constraints not validated":        `SELECT count(*)::int FROM pg_constraint WHERE conname='ck_role_runtime_prefix' AND conrelid='role_definition'::regclass AND NOT convalidated`,
	} {
		if n := w.count(t, sql); n != 0 {
			t.Errorf("%s: %d", name, n)
		}
	}
	if n := w.count(t, `SELECT count(*)::int FROM pg_constraint WHERE conname='ck_role_runtime_prefix' AND conrelid='role_definition'::regclass`); n != 1 {
		t.Errorf("%d constraints named ck_role_runtime_prefix", n)
	}
	var columns string
	if err := w.super.QueryRow(t.Context(), `SELECT string_agg(column_name::text,',' ORDER BY column_name) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='role_definition'`).Scan(&columns); err != nil || columns != "label,managed_by,role_key" {
		t.Errorf("the columns of role_definition: %s, %s", columns, test.Redact(err))
	}

	w.must(t, w.authority, runtimeInsertRole, "custom.assumption", "runtime")
	if refusal := w.refused(t, w.sync, runtimeInsertRole, "custom.sync_attempt", "runtime"); refusal.Code != "42501" {
		t.Errorf("a runtime role inserted by the sync login: SQLSTATE %s", refusal.Code)
	}
	if n := w.count(t, `SELECT count(*)::int FROM role_definition WHERE managed_by='runtime'`); n != 1 {
		t.Errorf("%d runtime roles after one insert by authority and one by sync", n)
	}
}

func TestOnlyARuntimeRoleTakesTheCustomPrefix(t *testing.T) {
	w := newRuntimeWorld(t)
	for _, attempt := range []struct {
		key, managedBy string
		login          runtimeLogin
	}{
		{"noprefix", "runtime", w.owner}, {"custom", "runtime", w.owner}, {"system.x", "runtime", w.owner}, {"custom.coded", "code", w.sync},
	} {
		refusal := w.refused(t, attempt.login, runtimeInsertRole, attempt.key, attempt.managedBy)
		if refusal.Code != "23514" || refusal.ConstraintName != "ck_role_runtime_prefix" {
			t.Errorf("%s as %s: SQLSTATE %s, constraint %q", attempt.key, attempt.managedBy, refusal.Code, refusal.ConstraintName)
		}
	}
	w.must(t, w.owner, runtimeInsertRole, "custom.fine", "runtime")
	rename := `UPDATE role_definition SET role_key=convert_to('renamed','UTF8') WHERE role_key=convert_to('custom.fine','UTF8')`
	if refusal := w.refused(t, w.owner, rename); refusal.Code != "23514" || refusal.ConstraintName != "ck_role_runtime_prefix" {
		t.Errorf("a runtime role renamed out of the prefix: SQLSTATE %s, constraint %q", refusal.Code, refusal.ConstraintName)
	}
	if n := w.count(t, `SELECT count(*)::int FROM role_definition WHERE managed_by='runtime'`); n != 1 {
		t.Errorf("%d runtime roles, want only custom.fine", n)
	}
}

func TestAuthorityWritesOnlyAllowRulesOfRuntimeRoles(t *testing.T) {
	w := newRuntimeWorld(t)
	role := "custom.authority_rules"
	user := fixture.Account(t, w.s, fixture.AccountSpec{}).ID
	w.must(t, w.authority, runtimeInsertRole, role, "runtime")
	w.must(t, w.authority, runtimeInsertRule, runtimeRule{role: role}.args()...)

	for name, rule := range map[string]runtimeRule{
		"a deny":                       {role: role, effect: "deny"},
		"a rule attached to a user":    {user: user},
		"a rule owned by the release":  {role: role, managedBy: "code"},
		"an allow rule of a code role": {role: "hr.admin"},
	} {
		if refusal := w.refused(t, w.authority, runtimeInsertRule, rule.args()...); refusal.Code != "42501" {
			t.Errorf("%s inserted by authority: SQLSTATE %s", name, refusal.Code)
		}
	}
	turn := `UPDATE policy_rule SET effect='deny' WHERE role_key=convert_to(CAST($1 AS text),'UTF8')`
	if refusal := w.refused(t, w.authority, turn, role); refusal.Code != "42501" || refusal.Message != runtimeOnlyAllows {
		t.Errorf("an allow rule turned into a deny by authority: SQLSTATE %s", refusal.Code)
	}
	stored := `SELECT count(*)::int FROM policy_rule WHERE managed_by='runtime' AND effect='allow' AND role_key=convert_to(CAST($1 AS text),'UTF8')`
	if n := w.count(t, stored, role); n != 1 || w.count(t, `SELECT count(*)::int FROM policy_rule WHERE managed_by='runtime'`) != 1 {
		t.Errorf("%d allow rules of the role after five refused writes", n)
	}
	w.must(t, w.authority, `DELETE FROM policy_rule WHERE role_key=convert_to(CAST($1 AS text),'UTF8')`, role)
	if n := w.count(t, stored, role); n != 0 {
		t.Errorf("%d rules after the delete by authority", n)
	}
}

// With protect_product_rows off, what refuses these two rows is protect_role_rules alone.
func TestTheRuleTriggerOfAuthorityRefusesOnItsOwn(t *testing.T) {
	w := newRuntimeWorld(t)
	w.must(t, w.sync, runtimeInsertRole, "plain.trigger_only", "code")
	w.must(t, w.owner, runtimeInsertRole, "custom.trigger_only", "runtime")
	w.must(t, w.owner, `ALTER TABLE policy_rule DISABLE TRIGGER protect_product_rows`)
	for name, rule := range map[string]runtimeRule{
		"a runtime rule of a code role":            {role: "plain.trigger_only"},
		"a rule owned by the release under custom": {role: "custom.trigger_only", managedBy: "code"},
	} {
		if refusal := w.refused(t, w.authority, runtimeInsertRule, rule.args()...); refusal.Code != "42501" || refusal.Message != runtimeOnlyAllows {
			t.Errorf("%s: SQLSTATE %s", name, refusal.Code)
		}
	}
	w.must(t, w.authority, runtimeInsertRule, runtimeRule{role: "custom.trigger_only"}.args()...)
	if n := w.count(t, `SELECT count(*)::int FROM policy_rule WHERE role_key IN (convert_to('plain.trigger_only','UTF8'),convert_to('custom.trigger_only','UTF8'))`); n != 1 {
		t.Errorf("%d rules of the two roles, want the one allow rule", n)
	}
}

func TestTheOwnerSeedsWhatAuthorityMayNotWrite(t *testing.T) {
	w := newRuntimeWorld(t)
	user := fixture.Account(t, w.s, fixture.AccountSpec{}).ID
	w.must(t, w.owner, runtimeInsertRole, "custom.owner_rules", "runtime")
	w.must(t, w.owner, runtimeInsertRule, runtimeRule{role: "custom.owner_rules", effect: "deny"}.args()...)
	w.must(t, w.owner, runtimeInsertRule, runtimeRule{user: user}.args()...)
	if n := w.count(t, `SELECT count(*)::int FROM policy_rule WHERE managed_by='runtime' AND (effect='deny' OR user_id IS NOT NULL)`); n != 2 {
		t.Errorf("%d deny or user rules written by the owner, want 2", n)
	}
}

func TestARuntimeRoleIsOutsideTheHashAndSurvivesEverySync(t *testing.T) {
	w := newRuntimeWorld(t)
	before, published := w.hashes(t)
	if before != published {
		t.Fatal("the fixture is not at its published hash")
	}
	role := "custom.sync_keeps"
	holder := fixture.Account(t, w.s, fixture.AccountSpec{}).ID
	_, err := database.Run(t.Context(), w.s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		if _, err := tx.Exec(runtimeInsertRole, role, "runtime"); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(runtimeInsertRule, runtimeRule{role: role}.args()...); err != nil {
			return struct{}{}, err
		}
		_, err := tx.Exec(runtimeHold, holder, role)
		return struct{}{}, err
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	kept := func(stage string) {
		t.Helper()
		var label string
		var rules, holders int
		err := w.super.QueryRow(t.Context(), `SELECT d.label,
              (SELECT count(*)::int FROM policy_rule r WHERE r.role_key=d.role_key AND r.managed_by='runtime'),
              (SELECT count(*)::int FROM user_role u WHERE u.role_key=d.role_key AND u.user_id=$2)
         FROM role_definition d WHERE d.role_key=convert_to(CAST($1 AS text),'UTF8') AND d.managed_by='runtime'`, role, holder).Scan(&label, &rules, &holders)
		if err != nil || label != "Fixture" || rules != 1 || holders != 1 {
			t.Errorf("%s: the runtime role is %q with %d rules and %d holders, %s", stage, label, rules, holders, test.Redact(err))
		}
	}
	if computed, _ := w.hashes(t); computed != before {
		t.Error("a runtime role, its rule and its holder moved the hash")
	}

	same, err := reconcile(t.Context(), w.s.Runner, productRelease(t, declarations.Source()))
	if err != nil || same.Changed {
		t.Fatalf("the same release over runtime rows: changed %t, %s", same.Changed, test.Redact(err))
	}
	if computed, published := w.hashes(t); computed != before || published != before {
		t.Error("a sync of the same release moved the hash")
	}
	kept("after the same release")

	next := declarations.Source()
	next.Sequence, next.Predecessor = "7", "6"
	next.Roles = append(next.Roles, manifest.Role{Key: "added.by.release", Label: "Added"})
	upgraded, err := reconcile(t.Context(), w.s.Runner, productRelease(t, next))
	if err != nil || !upgraded.Changed {
		t.Fatalf("the next release: changed %t, %s", upgraded.Changed, test.Redact(err))
	}
	kept("after the next release")
	computed, published := w.hashes(t)
	if computed != published {
		t.Error("the next release did not publish the hash of the code rows")
	}
	if computed == before {
		t.Error("the role the release added did not move the hash")
	}
}
