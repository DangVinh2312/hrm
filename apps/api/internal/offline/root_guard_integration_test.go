//go:build integration

package offline_test

import (
	"context"
	"crypto/rand"
	"errors"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	guardPending  = `INSERT INTO app_user(id,email_canonical) VALUES($1,$2)`
	guardPromote  = `UPDATE app_user SET kind='root' WHERE id=$1`
	guardDemote   = `UPDATE app_user SET kind='iam' WHERE id=$1`
	guardInsert   = `INSERT INTO app_user(id,state,kind) VALUES($1,'pending','root')`
	guardHoldRole = `INSERT INTO user_role(user_id,role_key) VALUES($1,convert_to('hr.employee','UTF8'))`
	guardMarker   = `UPDATE security_bootstrap_state SET operation_id=gen_random_uuid(),target_user_id=$1,initialized_at=statement_timestamp() WHERE singleton`
	guardToken    = `INSERT INTO one_time_token(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,statement_timestamp()+interval '1 minute')`
	guardRoots    = `SELECT count(*)::int FROM app_user WHERE kind='root'`
	guardState    = `SELECT state FROM app_user WHERE id=$1`

	createdByPromotion = "Root accounts are created only by promotion"
	offlineOnly        = "Root promotion is offline bootstrap only"
	readCommitted      = "Root promotion requires READ COMMITTED"
	mustBePending      = "Root promotion target must be pending"
	holdsFacts         = "Root promotion target holds IAM facts"
	liveToken          = "Root promotion target holds a live activation token"
	markerNaming       = "Root promotion requires the bootstrap marker naming it"
	kindImmutable      = "account kind is immutable except the one Root promotion"
	oneTime            = "Root promotion is one-time"
	outsideIAM         = "Root is outside IAM: no role, boundary, rule or exception"
	bootstrapNotIAM    = "bootstrap may not change IAM account lifecycle"
	bootstrapSuspends  = "bootstrap may only suspend Root, give it a new unverified email, or end its sessions after a second factor reset"
	offlineOrIdentity  = "Root lifecycle is offline or identity only"
	identityActivates  = "identity may only activate pending accounts"
	bootstrapIssues    = "Root activation is issued by the bootstrap credential only"
	consumedOnce       = "one-time tokens may only be consumed"
	activationPurpose  = "oidc-activation"
)

type guardStep struct {
	sql  string
	args []any
}

// guardWorld reaches the triggers past the column privileges with the owner login, and promotes with the
// bootstrap login on a connection of its own, as the offline command does.
type guardWorld struct {
	s         *test.Stack
	super     *pgx.Conn
	owner     *pgx.Conn
	bootstrap *pgx.Conn
}

func loginConn(t *testing.T, s *test.Stack, login string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), s.LoginURL(login)+"?sslmode=disable")
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	return conn
}

func newGuardWorld(t *testing.T) *guardWorld {
	t.Helper()
	s := test.NewDatabase(t)
	return &guardWorld{s: s, super: superuserConn(t, s), owner: loginConn(t, s, "migration"), bootstrap: loginConn(t, s, "bootstrap")}
}

