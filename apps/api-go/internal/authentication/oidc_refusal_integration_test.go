//go:build integration

package authentication_test

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	suspendAccount  = `UPDATE app_user SET state='suspended' WHERE id=$1`
	disableBinding  = `UPDATE external_identity SET enabled=false,binding_version=binding_version+1 WHERE user_id=$1`
	bindSubject     = `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`
	lapseEnrollment = `UPDATE oidc_email_enrollment SET created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 second' WHERE user_id=$1`
	enrollmentsOf   = `SELECT count(*)::int FROM oidc_email_enrollment WHERE user_id=$1`
	bindingsOf      = `SELECT count(*)::int FROM external_identity WHERE user_id=$1`
	loginColumns    = `SELECT enrollment_hash IS NULL AND linking_user_id IS NULL AND purpose='login' FROM oidc_login_attempt WHERE state_hash=$1`
	activateColumns = `SELECT octet_length(enrollment_hash)=32 AND linking_user_id=$2 AND purpose='activation' FROM oidc_login_attempt WHERE state_hash=$1`
	secondProvider  = `INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)`
	secondIssuer    = "https://second.fixture"
	issFlag         = "authorization_response_iss_parameter_supported"
)

func verifiedEmailClaims(email string) rawClaims {
	return rawClaims{"email": `"` + email + `"`, "email_verified": `true`}
}

func TestASuspendedAccountOrADisabledBindingGetsNoSession(t *testing.T) {
	o := newOidcStack(t)
	suspended := fixture.Account(t, o.s, fixture.AccountSpec{})
	exec(t, o.conn, suspendAccount, suspended.ID)
	if _, err := o.signIn(t, suspended.Subject, nil); !refused(err) {
		t.Errorf("suspended: %v", test.Redact(err))
	}
	disabled := fixture.Account(t, o.s, fixture.AccountSpec{})
	exec(t, o.conn, disableBinding, disabled.ID)
	if _, err := o.signIn(t, disabled.Subject, nil); !refused(err) {
		t.Errorf("disabled binding: %v", test.Redact(err))
	}
	for name, id := range map[string]string{"suspended": suspended.ID, "disabled": disabled.ID} {
		if n := queryOne[int32](t, o.conn, countEvents, []byte("identity.oidc-login"), id); n != 0 {
			t.Errorf("%s: %d login events", name, n)
		}
	}
}

func TestAnExpiredEnrollmentDoesNotBind(t *testing.T) {
	o := newOidcStack(t)
	userID := queryOne[string](t, o.conn, pendingAccount, "late@example.test")
	exec(t, o.conn, enrollAccount, userID, test.FixtureIssuer, "late@example.test", userID)
	exec(t, o.conn, lapseEnrollment, userID)
	if _, err := o.signIn(t, "late-subject", verifiedEmailClaims("late@example.test")); !refused(err) {
		t.Errorf("%v", test.Redact(err))
	}
	if state := queryOne[string](t, o.conn, accountState, userID); state != "pending:false" ||
		queryOne[int32](t, o.conn, bindingsOf, userID) != 0 {
		t.Errorf("account %s", state)
	}
}

