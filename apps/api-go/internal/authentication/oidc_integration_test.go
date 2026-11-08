//go:build integration

package authentication_test

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	oidcClient      = "198.51.100.9"
	attemptByState  = `SELECT consumed_at IS NOT NULL FROM oidc_login_attempt WHERE state_hash=$1`
	attemptWindow   = `SELECT expires_at BETWEEN statement_timestamp()+interval '4 minutes 50 seconds' AND statement_timestamp()+interval '5 minutes' FROM oidc_login_attempt WHERE state_hash=$1`
	expireAttempt   = `UPDATE oidc_login_attempt SET expires_at=statement_timestamp()-interval '1 second' WHERE state_hash=$1`
	pendingAccount  = `INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES(gen_random_uuid(),$1,'pending',false) RETURNING id::text`
	enrollAccount   = `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by) VALUES($1,$2,$3,statement_timestamp()+interval '1 day',$4)`
	accountState    = `SELECT state||':'||email_verified::text FROM app_user WHERE id=$1`
	bindingCount    = `SELECT count(*)::int FROM external_identity WHERE user_id=$1 AND issuer=$2 AND subject=$3`
	unverifyEmail   = `UPDATE app_user SET email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`
	sessionFacts    = `SELECT assurance||':'||extract(epoch FROM authenticated_at)::bigint::text FROM application_session WHERE token_hash=$1`
	bumpProvider    = `UPDATE oidc_provider SET version=2 WHERE issuer=$1`
	liveTokens      = `SELECT count(*)::int FROM one_time_token WHERE user_id=$1 AND consumed_at IS NULL`
	utcMilliseconds = `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`
)

var rootCreated = regexp.MustCompile(`Root enrollment committed \(id ([0-9a-f-]{36})\)`)

type oidcStack struct {
	s       *test.Stack
	conn    *pgx.Conn
	idp     *idp
	service *authentication.OidcService
}

func newOidcStack(t *testing.T) oidcStack {
	t.Helper()
	return newOidcStackAt(t, newIDP(t))
}

func newOidcStackAt(t *testing.T, p *idp) oidcStack {
	t.Helper()
	s := test.NewDatabase(t)
	service, err := authentication.NewOidcService(authentication.NewService(s.Runner), []*authentication.OidcProvider{p.provider(t)})
	if err != nil {
		t.Fatal(err)
	}
	return oidcStack{s: s, conn: superuser(t, s), idp: p, service: service}
}