func (w *guardWorld) newID(t *testing.T) string {
	t.Helper()
	var id string
	if err := w.super.QueryRow(t.Context(), `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatal(test.Redact(err))
	}
	return id
}

func (w *guardWorld) pending(t *testing.T) string {
	t.Helper()
	id := w.newID(t)
	connExec(t, w.super, guardPending, id, "p-"+id+"@example.test")
	return id
}

func (w *guardWorld) state(t *testing.T, id string) string {
	t.Helper()
	var state string
	if err := w.super.QueryRow(t.Context(), guardState, id).Scan(&state); err != nil {
		t.Fatal(test.Redact(err))
	}
	return state
}

func (w *guardWorld) run(t *testing.T, purpose database.Purpose, sql string, args ...any) error {
	_, err := w.s.Pools[purpose].Exec(t.Context(), sql, args...)
	return err
}

func transact(t *testing.T, conn *pgx.Conn, level pgx.TxIsoLevel, steps ...guardStep) error {
	t.Helper()
	tx, err := conn.BeginTx(t.Context(), pgx.TxOptions{IsoLevel: level})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	for _, step := range steps {
		if _, err := tx.Exec(t.Context(), step.sql, step.args...); err != nil {
			if rollback := tx.Rollback(t.Context()); rollback != nil {
				t.Fatal(test.Redact(rollback))
			}
			return err
		}
	}
	return tx.Commit(t.Context())
}

func connRun(t *testing.T, conn *pgx.Conn, sql string, args ...any) error {
	_, err := conn.Exec(t.Context(), sql, args...)
	return err
}

// refused checks the SQLSTATE and, when given, the exact message the guard raises: a refusal by another
// layer (a column privilege, the unique index, the deferred marker check) must not pass for the guard.
func refused(t *testing.T, name string, err error, code, message string) {
	t.Helper()
	var driver *pgconn.PgError
	if !errors.As(err, &driver) {
		t.Errorf("%s: want %s %q, got %s", name, code, message, test.Redact(err))
		return
	}
	if driver.Code != code || (message != "" && driver.Message != message) {
		t.Errorf("%s: want %s %q, got %s %q", name, code, message, driver.Code, driver.Message)
	}
}

func freshDigest(t *testing.T) []byte {
	t.Helper()
	digest := make([]byte, 32)
	if _, err := rand.Read(digest); err != nil {
		t.Fatal(err)
	}
	return digest
}

func TestRootPromotionIsTheBootstrapUpdateOfAFactFreePendingAccount(t *testing.T) {
	w := newGuardWorld(t)
	target := w.pending(t)
	for purpose := range w.s.Pools {
		refused(t, string(purpose)+" insert", w.run(t, purpose, guardInsert, w.newID(t)), "42501", "")
		if purpose == database.PurposeBootstrap {
			continue
		}
		refused(t, string(purpose)+" promotion", w.run(t, purpose, guardPromote, target), "42501", "")
	}
	refused(t, "owner insert", connRun(t, w.owner, guardInsert, w.newID(t)), "42501", createdByPromotion)
	refused(t, "owner promotion", connRun(t, w.owner, guardPromote, target), "42501", offlineOnly)
	refused(t, "repeatable read", transact(t, w.bootstrap, pgx.RepeatableRead, guardStep{guardPromote, []any{target}}), "42501", readCommitted)

	active := fixture.Account(t, w.s, fixture.AccountSpec{}).ID
	refused(t, "active target", transact(t, w.bootstrap, pgx.ReadCommitted, guardStep{guardPromote, []any{active}}), "42501", mustBePending)
	holder := w.pending(t)
	connExec(t, w.super, guardHoldRole, holder)
	refused(t, "role holder", transact(t, w.bootstrap, pgx.ReadCommitted, guardStep{guardPromote, []any{holder}}), "42501", holdsFacts)
	invited := w.pending(t)
	if err := connRun(t, w.bootstrap, guardToken, freshDigest(t), invited, activationPurpose); err != nil {
		t.Fatal(test.Redact(err))
	}
	refused(t, "invited target", transact(t, w.bootstrap, pgx.ReadCommitted, guardStep{guardPromote, []any{invited}}), "42501", liveToken)

	refused(t, "no marker", transact(t, w.bootstrap, pgx.ReadCommitted, guardStep{guardPromote, []any{target}}), "42501", markerNaming)
	other := w.pending(t)
	refused(t, "a marker naming another account", transact(t, w.bootstrap, pgx.ReadCommitted,
		guardStep{guardPromote, []any{target}}, guardStep{guardMarker, []any{other}}), "42501", markerNaming)
	if superCount(t, w.super, guardRoots) != 0 ||
		superCount(t, w.super, `SELECT count(*)::int FROM security_bootstrap_state WHERE initialized_at IS NOT NULL`) != 0 {
		t.Fatal("a refused promotion left a Root or a marker")
	}
}

func TestTheOneRootStaysRootAndOutsideIAM(t *testing.T) {
	w := newGuardWorld(t)
	root := fixture.Root(t, w.s).ID
	next := w.pending(t)
	refused(t, "bootstrap demotion", transact(t, w.bootstrap, pgx.ReadCommitted, guardStep{guardDemote, []any{root}}), "42501", kindImmutable)
	refused(t, "owner demotion", connRun(t, w.owner, guardDemote, root), "42501", kindImmutable)
	refused(t, "second promotion", transact(t, w.bootstrap, pgx.ReadCommitted, guardStep{guardPromote, []any{next}}), "42501", oneTime)
	refused(t, "owner insert", connRun(t, w.owner, guardInsert, w.newID(t)), "42501", createdByPromotion)
	refused(t, "a role of Root", connRun(t, w.super, guardHoldRole, root), "42501", outsideIAM)

	output, err := w.s.Hrmctl(t.Context(), "bootstrap", "--operation", w.newID(t), "--issuer", test.FixtureIssuer,
		"--email", "second@example.test", "--activation-file", filepath.Join(t.TempDir(), "activation"))
	if err == nil {
		t.Fatalf("a second bootstrap committed:\n%s", output)
	}
	if superCount(t, w.super, guardRoots) != 1 || superCount(t, w.super, `SELECT count(*)::int FROM app_user`) != 2 ||
		superCount(t, w.super, `SELECT count(*)::int FROM oidc_email_enrollment`) != 0 ||
		superCount(t, w.super, `SELECT count(*)::int FROM one_time_token WHERE consumed_at IS NULL`) != 0 ||
		superCount(t, w.super, `SELECT count(*)::int FROM app_user WHERE id=$1 AND kind='iam' AND state='pending'`, next) != 1 {
		t.Fatal("a refused promotion or bootstrap wrote")
	}
}

func TestTheRootLifecycleIsOfflineOrIdentityOnly(t *testing.T) {
	w := newGuardWorld(t)
	root := fixture.Root(t, w.s).ID
	member := fixture.Account(t, w.s, fixture.AccountSpec{}).ID
	authority, identity := database.PurposeAuthority, database.PurposeIdentity
	const (
		suspend    = `UPDATE app_user SET state='suspended' WHERE id=$1`
		endSession = `UPDATE app_user SET auth_epoch=auth_epoch+1 WHERE id=$1`
		revoke     = `UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`
		reactivate = `UPDATE app_user SET state='active',auth_epoch=auth_epoch+1 WHERE id=$1`
	)
	for _, sql := range []string{suspend, endSession} {
		refused(t, "bootstrap on IAM: "+sql, connRun(t, w.bootstrap, sql, member), "42501", bootstrapNotIAM)
		refused(t, "authority on Root: "+sql, w.run(t, authority, sql, root), "42501", offlineOrIdentity)
	}
	for _, purpose := range []database.Purpose{database.PurposeData, database.PurposeSync, database.PurposeOutbox} {
		refused(t, string(purpose)+" on Root", w.run(t, purpose, suspend, root), "42501", "")
	}
	refused(t, "a Root suspension keeping the epoch", connRun(t, w.bootstrap, suspend, root), "42501", bootstrapSuspends)
	if err := connRun(t, w.bootstrap, revoke, root); err != nil {
		t.Fatal(test.Redact(err))
	}
	refused(t, "identity lifts it", w.run(t, identity, reactivate, root), "42501", identityActivates)
	refused(t, "bootstrap lifts it", connRun(t, w.bootstrap, reactivate, root), "42501", bootstrapSuspends)
	refused(t, "authority lifts it", w.run(t, authority, reactivate, root), "42501", offlineOrIdentity)
	if got := w.state(t, root); got != "suspended" {
		t.Errorf("Root is %s", got)
	}
}

func TestOneTimeTokensAreIssuedByBootstrapAndOnlyConsumedOnce(t *testing.T) {
	w := newGuardWorld(t)
	root := fixture.Root(t, w.s).ID
	member := fixture.Account(t, w.s, fixture.AccountSpec{}).ID
	identity := database.PurposeIdentity
	for _, user := range []string{root, member} {
		refused(t, "identity issues a token", w.run(t, identity, guardToken, freshDigest(t), user, activationPurpose), "42501", "")
	}
	refused(t, "owner issues a Root activation", connRun(t, w.owner, guardToken, freshDigest(t), root, activationPurpose), "42501", bootstrapIssues)
	refused(t, "another purpose", connRun(t, w.owner, guardToken, freshDigest(t), member, "activation"), "23514", "")
	token, other := freshDigest(t), freshDigest(t)
	for _, step := range []guardStep{
		{guardToken, []any{freshDigest(t), root, activationPurpose}},
		{guardToken, []any{token, member, activationPurpose}},
		{guardToken, []any{other, member, activationPurpose}},
	} {
		if err := connRun(t, w.bootstrap, step.sql, step.args...); err != nil {
			t.Fatal(test.Redact(err))
		}
	}

	const consume = `UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE token_hash=$1`
	refused(t, "a consumption at another time",
		w.run(t, identity, `UPDATE one_time_token SET consumed_at=statement_timestamp()+interval '1 second' WHERE token_hash=$1`, token), "42501", consumedOnce)
	if err := w.run(t, identity, consume, token); err != nil {
		t.Fatal(test.Redact(err))
	}
	refused(t, "a second consumption", w.run(t, identity, consume, token), "42501", consumedOnce)
	refused(t, "an undone consumption", w.run(t, identity, `UPDATE one_time_token SET consumed_at=NULL WHERE token_hash=$1`, token), "42501", consumedOnce)
	refused(t, "a longer life", connRun(t, w.owner, `UPDATE one_time_token SET expires_at=expires_at+interval '1 day' WHERE token_hash=$1`, other), "42501", consumedOnce)
	if superCount(t, w.super, `SELECT count(*)::int FROM one_time_token WHERE token_hash=$1 AND consumed_at IS NOT NULL`, token) != 1 {
		t.Error("the consumed token is not consumed")
	}
}
