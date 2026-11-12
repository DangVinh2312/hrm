//go:build integration

package authentication_test

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authentication"
	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	storedSession = `SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'|'||
    extract(epoch FROM expires_at-created_at)::int||'|'||
    extract(epoch FROM authenticated_at)::bigint||'|'||
    (authenticated_at=created_at)::text||'|'||
    (reauthenticated_at IS NOT NULL)::text
  FROM application_session WHERE token_hash=$1`
	databaseSeconds    = `SELECT floor(extract(epoch FROM statement_timestamp()))::bigint`
	reauthenticatedAgo = `UPDATE application_session SET reauthenticated_at=statement_timestamp()-$2::interval WHERE token_hash=$1`
	storedDigest       = `SELECT token_hash FROM application_session WHERE user_id=$1`
	sessionsOf         = `SELECT count(*)::int FROM application_session WHERE user_id=$1`
	disableProvider    = `UPDATE oidc_provider SET enabled=false,version=version+1 WHERE issuer=$1`
	epochOf            = `SELECT auth_epoch::text FROM app_user WHERE id=$1`
	revokeAudit        = `REVOKE INSERT ON audit_outbox FROM product_identity`
	grantAudit         = `GRANT INSERT ON audit_outbox TO product_identity`
	tamperSecret       = `UPDATE mfa_totp SET secret_ciphertext=decode(repeat('cd',36),'hex') WHERE user_id=$1`

	resetAccountRow     = `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES(gen_random_uuid(),$1,true,'active') RETURNING id::text`
	resetBindingRow     = `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`
	resetDisableBinding = `UPDATE external_identity SET enabled=false,binding_version=binding_version+1 WHERE user_id=$1`
	resetState          = `UPDATE app_user SET state=$2,auth_epoch=auth_epoch+1 WHERE id=$1`
	resetEnrollment     = `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by) VALUES($1,$2,$3,statement_timestamp()+interval '7 days',$1)`
	resetFacts          = `SELECT u.state||'|'||
    (SELECT count(*) FROM external_identity e WHERE e.user_id=u.id AND e.enabled)||'|'||
    (SELECT string_agg(subject,',' ORDER BY subject) FROM external_identity e WHERE e.user_id=u.id)||'|'||
    (SELECT count(*) FROM oidc_email_enrollment n WHERE n.user_id=u.id)
  FROM app_user u WHERE u.id=$1`

	rootFacts       = `SELECT u.state||'|'||u.kind||'|'||u.email_verified||'|'||u.auth_epoch||'|'||(SELECT count(*) FROM external_identity e WHERE e.user_id=u.id AND e.enabled) FROM app_user u WHERE u.id=$1`
	activationEvent = `SELECT count(*)::int FROM audit_outbox WHERE event_kind=$1 AND actor_id=$2 AND NOT safe_metadata::text LIKE '%@%'`
)

func TestTheDatabaseKeepsOnlyTheDigestOfASession(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	stored := queryOne[[]byte](t, conn, storedDigest, account.ID)
	if string(stored) != string(digestOf(t, secret)) || strings.Contains(string(stored), secret) {
		t.Errorf("stored %x", stored)
	}
}