// signIn runs begin, the IdP's answer for subject with change over the default claims, and the callback.
func (o oidcStack) signIn(t *testing.T, subject string, change rawClaims) (authentication.Session, error) {
	t.Helper()
	browser := credential.NewSessionSecret()
	authorization, err := o.service.Begin(t.Context(), test.FixtureIssuer, browser, oidcClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return o.service.Callback(t.Context(), o.idp.authorize(t, authorization, subject, change), browser)
}

func stateOf(t *testing.T, callback *url.URL) []byte {
	t.Helper()
	return digestOf(t, callback.Query().Get("state"))
}

func TestABoundSubjectSignsInWithTheIdPAssurance(t *testing.T) {
	o := newOidcStack(t)
	account := fixture.Account(t, o.s, fixture.AccountSpec{})
	session, err := o.signIn(t, account.Subject, nil)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	identity, err := resolve(t, o.s, database.ModeRead, session.Secret)
	if err != nil || identity.UserID != account.ID || identity.Assurance != "oidc" || identity.Fresh {
		t.Errorf("%+v %v", identity, err)
	}
	if !regexp.MustCompile(utcMilliseconds).MatchString(session.ExpiresAt) || session.MaxAge <= 43_000 || session.MaxAge > 43_200 {
		t.Errorf("expiry %s, max age %d", session.ExpiresAt, session.MaxAge)
	}
	mapped, err := o.signIn(t, account.Subject, rawClaims{"acr": `"loa2"`, "amr": `["pwd","otp"]`, "auth_time": "1700000000"})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if facts := queryOne[string](t, o.conn, sessionFacts, digestOf(t, mapped.Secret)); facts != "mfa:1700000000" {
		t.Errorf("session facts %s", facts)
	}
	if n := queryOne[int32](t, o.conn, countEvents, []byte("identity.oidc-login"), account.ID); n != 2 {
		t.Errorf("%d login events", n)
	}
	for name, change := range map[string]rawClaims{
		"unknown subject":  {"sub": `"nobody"`},
		"wrong nonce":      {"nonce": `"another"`},
		"wrong audience":   {"aud": `"other-client"`},
		"expired":          {"exp": "1"},
		"empty subject":    {"sub": `""`},
		"several audience": {"aud": `["hrm-client","other-client"]`},
	} {
		if _, err := o.signIn(t, account.Subject, change); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestTheAttemptIsSpentOnceByItsBrowserWithinFiveMinutes(t *testing.T) {
	o := newOidcStack(t)
	account := fixture.Account(t, o.s, fixture.AccountSpec{})
	issuer := test.FixtureIssuer
	begin := func() (string, *url.URL) {
		browser := credential.NewSessionSecret()
		authorization, err := o.service.Begin(t.Context(), issuer, browser, oidcClient)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		return browser, o.idp.authorize(t, authorization, account.Subject, nil)
	}
	refusedCallback := func(name string, callback *url.URL, browser string) {
		t.Helper()
		if _, err := o.service.Callback(t.Context(), callback, browser); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: %v", name, err)
		}
	}
	stated := "iss=" + url.QueryEscape(issuer)

	browser, callback := begin()
	if !queryOne[bool](t, o.conn, attemptWindow, stateOf(t, callback)) {
		t.Error("the attempt lasts five minutes")
	}
	refusedCallback("another browser", callback, credential.NewSessionSecret())
	refusedCallback("another browser with iss", withIss(t, callback, stated), credential.NewSessionSecret())
	if _, err := o.service.Callback(t.Context(), withIss(t, callback, stated), browser); err != nil {
		t.Fatalf("its own browser: %s", test.Redact(err))
	}
	refusedCallback("the state again", callback, browser)

	browser, callback = begin()
	exec(t, o.conn, expireAttempt, stateOf(t, callback))
	refusedCallback("expired attempt", callback, browser)

	browser, callback = begin()
	o.idp.mu.Lock()
	issued := o.idp.codes[callback.Query().Get("code")]
	issued.challenge = "another-challenge"
	o.idp.codes[callback.Query().Get("code")] = issued
	o.idp.mu.Unlock()
	refusedCallback("wrong PKCE", callback, browser)
	if !queryOne[bool](t, o.conn, attemptByState, stateOf(t, callback)) {
		t.Error("a failed exchange spends the attempt")
	}

	browser, callback = begin()
	state := callback.Query().Get("state")
	cancelled, err := url.Parse(idpRedirect + "?error=access_denied&state=" + url.QueryEscape(state))
	if err != nil {
		t.Fatal(err)
	}
	refusedCallback("provider error", cancelled, browser)
	refusedCallback("code after the error", callback, browser)

	browser, callback = begin()
	for name, raw := range map[string]string{
		"two states":     callback.String() + "&state=" + url.QueryEscape(state),
		"code and error": callback.String() + "&error=x",
		"other path":     strings.Replace(callback.String(), "/callback", "/other", 1),
		"other host":     strings.Replace(callback.String(), "app.fixture", "evil.fixture", 1),
		"fragment":       callback.String() + "#x",
		"no code":        idpRedirect + "?state=" + url.QueryEscape(callback.Query().Get("state")),
	} {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		refusedCallback(name, parsed, browser)
	}
	if _, err := o.service.Callback(t.Context(), callback, browser); err != nil {
		t.Errorf("a refused URL does not spend the attempt: %s", test.Redact(err))
	}
	unknown := "https://unknown.fixture"
	refusedCallback("unknown issuer", withIss(t, callback, "iss="+url.QueryEscape(unknown)), browser)
	if _, err := o.service.Begin(t.Context(), unknown, browser, oidcClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("begin at an unknown issuer: %v", err)
	}
	if _, err := o.service.Begin(t.Context(), issuer, "not-a-browser-secret", oidcClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("begin with a malformed browser secret: %v", err)
	}
	browser, callback = begin()
	exec(t, o.conn, bumpProvider, issuer)
	refusedCallback("provider version changed", callback, browser)
	if _, err := o.service.Begin(t.Context(), issuer, browser, oidcClient); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("begin after a version change: %v", err)
	}
}

func TestTheFirstVerifiedLoginBindsAnEnrolledAccount(t *testing.T) {
	o := newOidcStack(t)
	userID := queryOne[string](t, o.conn, pendingAccount, "new@example.test")
	exec(t, o.conn, enrollAccount, userID, test.FixtureIssuer, "new@example.test", userID)
	for name, change := range map[string]rawClaims{
		"no email":         {},
		"unverified email": {"email": `"new@example.test"`, "email_verified": `false`},
		"another email":    {"email": `"other@example.test"`, "email_verified": `true`},
	} {
		if _, err := o.signIn(t, "first-subject", change); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: %v", name, err)
		}
	}
	verified := rawClaims{"email": `"New@Example.Test"`, "email_verified": `true`}
	session, err := o.signIn(t, "first-subject", verified)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if identity, err := resolve(t, o.s, database.ModeRead, session.Secret); err != nil || identity.UserID != userID {
		t.Errorf("%+v %v", identity, err)
	}
	if state := queryOne[string](t, o.conn, accountState, userID); state != "active:true" ||
		queryOne[int32](t, o.conn, bindingCount, userID, test.FixtureIssuer, "first-subject") != 1 {
		t.Errorf("account %s", state)
	}
	if n := queryOne[int32](t, o.conn, countEvents, []byte("identity.oidc-activation"), userID); n != 1 {
		t.Errorf("%d activation events", n)
	}
	if _, err := o.signIn(t, "second-subject", verified); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("the enrollment binds once: %v", err)
	}
}

