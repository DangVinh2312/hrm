//go:build integration

package administration

import (
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	identityFacts   = `SELECT coalesce(email_canonical,'none')||' '||email_verified::text||' '||state||' '||auth_epoch::text FROM app_user WHERE id=$1`
	identityBinding = `SELECT string_agg(enabled::text||' '||binding_version::text, ',') FROM external_identity WHERE user_id=$1`
	identityInvites = `SELECT count(*)::text FROM oidc_email_enrollment WHERE user_id=$1`
	identityInvite  = `SELECT count(*)::text FROM oidc_email_enrollment WHERE user_id=$1 AND issuer=$2 AND email_canonical=$3 AND created_by=$4
    AND round(extract(epoch FROM expires_at-statement_timestamp())/86400)=7`
	identityFactors  = `SELECT ((SELECT count(*) FROM mfa_totp WHERE user_id=$1)+(SELECT count(*) FROM mfa_recovery_code WHERE user_id=$1))::text`
	identityPending  = `INSERT INTO app_user(id,email_canonical) VALUES($1,$2)`
	identityFactor   = `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('cd',12),'hex'),'k1')`
	identityConfirm  = `UPDATE mfa_totp SET confirmed_at=statement_timestamp() WHERE user_id=$1`
	identityCode     = `INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,sha256(convert_to(gen_random_uuid()::text,'UTF8')))`
	callChangeEmail  = `SELECT public.change_iam_account_email($1,$2,$3,$4)`
	callResetMfa     = `SELECT public.reset_iam_mfa($1)`
	callResetBinding = `SELECT public.reset_iam_google_binding($1,$2,$3)`
)

func oneText(t *testing.T, conn *pgx.Conn, sql string, args ...any) string {
	t.Helper()
	var value string
	if err := conn.QueryRow(t.Context(), sql, args...).Scan(&value); err != nil {
		t.Fatal(test.Redact(err))
	}
	return value
}

func newAccountID(t *testing.T, conn *pgx.Conn) string {
	t.Helper()
	return oneText(t, conn, `SELECT gen_random_uuid()::text`)
}