func TestSessionsAndTheFreshWindowFollowTheDatabaseClock(t *testing.T) {
	o := newOidcStack(t)
	account := fixture.Account(t, o.s, fixture.AccountSpec{})
	at := queryOne[int64](t, o.conn, databaseSeconds) - 10
	session, err := o.signIn(t, account.Subject, rawClaims{"auth_time": strconv.FormatInt(at, 10)})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	want := session.ExpiresAt + "|43200|" + strconv.FormatInt(at, 10) + "|false|false"
	if row := queryOne[string](t, o.conn, storedSession, digestOf(t, session.Secret)); row != want || session.MaxAge != 43200 {
		t.Errorf("max age %d, row %s, want %s", session.MaxAge, row, want)
	}
	if fresh(t, o.s, session.Secret) {
		t.Error("a login made the session fresh")
	}
	implicit, err := o.signIn(t, account.Subject, nil)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if row := queryOne[string](t, o.conn, storedSession, digestOf(t, implicit.Secret)); !strings.HasSuffix(row, "|true|false") {
		t.Errorf("no auth_time: %s", row)
	}
	now := queryOne[int64](t, o.conn, databaseSeconds)
	for _, authTime := range []string{
		strconv.FormatInt(now-10, 10) + ".5", "9007199254740992", "9007199254740991", "-1", `"` + strconv.FormatInt(now, 10) + `"`,
	} {
		if _, err := o.signIn(t, account.Subject, rawClaims{"auth_time": authTime}); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("auth_time %s: %v", authTime, err)
		}
	}
	digest := digestOf(t, session.Secret)
	for _, age := range []string{"300 seconds", "-60 seconds"} {
		exec(t, o.conn, reauthenticatedAgo, digest, age)
		if fresh(t, o.s, session.Secret) {
			t.Errorf("fresh %s ago", age)
		}
	}
	exec(t, o.conn, reauthenticatedAgo, digest, "290 seconds")
	if !fresh(t, o.s, session.Secret) {
		t.Error("not fresh 290 seconds ago")
	}
}

func TestAProviderRevokedDuringTheExchangeGetsNoSession(t *testing.T) {
	p := newIDP(t)
	o := newOidcStackAt(t, p)
	account := fixture.Account(t, o.s, fixture.AccountSpec{})
	entered, release := make(chan struct{}), make(chan struct{})
	p.route("/token", func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		p.token(w, r)
	})
	browser := credential.NewSessionSecret()
	authorization, err := o.service.Begin(t.Context(), test.FixtureIssuer, browser, oidcClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	callback := p.authorize(t, authorization, account.Subject, nil)
	finished := make(chan error, 1)
	go func() {
		_, err := o.service.Callback(context.WithoutCancel(t.Context()), callback, browser)
		finished <- err
	}()
	<-entered
	exec(t, o.conn, disableProvider, test.FixtureIssuer)
	close(release)
	if err := <-finished; !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("%v", err)
	}
	if count := queryOne[int32](t, o.conn, sessionsOf, account.ID); count != 0 {
		t.Errorf("%d sessions", count)
	}
}

func TestAFailedAuditRollsTheConfirmationBack(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	setup, err := mfa.Setup(t.Context(), secret, mfaClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	before := queryOne[string](t, conn, epochOf, account.ID)
	exec(t, conn, revokeAudit)
	_, err = mfa.Confirm(t.Context(), secret, codeAt(t, setup.Secret, stepNow(t, conn)), mfaClient)
	exec(t, conn, grantAudit)
	if err == nil || errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("%v", err)
	}
	if !queryOne[bool](t, conn, factorUnconfirmed, account.ID) || queryOne[string](t, conn, epochOf, account.ID) != before {
		t.Error("the confirmation stayed without its event")
	}
	if _, err := resolve(t, s, database.ModeRead, secret); err != nil {
		t.Errorf("the session ended: %s", test.Redact(err))
	}
}

func TestAFailedAuditRollsACountedFailureBack(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	totp, _, step := enrolled(t, s, mfa, account.ID)
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	exec(t, conn, revokeAudit)
	_, err := mfa.Verify(t.Context(), secret, authentication.MfaProof{Code: codeAt(t, totp, step+5)}, mfaClient)
	exec(t, conn, grantAudit)
	if err == nil || errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("a 401 without its event: %v", err)
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 0 {
		t.Errorf("%d failures counted", n)
	}
	if n := queryOne[int32](t, conn, countEvents, []byte("identity.mfa-verify-failed"), account.ID); n != 0 {
		t.Errorf("%d events", n)
	}
	if _, err := resolve(t, s, database.ModeRead, secret); err != nil {
		t.Errorf("the session ended: %s", test.Redact(err))
	}
}