func TestATokenThatVerifiesTheOwnEmailAdvancesTheEpoch(t *testing.T) {
	o := newOidcStack(t)
	account := fixture.Account(t, o.s, fixture.AccountSpec{Email: "own@example.test"})
	exec(t, o.conn, unverifyEmail, account.ID)
	before := fixture.Session(t, o.s, account.ID, fixture.SessionSpec{})
	session, err := o.signIn(t, account.Subject, rawClaims{"email": `"own@example.test"`, "email_verified": `true`})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := resolve(t, o.s, database.ModeRead, before); !refused(err) {
		t.Errorf("a session of the unverified email: %v", err)
	}
	if _, err := resolve(t, o.s, database.ModeRead, session.Secret); err != nil {
		t.Errorf("the new session: %s", test.Redact(err))
	}
	if state := queryOne[string](t, o.conn, accountState, account.ID); state != "active:true" ||
		queryOne[int32](t, o.conn, countEvents, []byte("identity.email-verify"), account.ID) != 1 {
		t.Errorf("account %s", state)
	}
}

func pendingRoot(t *testing.T, s *test.Stack, command string, args ...string) (string, string) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "activation")
	output, err := s.TypeScriptCLI(t.Context(), command, append(args, "--issuer", test.FixtureIssuer, "--activation-file", file)...)
	if err != nil {
		t.Fatalf("%s: %T", command, err)
	}
	token, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	id := ""
	if match := rootCreated.FindStringSubmatch(output); match != nil {
		id = match[1]
	}
	return id, strings.TrimSpace(string(token))
}

func TestTheRootActivatesWithTheLiveTokenAndItsEnrollmentEmail(t *testing.T) {
	o := newOidcStack(t)
	rootID, first := pendingRoot(t, o.s, "bootstrap", "--operation", "8e0f8a4e-3c55-4a8a-9a43-3c7b6f1f2a10", "--email", "root@example.test")
	activate := func(token string, change rawClaims) (authentication.Session, error) {
		browser := credential.NewSessionSecret()
		authorization, err := o.service.Activate(t.Context(), test.FixtureIssuer, browser, token, oidcClient)
		if err != nil {
			return authentication.Session{}, err
		}
		return o.service.Callback(t.Context(), o.idp.authorize(t, authorization, "root-subject", change), browser)
	}
	email := rawClaims{"email": `"root@example.test"`, "email_verified": `true`}
	if _, err := activate(credential.NewSessionSecret(), email); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("an unknown token: %v", err)
	}
	if _, err := activate(first, rawClaims{"email": `"other@example.test"`, "email_verified": `true`}); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("another email: %v", err)
	}
	browser := credential.NewSessionSecret()
	authorization, err := o.service.Activate(t.Context(), test.FixtureIssuer, browser, first, oidcClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	_, second := pendingRoot(t, o.s, "reissue-root")
	if _, err := o.service.Callback(t.Context(), o.idp.authorize(t, authorization, "root-subject", email), browser); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("an attempt of the voided token: %v", err)
	}
	session, err := activate(second, email)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	identity, err := resolve(t, o.s, database.ModeRead, session.Secret)
	if err != nil || identity.UserID != rootID || identity.Kind != "root" || identity.Fresh {
		t.Errorf("%+v %v", identity, err)
	}
	if _, err := activate(second, email); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("the token after activation: %v", err)
	}
	if state := queryOne[string](t, o.conn, accountState, rootID); state != "active:true" ||
		queryOne[int32](t, o.conn, liveTokens, rootID) != 0 {
		t.Errorf("root %s", state)
	}
}