// uq_external_identity_one_enabled would also refuse the second binding at insert, so the outcome of a sign-in
// cannot tell the rule apart: the rule is held at the query, whose answer decides who queues for the exclusive
// fence.
func TestAnEnrollmentOfAnAccountWithAnEnabledBindingIsNotLive(t *testing.T) {
	o := newOidcStack(t)
	userID := queryOne[string](t, o.conn, pendingAccount, "bound@example.test")
	exec(t, o.conn, enrollAccount, userID, test.FixtureIssuer, "bound@example.test", userID)
	exec(t, o.conn, bindSubject, test.FixtureIssuer, "old-subject", userID)
	live := func(mode database.Mode, lock bool) bool {
		t.Helper()
		found, err := database.Run(t.Context(), o.s.Runner, mode, func(_ context.Context, tx *database.Tx) (bool, error) {
			_, live, err := authentication.LiveEnrollment(tx, test.FixtureIssuer, "bound@example.test", lock)
			return live, err
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		return found
	}
	if live(database.ModeIdentity, false) || live(database.ModeRevoke, true) {
		t.Error("an account with an enabled binding has a live enrollment")
	}
	if _, err := o.signIn(t, "new-subject", verifiedEmailClaims("bound@example.test")); !refused(err) {
		t.Errorf("a second binding: %v", test.Redact(err))
	}
	if n := queryOne[int32](t, o.conn, bindingCount, userID, test.FixtureIssuer, "new-subject"); n != 0 {
		t.Errorf("%d bindings of the new subject", n)
	}
	exec(t, o.conn, disableBinding, userID)
	if !live(database.ModeIdentity, false) {
		t.Error("a disabled binding does not hold the enrollment")
	}
}

func TestAnOrdinaryLoginNeverTakesTheEnrollmentOfTheRoot(t *testing.T) {
	o := newOidcStack(t)
	rootID, _ := pendingRoot(t, o.s, "bootstrap", "--operation", "8e0f8a4e-3c55-4a8a-9a43-3c7b6f1f2a10", "--email", "root@example.test")
	if _, err := o.signIn(t, "root-subject", verifiedEmailClaims("root@example.test")); !refused(err) {
		t.Errorf("%v", test.Redact(err))
	}
	if state := queryOne[string](t, o.conn, accountState, rootID); state != "pending:false" ||
		queryOne[int32](t, o.conn, bindingsOf, rootID) != 0 || queryOne[int32](t, o.conn, enrollmentsOf, rootID) != 1 {
		t.Errorf("root %s", state)
	}
}

func TestABoundSubjectSignsInAndAnUnprovenEmailChangesNothing(t *testing.T) {
	o := newOidcStack(t)
	account := fixture.Account(t, o.s, fixture.AccountSpec{Email: "own@example.test"})
	exec(t, o.conn, unverifyEmail, account.ID)
	before := fixture.Session(t, o.s, account.ID, fixture.SessionSpec{})
	for name, change := range map[string]rawClaims{
		"false":       {"email": `"own@example.test"`, "email_verified": `false`},
		"a string":    {"email": `"own@example.test"`, "email_verified": `"true"`},
		"the number":  {"email": `"own@example.test"`, "email_verified": `1`},
		"missing":     {"email": `"own@example.test"`},
		"in capitals": {"email": `"own@example.test"`, "EMAIL_VERIFIED": `true`},
	} {
		if _, err := o.signIn(t, account.Subject, change); err != nil {
			t.Errorf("email_verified %s: %v", name, test.Redact(err))
		}
	}
	if state := queryOne[string](t, o.conn, accountState, account.ID); state != "active:false" ||
		queryOne[int32](t, o.conn, countEvents, []byte("identity.email-verify"), account.ID) != 0 {
		t.Errorf("account %s", state)
	}
	if _, err := resolve(t, o.s, database.ModeRead, before); err != nil {
		t.Errorf("the session before: %v", test.Redact(err))
	}
	browser := credential.NewSessionSecret()
	authorization, err := o.service.Begin(t.Context(), test.FixtureIssuer, browser, oidcClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if !queryOne[bool](t, o.conn, loginColumns, stateOf(t, o.idp.authorize(t, authorization, account.Subject, nil))) {
		t.Error("a login attempt stores no enrollment hash and no linking user")
	}
}

func TestAnActivationNeedsAVerifiedEmailAndAFreeSubject(t *testing.T) {
	o := newOidcStack(t)
	rootID, token := pendingRoot(t, o.s, "bootstrap", "--operation", "8e0f8a4e-3c55-4a8a-9a43-3c7b6f1f2a10", "--email", "root@example.test")
	verified := verifiedEmailClaims("root@example.test")
	activate := func(subject string, change rawClaims) error {
		t.Helper()
		browser := credential.NewSessionSecret()
		authorization, err := o.service.Activate(t.Context(), test.FixtureIssuer, browser, token, oidcClient)
		if err != nil {
			return err
		}
		callback := o.idp.authorize(t, authorization, subject, change)
		if !queryOne[bool](t, o.conn, activateColumns, stateOf(t, callback), rootID) {
			t.Error("an activation attempt stores the enrollment hash and the linking user")
		}
		_, err = o.service.Callback(t.Context(), callback, browser)
		return err
	}
	other := fixture.Account(t, o.s, fixture.AccountSpec{})
	for name, c := range map[string]struct {
		subject string
		change  rawClaims
	}{
		"a subject bound to another account": {other.Subject, verified},
		"email_verified false":               {"root-subject", rawClaims{"email": `"root@example.test"`, "email_verified": `false`}},
		"email_verified a string":            {"root-subject", rawClaims{"email": `"root@example.test"`, "email_verified": `"true"`}},
		"email_verified missing":             {"root-subject", rawClaims{"email": `"root@example.test"`}},
	} {
		if err := activate(c.subject, c.change); !refused(err) {
			t.Errorf("%s: %v", name, test.Redact(err))
		}
	}
	if state := queryOne[string](t, o.conn, accountState, rootID); state != "pending:false" ||
		queryOne[int32](t, o.conn, liveTokens, rootID) != 1 || queryOne[int32](t, o.conn, bindingsOf, rootID) != 0 {
		t.Errorf("a refused activation changes nothing: %s", state)
	}
	if err := activate("root-subject", verified); err != nil {
		t.Errorf("after the refusals: %s", test.Redact(err))
	}
}

func TestOneEnrollmentBindsOneOfTwoConcurrentSubjects(t *testing.T) {
	o := newOidcStack(t)
	userID := queryOne[string](t, o.conn, pendingAccount, "race@example.test")
	exec(t, o.conn, enrollAccount, userID, test.FixtureIssuer, "race@example.test", userID)
	subjects := []string{"race-a", "race-b"}
	browsers := make([]string, len(subjects))
	callbacks := make([]*url.URL, len(subjects))
	for i, subject := range subjects {
		browsers[i] = credential.NewSessionSecret()
		authorization, err := o.service.Begin(t.Context(), test.FixtureIssuer, browsers[i], oidcClient)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		callbacks[i] = o.idp.authorize(t, authorization, subject, verifiedEmailClaims("race@example.test"))
	}
	results := make([]error, len(subjects))
	var wait sync.WaitGroup
	for i := range subjects {
		wait.Go(func() {
			_, results[i] = o.service.Callback(t.Context(), callbacks[i], browsers[i])
		})
	}
	wait.Wait()
	accepted := 0
	for _, err := range results {
		switch {
		case err == nil:
			accepted++
		case !refused(err):
			t.Errorf("%s", test.Redact(err))
		}
	}
	if accepted != 1 || queryOne[int32](t, o.conn, bindingsOf, userID) != 1 {
		t.Errorf("%d accepted", accepted)
	}
}

func TestACallbackRefusesARepeatOfItsOwnParametersAndIgnoresOthers(t *testing.T) {
	o := newOidcStack(t)
	account := fixture.Account(t, o.s, fixture.AccountSpec{})
	browser := credential.NewSessionSecret()
	authorization, err := o.service.Begin(t.Context(), test.FixtureIssuer, browser, oidcClient)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	callback := o.idp.authorize(t, authorization, account.Subject, nil)
	state := url.QueryEscape(callback.Query().Get("state"))
	twoErrors, err := url.Parse(idpRedirect + "?error=a&error=b&state=" + state)
	if err != nil {
		t.Fatal(err)
	}
	for name, repeated := range map[string]*url.URL{
		"state":           withIss(t, callback, "state="+state),
		"code":            withIss(t, callback, "code=another"),
		"error":           twoErrors,
		"a bad other key": withIss(t, callback, "session_state=%zz"),
	} {
		if _, err := o.service.Callback(t.Context(), repeated, browser); !refused(err) {
			t.Errorf("%s: %v", name, test.Redact(err))
		}
	}
	if queryOne[bool](t, o.conn, attemptByState, stateOf(t, callback)) {
		t.Error("a refused repeat spends the attempt")
	}
	if _, err := o.service.Callback(t.Context(), withIss(t, callback, "session_state=x&scope=a&scope=b&authuser="), browser); err != nil {
		t.Errorf("other parameters of the IdP: %s", test.Redact(err))
	}
}

// withIss is the callback with raw appended to its query.
func withIss(t *testing.T, callback *url.URL, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(callback.String() + "&" + raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestTheIssuerParameterOfACallback(t *testing.T) {
	exact := "iss=" + url.QueryEscape(test.FixtureIssuer)
	refusedAlways := map[string]string{
		"another issuer":     "iss=" + url.QueryEscape("https://other.fixture"),
		"in capitals":        "iss=" + url.QueryEscape(strings.ToUpper(test.FixtureIssuer)),
		"with a slash":       "iss=" + url.QueryEscape(test.FixtureIssuer+"/"),
		"empty":              "iss=",
		"twice":              exact + "&" + exact,
		"beside a bad pair":  exact + "&iss=%zz",
		"after a semicolon":  exact + ";iss=x",
		"bad escape of iss":  "iss=%zz",
		"twice, one another": exact + "&iss=" + url.QueryEscape("https://other.fixture"),
	}
	begin := func(t *testing.T, o oidcStack, account fixture.AccountRow) (string, *url.URL) {
		t.Helper()
		browser := credential.NewSessionSecret()
		authorization, err := o.service.Begin(t.Context(), test.FixtureIssuer, browser, oidcClient)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		return browser, o.idp.authorize(t, authorization, account.Subject, nil)
	}
	refuses := func(t *testing.T, o oidcStack, callback *url.URL, browser string) {
		t.Helper()
		for name, raw := range refusedAlways {
			if _, err := o.service.Callback(t.Context(), withIss(t, callback, raw), browser); !refused(err) {
				t.Errorf("%s: %v", name, test.Redact(err))
			}
		}
		if queryOne[bool](t, o.conn, attemptByState, stateOf(t, callback)) {
			t.Error("a refused parameter spends the attempt")
		}
	}

	t.Run("published by the IdP", func(t *testing.T) {
		p := newIDP(t)
		p.publishing(rawClaims{issFlag: "true"})
		o := newOidcStackAt(t, p)
		account := fixture.Account(t, o.s, fixture.AccountSpec{})
		browser, callback := begin(t, o, account)
		refuses(t, o, callback, browser)
		if _, err := o.service.Callback(t.Context(), callback, browser); !refused(err) {
			t.Errorf("no iss: %v", test.Redact(err))
		}
		if queryOne[bool](t, o.conn, attemptByState, stateOf(t, callback)) {
			t.Error("a missing parameter spends the attempt")
		}
		if _, err := o.service.Callback(t.Context(), withIss(t, callback, exact), browser); err != nil {
			t.Errorf("exact iss: %s", test.Redact(err))
		}
	})

	t.Run("not published", func(t *testing.T) {
		o := newOidcStack(t)
		account := fixture.Account(t, o.s, fixture.AccountSpec{})
		browser, callback := begin(t, o, account)
		refuses(t, o, callback, browser)
		if _, err := o.service.Callback(t.Context(), callback, browser); err != nil {
			t.Errorf("no iss: %s", test.Redact(err))
		}
		browser, callback = begin(t, o, account)
		if _, err := o.service.Callback(t.Context(), withIss(t, callback, exact), browser); err != nil {
			t.Errorf("exact iss: %s", test.Redact(err))
		}
	})

	t.Run("names another configured provider", func(t *testing.T) {
		s := test.NewDatabase(t)
		conn := superuser(t, s)
		exec(t, conn, secondProvider, secondIssuer)
		first, second := newIDP(t), newIDP(t)
		metadata := rawClaims{}
		for key, value := range idpMetadata() {
			metadata[key] = strings.ReplaceAll(value, test.FixtureIssuer, secondIssuer)
		}
		second.publishing(metadata)
		settings := second.settings()
		settings.Issuer = secondIssuer
		other, err := authentication.NewOidcProvider(t.Context(), settings, second.client())
		if err != nil {
			t.Fatal(err)
		}
		service, err := authentication.NewOidcService(authentication.NewService(s.Runner), []*authentication.OidcProvider{first.provider(t), other})
		if err != nil {
			t.Fatal(err)
		}
		o := oidcStack{s: s, conn: conn, idp: first, service: service}
		account := fixture.Account(t, s, fixture.AccountSpec{})
		browser, callback := begin(t, o, account)
		if _, err := service.Callback(t.Context(), withIss(t, callback, "iss="+url.QueryEscape(secondIssuer)), browser); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%v", test.Redact(err))
		}
		if queryOne[bool](t, conn, attemptByState, stateOf(t, callback)) {
			t.Error("a mix-up spends the attempt")
		}
		if _, err := service.Callback(t.Context(), callback, browser); err != nil {
			t.Errorf("the attempt's own provider: %s", test.Redact(err))
		}
	})
}