func TestAVerifyReencryptsAndATamperedSecretIsAFault(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	mfa := authentication.NewMfaService(service, keyRing(t, "k1", "k1"))
	rotated := authentication.NewMfaService(service, keyRing(t, "k2", "k1", "k2"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	totp, _, step := enrolled(t, s, mfa, account.ID)
	if _, err := rotated.Verify(t.Context(), fixture.Session(t, s, account.ID, fixture.SessionSpec{}), authentication.MfaProof{Code: codeAt(t, totp, step+1)}, mfaClient); err != nil {
		t.Fatal(test.Redact(err))
	}
	if key := queryOne[string](t, conn, keyIDOf, account.ID); key != "k2" {
		t.Errorf("key %s after a verify under the new key", key)
	}
	exec(t, conn, tamperSecret, account.ID)
	victim := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	_, err := rotated.Verify(t.Context(), victim, authentication.MfaProof{Code: codeAt(t, totp, step+1)}, mfaClient)
	if err == nil || errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("a tampered secret: %v", err)
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 0 {
		t.Errorf("%d failures counted", n)
	}
	if fresh(t, s, victim) {
		t.Error("a tampered secret stepped up")
	}
}

func TestTheLimitOfTheSecondFactorRefusesBeforeAnyFencedWork(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	mfa := authentication.NewMfaService(authentication.NewService(s.Runner), keyRing(t, "k1", "k1"))
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	client := func(n int) string { return "203.0.113." + strconv.Itoa(n) }
	for n := 1; n <= 20; n++ {
		if _, err := mfa.Setup(t.Context(), secret, client(n)); err != nil {
			t.Fatalf("setup %d: %s", n, test.Redact(err))
		}
	}
	if _, err := mfa.Setup(t.Context(), secret, client(21)); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("the 21st setup: %v", err)
	}
	if _, err := mfa.Verify(t.Context(), secret, authentication.MfaProof{Code: "123456"}, client(22)); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("a verify past the limit: %v", err)
	}
	if n := queryOne[int32](t, conn, countEvents, []byte("identity.mfa-setup"), account.ID); n != 20 {
		t.Errorf("%d setups audited", n)
	}
	if n := queryOne[int32](t, conn, failedOf, account.ID); n != 0 {
		t.Errorf("%d failures counted", n)
	}
	other := fixture.Account(t, s, fixture.AccountSpec{})
	if _, err := mfa.Setup(t.Context(), fixture.Session(t, s, other.ID, fixture.SessionSpec{}), client(23)); err != nil {
		t.Errorf("another account: %s", test.Redact(err))
	}
}

func TestALimitedClientCannotGrowTheLimiterOrLockOutOthers(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	rejected := 0
	for n := range 100 {
		err := service.RateLimit(t.Context(), "flooding-client", "flood"+strconv.Itoa(n)+"@example.test", "flood-fixture")
		switch {
		case errors.Is(err, apperror.ErrAuthenticationFailed):
			rejected++
		case err != nil:
			t.Fatal(test.Redact(err))
		}
	}
	if rejected != 80 {
		t.Errorf("%d rejected", rejected)
	}
	if rows := queryOne[int32](t, conn, countBuckets); rows != 21 {
		t.Errorf("%d rows: one client bucket and the 20 identifiers it was allowed", rows)
	}
	if err := service.RateLimit(t.Context(), "other-client", "flood0@example.test", "flood-fixture"); err != nil {
		t.Errorf("another client: %s", test.Redact(err))
	}
}