func asAuthority(t *testing.T, s *test.Stack, sql string, args ...any) {
	t.Helper()
	if _, err := s.Pools[database.PurposeAuthority].Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func epochText(epoch int) string {
	return strconv.Itoa(epoch)
}

func TestOnlyAuthorityExecutesTheIdentityFunctions(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	actor := fixture.Account(t, s, fixture.AccountSpec{}).ID
	target := fixture.Account(t, s, fixture.AccountSpec{Email: "kept@example.test"}).ID
	exec(t, conn, identityFactor, target)
	exec(t, conn, identityCode, target)
	before := oneText(t, conn, identityFacts, target)
	calls := map[string][]any{
		callChangeEmail:  {target, "moved@example.test", test.FixtureIssuer, actor},
		callResetMfa:     {target},
		callResetBinding: {target, test.FixtureIssuer, actor},
	}
	for _, purpose := range []database.Purpose{
		database.PurposeData, database.PurposeIdentity, database.PurposeSync, database.PurposeBootstrap, database.PurposeOutbox,
	} {
		for sql, args := range calls {
			if _, err := s.Pools[purpose].Exec(t.Context(), sql, args...); sqlState(err) != "42501" {
				t.Errorf("%s ran %s: %s", purpose, sql, test.Redact(err))
			}
		}
	}
	if after := oneText(t, conn, identityFacts, target); after != before {
		t.Errorf("the account moved from %q to %q", before, after)
	}
	if oneText(t, conn, identityFactors, target) != "2" || oneText(t, conn, identityBinding, target) != "true 1" {
		t.Error("a refused call reset the factor or the binding")
	}
}

func TestChangeEmailUnverifiesAndEndsTheSessionsOnce(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	actor := fixture.Account(t, s, fixture.AccountSpec{}).ID
	active := fixture.Account(t, s, fixture.AccountSpec{Email: "active@example.test"}).ID
	before := epochOf(t, conn, active)
	asAuthority(t, s, callChangeEmail, active, "moved@example.test", test.FixtureIssuer, actor)
	if got := oneText(t, conn, identityFacts, active); got != "moved@example.test false active "+epochText(before+1) {
		t.Errorf("active account after the change: %q", got)
	}
	if oneText(t, conn, identityInvites, active) != "0" || oneText(t, conn, identityBinding, active) != "true 1" {
		t.Error("an active account got an invitation or lost its binding")
	}

	pending := newAccountID(t, conn)
	exec(t, conn, identityPending, pending, "pending@example.test")
	asAuthority(t, s, callChangeEmail, pending, "repointed@example.test", test.FixtureIssuer, actor)
	if got := oneText(t, conn, identityFacts, pending); got != "repointed@example.test false pending 2" {
		t.Errorf("pending account after the change: %q", got)
	}
	if oneText(t, conn, identityInvite, pending, test.FixtureIssuer, "repointed@example.test", actor) != "1" {
		t.Error("a pending account has no seven-day invitation for its new email")
	}
}

func TestResetBindingDisablesItInvitesAndKeepsASuspension(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	actor := fixture.Account(t, s, fixture.AccountSpec{}).ID
	active := fixture.Account(t, s, fixture.AccountSpec{Email: "bound@example.test"}).ID
	suspended := fixture.Account(t, s, fixture.AccountSpec{Email: "held@example.test"}).ID
	exec(t, conn, `UPDATE app_user SET state='suspended' WHERE id=$1`, suspended)

	before := epochOf(t, conn, active)
	asAuthority(t, s, callResetBinding, active, test.FixtureIssuer, actor)
	if got := oneText(t, conn, identityFacts, active); got != "bound@example.test true pending "+epochText(before+1) {
		t.Errorf("active account after the reset: %q", got)
	}
	if oneText(t, conn, identityBinding, active) != "false 2" ||
		oneText(t, conn, identityInvite, active, test.FixtureIssuer, "bound@example.test", actor) != "1" {
		t.Error("the binding is not disabled with a new version, or no seven-day invitation")
	}

	before = epochOf(t, conn, suspended)
	asAuthority(t, s, callResetBinding, suspended, test.FixtureIssuer, actor)
	if got := oneText(t, conn, identityFacts, suspended); got != "held@example.test true suspended "+epochText(before+1) {
		t.Errorf("suspended account after the reset: %q", got)
	}
	if oneText(t, conn, identityBinding, suspended) != "false 2" {
		t.Error("the binding of a suspended account is still enabled")
	}
}

// A confirmed factor moves the epoch through the mfa_epoch trigger when it is deleted; the function moves it
// once more on its own, so an unconfirmed factor still ends the sessions.
func TestResetMfaMovesTheEpochItselfAndThroughAConfirmedFactor(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	unconfirmed := fixture.Account(t, s, fixture.AccountSpec{}).ID
	confirmed := fixture.Account(t, s, fixture.AccountSpec{}).ID
	exec(t, conn, identityFactor, unconfirmed)
	exec(t, conn, identityFactor, confirmed)
	exec(t, conn, identityConfirm, confirmed)
	exec(t, conn, identityCode, confirmed)

	for account, moves := range map[string]int{unconfirmed: 1, confirmed: 2} {
		before := epochOf(t, conn, account)
		asAuthority(t, s, callResetMfa, account)
		if after := epochOf(t, conn, account); after != before+moves {
			t.Errorf("the epoch moved from %d to %d, want %d moves", before, after, moves)
		}
		if oneText(t, conn, identityFactors, account) != "0" || oneText(t, conn, identityBinding, account) != "true 1" {
			t.Error("a factor or recovery code is left, or the binding changed")
		}
	}
}