// A queued attempt can pass lock_timeout on a loaded host: it counts nothing and is tried again here.
func TestReplicasWithSeparatePoolsEnforceOneLimit(t *testing.T) {
	s := test.NewDatabase(t)
	config, err := database.NewPoolConfig(database.PurposeIdentity, s.LoginURL("identity"), database.TLSForEnvironment("test"))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	pool, err := database.NewPool(t.Context(), config)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer pool.Close()
	runner, err := database.NewRunner(database.Pools{database.PurposeIdentity: pool}, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	replicas := []*authentication.Service{authentication.NewService(s.Runner), authentication.NewService(runner)}
	attempt := func(n int) error {
		return replicas[n%2].RateLimit(context.WithoutCancel(t.Context()), "192.0.2."+strconv.Itoa(n+1), "replica@example.test", "replica-fixture")
	}
	outcomes := make([]error, 30)
	var group sync.WaitGroup
	for n := range outcomes {
		group.Go(func() { outcomes[n] = attempt(n) })
	}
	group.Wait()
	accepted, refused := 0, 0
	for n, outcome := range outcomes {
		if _, conflict := errors.AsType[*database.ConflictError](outcome); conflict {
			outcome = attempt(n)
		}
		switch {
		case outcome == nil:
			accepted++
		case errors.Is(outcome, apperror.ErrAuthenticationFailed):
			refused++
		default:
			t.Fatal(test.Redact(outcome))
		}
	}
	if accepted != 20 || refused != 10 {
		t.Errorf("%d accepted, %d refused", accepted, refused)
	}
}

// resetAccount is an account as a binding reset leaves it: old binding disabled, invited again.
func resetAccount(t *testing.T, o oidcStack, email, oldSubject, state string) string {
	t.Helper()
	id := queryOne[string](t, o.conn, resetAccountRow, email)
	exec(t, o.conn, resetBindingRow, test.FixtureIssuer, oldSubject, id)
	exec(t, o.conn, resetDisableBinding, id)
	exec(t, o.conn, resetState, id, state)
	exec(t, o.conn, resetEnrollment, id, test.FixtureIssuer, email)
	return id
}

func TestAResetAccountActivatesOnceWithANewSubject(t *testing.T) {
	o := newOidcStack(t)
	const email = "rebind@example.test"
	id := resetAccount(t, o, email, "old-a", "pending")
	browser := credential.NewSessionSecret()
	authorization, err := o.service.Begin(t.Context(), test.FixtureIssuer, browser, oidcClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	callback := o.idp.authorize(t, authorization, "new-a", verifiedEmailClaims(email))
	if _, err := o.service.Callback(t.Context(), callback, browser); err != nil {
		t.Fatal(test.Redact(err))
	}
	if facts := queryOne[string](t, o.conn, resetFacts, id); facts != "active|1|new-a,old-a|0" {
		t.Errorf("%s", facts)
	}
	if _, err := o.service.Callback(t.Context(), callback, browser); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("the callback again: %v", err)
	}
	if _, err := o.signIn(t, "new-b", verifiedEmailClaims(email)); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("another subject after the bind: %v", err)
	}
	if facts := queryOne[string](t, o.conn, resetFacts, id); facts != "active|1|new-a,old-a|0" {
		t.Errorf("%s", facts)
	}
}

func TestTheOldSubjectOfAResetAccountNeverComesBack(t *testing.T) {
	o := newOidcStack(t)
	const email = "oldpair@example.test"
	id := resetAccount(t, o, email, "old-b", "pending")
	if _, err := o.signIn(t, "old-b", verifiedEmailClaims(email)); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("the old subject: %v", err)
	}
	if facts := queryOne[string](t, o.conn, resetFacts, id); facts != "pending|0|old-b|1" {
		t.Errorf("%s", facts)
	}
	if _, err := o.signIn(t, "new-c", verifiedEmailClaims(email)); err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := o.signIn(t, "old-b", verifiedEmailClaims(email)); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("the old subject after the new one: %v", err)
	}
}

func TestAResetAccountNeedsItsVerifiedEmailAndAnAccountNotSuspended(t *testing.T) {
	o := newOidcStack(t)
	const email = "strict@example.test"
	id := resetAccount(t, o, email, "old-d", "pending")
	for name, claims := range map[string]rawClaims{
		"not verified":     {"email": `"` + email + `"`, "email_verified": `false`},
		"verified as text": {"email": `"` + email + `"`, "email_verified": `"true"`},
		"no flag":          {"email": `"` + email + `"`},
		"another email":    verifiedEmailClaims("other@example.test"),
	} {
		if _, err := o.signIn(t, "new-d", claims); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if facts := queryOne[string](t, o.conn, resetFacts, id); facts != "pending|0|old-d|1" {
		t.Errorf("%s", facts)
	}
	const held = "held@example.test"
	suspended := resetAccount(t, o, held, "old-f", "suspended")
	for _, subject := range []string{"new-f", "old-f"} {
		if _, err := o.signIn(t, subject, verifiedEmailClaims(held)); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: %v", subject, err)
		}
	}
	if facts := queryOne[string](t, o.conn, resetFacts, suspended); !strings.HasPrefix(facts, "suspended|") {
		t.Errorf("%s", facts)
	}
}

func TestAnExpiredEnrollmentOfTheRootCannotStartUntilReissued(t *testing.T) {
	o := newOidcStack(t)
	rootID, token := pendingRoot(t, o.s, "bootstrap", "--operation", "8e0f8a4e-3c55-4a8a-9a43-3c7b6f1f2a11", "--email", "root@example.test")
	exec(t, o.conn, lapseEnrollment, rootID)
	if _, err := o.service.Activate(t.Context(), test.FixtureIssuer, credential.NewSessionSecret(), token, oidcClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("an expired enrollment: %v", err)
	}
	_, renewed := pendingRoot(t, o.s, "reissue-root")
	if _, err := o.service.Activate(t.Context(), test.FixtureIssuer, credential.NewSessionSecret(), renewed, oidcClient); err != nil {
		t.Errorf("after the reissue: %s", test.Redact(err))
	}
}

func TestTwoCallbacksWithTheTokenLeaveOneBindingOfTheRoot(t *testing.T) {
	o := newOidcStack(t)
	const email = "root@example.test"
	rootID, token := pendingRoot(t, o.s, "bootstrap", "--operation", "8e0f8a4e-3c55-4a8a-9a43-3c7b6f1f2a12", "--email", email)
	before := queryOne[string](t, o.conn, epochOf, rootID)
	type started struct {
		browser  string
		callback *url.URL
	}
	var attempts [2]started
	for i, subject := range []string{"root-a", "root-b"} {
		browser := credential.NewSessionSecret()
		authorization, err := o.service.Activate(t.Context(), test.FixtureIssuer, browser, token, oidcClient)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		attempts[i] = started{browser, o.idp.authorize(t, authorization, subject, verifiedEmailClaims(email))}
	}
	results := make([]error, 2)
	sessions := make([]authentication.Session, 2)
	var group sync.WaitGroup
	for i := range attempts {
		group.Go(func() {
			sessions[i], results[i] = o.service.Callback(context.WithoutCancel(t.Context()), attempts[i].callback, attempts[i].browser)
		})
	}
	group.Wait()
	winner := -1
	for i, err := range results {
		switch {
		case err == nil && winner == -1:
			winner = i
		case err == nil:
			t.Error("both callbacks activated")
		case !errors.Is(err, apperror.ErrAuthenticationFailed):
			if _, conflict := errors.AsType[*database.ConflictError](err); !conflict {
				t.Errorf("%s", test.Redact(err))
			}
		}
	}
	if winner == -1 {
		t.Fatal("no callback activated")
	}
	epoch, err := strconv.ParseInt(before, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if facts, want := queryOne[string](t, o.conn, rootFacts, rootID), "active|root|true|"+strconv.FormatInt(epoch+1, 10)+"|1"; facts != want {
		t.Errorf("%s, want %s", facts, want)
	}
	if live := queryOne[int32](t, o.conn, liveTokens, rootID); live != 0 {
		t.Errorf("%d live tokens", live)
	}
	identity, err := resolve(t, o.s, database.ModeRead, sessions[winner].Secret)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if identity.UserID != rootID || identity.Fresh {
		t.Errorf("%+v", identity)
	}
	if n := queryOne[int32](t, o.conn, activationEvent, []byte("identity.oidc-activation"), rootID); n != 1 {
		t.Errorf("%d activation events", n)
	}
}
