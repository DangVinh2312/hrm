//go:build integration

package authentication_test

import (
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authentication"
	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/database"
	"hrm/api/internal/httpapi"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	clearedBrowser = "__Host-authz_browser=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure"
	targetSignedIn = "/"
	targetFailed   = "/login?error=oidc"
	callbackRoute  = "/api/auth/oidc/callback"

	authFailed  = `{"statusCode":401,"code":"error.authenticationFailed"}`
	denied      = `{"statusCode":403,"code":"error.accessDenied"}`
	invalid     = `{"statusCode":400,"code":"error.invalidRequest"}`
	conflict    = `{"statusCode":409,"code":"error.conflict"}`
	unavailable = `{"statusCode":503,"code":"error.unavailable"}`

	revokeSessionOf  = `UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1`
	attemptsTotal    = `SELECT count(*)::int FROM oidc_login_attempt`
	limiterBuckets   = `SELECT count(*)::int FROM rate_limit`
	bucketRows       = `SELECT count(*)::int FROM rate_limit WHERE bucket_key=$1`
	unrevokedOfOwner = `SELECT count(*)::int FROM application_session WHERE user_id=$1 AND revoked_at IS NULL`
	secondsIntoStep  = `SELECT extract(epoch FROM statement_timestamp())::bigint%30`

	// nulEscape is the JSON escape of U+0000, kept out of the literal the way body_test.go does.
	nulEscape = "\x5cu0000"
)

// lockedBuffer collects the log of a test; the engine logs from the request goroutine.
type lockedBuffer struct {
	mu      sync.Mutex
	content bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.content.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.content.String()
}

// modeLog lists the transactions a request opened, by mode.
type modeLog struct {
	mu    sync.Mutex
	modes []database.Mode
}

func (m *modeLog) observe(metric database.Metric, mode database.Mode, _ float64) {
	if metric != database.MetricTransaction {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.modes = append(m.modes, mode)
}

func (m *modeLog) take() []database.Mode {
	m.mu.Lock()
	defer m.mu.Unlock()
	taken := m.modes
	m.modes = nil
	return taken
}

// httpStack is the auth routes on a real database, with the IdP of idp_test.go, answered without a socket.
type httpStack struct {
	s       *test.Stack
	conn    *pgx.Conn
	idp     *idp
	handler http.Handler
	log     *lockedBuffer
	modes   *modeLog
}

func newHTTPStack(t *testing.T, trustProxy int) *httpStack {
	t.Helper()
	s := test.NewDatabase(t)
	p := newIDP(t)
	modes := &modeLog{}
	runner, err := database.NewRunner(s.Pools, database.RunnerOptions{OnMetric: modes.observe})
	if err != nil {
		t.Fatal(err)
	}
	identity := authentication.NewService(runner)
	oidc, err := authentication.NewOidcService(identity, []*authentication.OidcProvider{p.provider(t)})
	if err != nil {
		t.Fatal(err)
	}
	log := &lockedBuffer{}
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(log, nil)))
	group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: routesOrigin})
	if err := httpapi.RegisterAuth(group, routesOrigin); err != nil {
		t.Fatal(err)
	}
	routes := authentication.Routes{
		Identity: identity, Mfa: authentication.NewMfaService(identity, keyRing(t, "k1", "k1")), Oidc: oidc,
		Origin: routesOrigin, TrustProxy: trustProxy,
	}
	if err := routes.Register(group); err != nil {
		t.Fatal(err)
	}
	return &httpStack{s: s, conn: superuser(t, s), idp: p, handler: httpapi.NewHandler(engine), log: log, modes: modes}
}

// browser keeps cookies across requests as a browser does: it never sends what the server expired.
type browser struct {
	stack *httpStack
	jar   map[string]string
	csrf  string
}

func (h *httpStack) browser(t *testing.T) *browser {
	t.Helper()
	b := &browser{stack: h, jar: map[string]string{}}
	answer := b.send(http.MethodGet, "/api/auth/csrf", "")
	var body struct {
		CSRFToken string `json:"csrfToken"`
	}
	decodeAnswer(t, answer, &body)
	b.csrf = body.CSRFToken
	return b
}

func (b *browser) cookie(key httpapi.CookieKey) string {
	return b.jar[httpapi.CookieName(routesOrigin, key)]
}

func (b *browser) setSession(secret string) {
	b.jar[httpapi.CookieName(routesOrigin, httpapi.SessionCookie)] = secret
}

func (b *browser) send(method, target, body string, change ...func(*http.Request)) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Host = "app.fixture"
	request.Header.Set("Origin", routesOrigin)
	if b.csrf != "" {
		request.Header.Set("X-Csrf-Token", b.csrf)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	pairs := make([]string, 0, len(b.jar))
	for name, value := range b.jar {
		pairs = append(pairs, name+"="+value)
	}
	if len(pairs) > 0 {
		request.Header.Set("Cookie", strings.Join(pairs, "; "))
	}
	for _, apply := range change {
		apply(request)
	}
	recorder := httptest.NewRecorder()
	b.stack.handler.ServeHTTP(recorder, request)
	for _, cookie := range recorder.Result().Cookies() {
		if cookie.MaxAge < 0 {
			delete(b.jar, cookie.Name)
		} else {
			b.jar[cookie.Name] = cookie.Value
		}
	}
	return recorder
}

func decodeAnswer[T any](t *testing.T, answer *httptest.ResponseRecorder, into *T) {
	t.Helper()
	if answer.Code != http.StatusOK {
		t.Fatalf("%d %s", answer.Code, answer.Body)
	}
	if err := json.Unmarshal(answer.Body.Bytes(), into); err != nil {
		t.Fatalf("%v: %s", err, answer.Body)
	}
}

func wantAnswer(t *testing.T, name string, answer *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if answer.Code != status || answer.Body.String() != body {
		t.Errorf("%s: %d %s, want %d %s", name, answer.Code, answer.Body, status, body)
	}
	if got := answer.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("%s: Cache-Control %q", name, got)
	}
}

// sessionMaxAge is the Max-Age of the session cookie the answer set, and false when it set none.
func sessionMaxAge(answer *httptest.ResponseRecorder) (int, bool) {
	for _, cookie := range answer.Result().Cookies() {
		if cookie.Name == httpapi.CookieName(routesOrigin, httpapi.SessionCookie) {
			return cookie.MaxAge, true
		}
	}
	return 0, false
}

type mfaAnswer struct {
	Status                 string `json:"status"`
	RecoveryCodesRemaining int    `json:"recoveryCodesRemaining"`
}

type accountAnswer struct {
	Email      *string `json:"email"`
	Identities []struct {
		Issuer    string `json:"issuer"`
		Reference string `json:"reference"`
	} `json:"identities"`
	Mfa mfaAnswer `json:"mfa"`
}

func (b *browser) mfaStatus(t *testing.T) mfaAnswer {
	t.Helper()
	var account accountAnswer
	decodeAnswer(t, b.send(http.MethodGet, "/api/auth/account", ""), &account)
	return account.Mfa
}

// stableStep waits past the end of a step, so a code one step back is still in the window when it arrives.
func stableStep(t *testing.T, conn *pgx.Conn) uint64 {
	t.Helper()
	for queryOne[int64](t, conn, secondsIntoStep) > 20 {
		time.Sleep(time.Second)
	}
	return stepNow(t, conn)
}

func TestTheSecondFactorOverItsRoutes(t *testing.T) {
	h := newHTTPStack(t, 0)
	b := h.browser(t)
	const setup, confirm, verify, codes, remove = "/api/auth/mfa/totp/setup", "/api/auth/mfa/totp/confirm", "/api/auth/mfa/verify", "/api/auth/mfa/recovery-codes", "/api/auth/mfa/totp"
	routes := []struct{ method, path string }{
		{http.MethodPost, setup}, {http.MethodPost, confirm}, {http.MethodPost, verify}, {http.MethodPost, codes}, {http.MethodDelete, remove},
	}
	for _, route := range routes {
		wantAnswer(t, "no session at "+route.path, b.send(route.method, route.path, "{}"), http.StatusUnauthorized, authFailed)
	}
	user := fixture.Account(t, h.s, fixture.AccountSpec{Email: "second@example.test"})
	first := fixture.Session(t, h.s, user.ID, fixture.SessionSpec{})
	b.setSession(first)
	withoutToken := func(r *http.Request) { r.Header.Del("X-Csrf-Token") }
	for _, route := range routes {
		wantAnswer(t, "no CSRF at "+route.path, b.send(route.method, route.path, "{}", withoutToken), http.StatusForbidden, denied)
	}
	if status := b.mfaStatus(t); status != (mfaAnswer{"none", 0}) {
		t.Errorf("%+v", status)
	}
	wantAnswer(t, "setup with a member", b.send(http.MethodPost, setup, `{"extra":1}`), http.StatusBadRequest, invalid)

	var created struct {
		URI    string `json:"uri"`
		Secret string `json:"secret"`
	}
	decodeAnswer(t, b.send(http.MethodPost, setup, ""), &created)
	if !strings.HasPrefix(created.URI, "otpauth://totp/HRM:") || strings.Contains(b.send(http.MethodGet, "/api/auth/account", "").Body.String(), created.Secret) {
		t.Errorf("setup answered %s", created.URI)
	}
	if status := b.mfaStatus(t); status != (mfaAnswer{"pending", 0}) {
		t.Errorf("%+v", status)
	}
	step := stableStep(t, h.conn)
	wantAnswer(t, "a code outside the window", b.send(http.MethodPost, confirm, `{"code":"`+codeAt(t, created.Secret, step+3)+`"}`), http.StatusUnauthorized, authFailed)

	answer := b.send(http.MethodPost, confirm, `{"code":"`+codeAt(t, created.Secret, step-1)+`"}`)
	var confirmed struct {
		ExpiresAt     string   `json:"expiresAt"`
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	decodeAnswer(t, answer, &confirmed)
	if len(confirmed.RecoveryCodes) != 10 || strings.Contains(answer.Body.String(), created.Secret) || !regexp.MustCompile(utcMilliseconds).MatchString(confirmed.ExpiresAt) {
		t.Errorf("%s", answer.Body)
	}
	if b.cookie(httpapi.SessionCookie) == first {
		t.Error("the confirmation kept the session cookie")
	}
	keepsDeadline := func(name string, answer *httptest.ResponseRecorder) {
		t.Helper()
		if age, set := sessionMaxAge(answer); !set || age <= 3500 || age > 3600 {
			t.Errorf("%s: Max-Age %d, set %v, not the deadline of the one-hour session", name, age, set)
		}
	}
	keepsDeadline("confirm", answer)
	account := b.send(http.MethodGet, "/api/auth/account", "").Body.String()
	for _, code := range confirmed.RecoveryCodes {
		if strings.Contains(account, code) {
			t.Error("the account shows a recovery code")
		}
	}
	if status := b.mfaStatus(t); status != (mfaAnswer{"enabled", 10}) {
		t.Errorf("%+v", status)
	}
	wantAnswer(t, "a second setup", b.send(http.MethodPost, setup, ""), http.StatusConflict, conflict)

	answer = b.send(http.MethodPost, verify, `{"code":"`+codeAt(t, created.Secret, step)+`"}`)
	if answer.Code != http.StatusOK || !regexp.MustCompile(`^\{"expiresAt":"[^"]+"\}$`).MatchString(answer.Body.String()) {
		t.Errorf("verify: %d %s", answer.Code, answer.Body)
	}
	keepsDeadline("verify", answer)
	var regenerated struct {
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	decodeAnswer(t, b.send(http.MethodPost, codes, ""), &regenerated)
	if len(regenerated.RecoveryCodes) != 10 || slices.Equal(regenerated.RecoveryCodes, confirmed.RecoveryCodes) {
		t.Errorf("%v", regenerated.RecoveryCodes)
	}

	steppedUp := b.cookie(httpapi.SessionCookie)
	b.setSession(fixture.Session(t, h.s, user.ID, fixture.SessionSpec{}))
	wantAnswer(t, "codes without a step-up", b.send(http.MethodPost, codes, ""), http.StatusForbidden, denied)
	wantAnswer(t, "removal without a step-up", b.send(http.MethodDelete, remove, ""), http.StatusForbidden, denied)
	b.setSession(steppedUp)

	answer = b.send(http.MethodDelete, remove, "")
	if answer.Code != http.StatusOK || !regexp.MustCompile(`^\{"expiresAt":"[^"]+"\}$`).MatchString(answer.Body.String()) {
		t.Errorf("remove: %d %s", answer.Code, answer.Body)
	}
	keepsDeadline("remove", answer)
	if status := b.mfaStatus(t); status != (mfaAnswer{"none", 0}) {
		t.Errorf("%+v", status)
	}
	wantAnswer(t, "verify with no factor", b.send(http.MethodPost, verify, `{"code":"123456"}`), http.StatusConflict, conflict)
}

func TestARecoveryCodeStepsUpThroughTheRoute(t *testing.T) {
	h := newHTTPStack(t, 0)
	b := h.browser(t)
	user := fixture.Account(t, h.s, fixture.AccountSpec{Email: "recovery@example.test"})
	mfa := authentication.NewMfaService(authentication.NewService(h.s.Runner), keyRing(t, "k1", "k1"))
	_, confirmation, _ := enrolled(t, h.s, mfa, user.ID)
	b.setSession(fixture.Session(t, h.s, user.ID, fixture.SessionSpec{}))
	body := `{"recoveryCode":"` + strings.ToLower(strings.ReplaceAll(confirmation.RecoveryCodes[0], "-", " ")) + `"}`
	if answer := b.send(http.MethodPost, "/api/auth/mfa/verify", body); answer.Code != http.StatusOK {
		t.Fatalf("%d %s", answer.Code, answer.Body)
	}
	if !fresh(t, h.s, b.cookie(httpapi.SessionCookie)) {
		t.Error("the recovery code left the session not fresh")
	}
	if status := b.mfaStatus(t); status != (mfaAnswer{"enabled", 9}) {
		t.Errorf("%+v", status)
	}
	wantAnswer(t, "the same code again", b.send(http.MethodPost, "/api/auth/mfa/verify", body), http.StatusUnauthorized, authFailed)
}

// begin answers the authorization URL through the route.
func (b *browser) begin(t *testing.T) string {
	t.Helper()
	var begun struct {
		AuthorizationURL string `json:"authorizationUrl"`
	}
	decodeAnswer(t, b.send(http.MethodPost, "/api/auth/oidc/begin", `{"issuer":"`+test.FixtureIssuer+`"}`), &begun)
	return begun.AuthorizationURL
}

func assertBrowserCookieCleared(t *testing.T, name string, answer *httptest.ResponseRecorder) {
	t.Helper()
	if !slices.Contains(answer.Result().Header.Values("Set-Cookie"), clearedBrowser) {
		t.Errorf("%s: the browser cookie stays: %v", name, answer.Result().Header.Values("Set-Cookie"))
	}
}

func assertRedirect(t *testing.T, name string, answer *httptest.ResponseRecorder, target string) {
	t.Helper()
	if answer.Code != http.StatusSeeOther || answer.Header().Get("Location") != target {
		t.Errorf("%s: %d to %q, want 303 to %q: %s", name, answer.Code, answer.Header().Get("Location"), target, answer.Body)
	}
}

func TestTheSignInRoutesAnswerFixedTargets(t *testing.T) {
	h := newHTTPStack(t, 0)
	user := fixture.Account(t, h.s, fixture.AccountSpec{Email: "signin@example.test"})

	b := h.browser(t)
	answer := b.send(http.MethodGet, callbackRoute+"?state=unknown-state&code=x", "")
	assertRedirect(t, "an unknown state", answer, targetFailed)
	assertBrowserCookieCleared(t, "an unknown state", answer)

	authorization := b.begin(t)
	if b.cookie(httpapi.BrowserCookie) == "" {
		t.Fatal("no browser cookie")
	}
	callback := h.idp.authorize(t, authorization, user.Subject, nil)
	cancelled := callbackRoute + "?error=access_denied&state=" + url.QueryEscape(callback.Query().Get("state"))
	answer = b.send(http.MethodGet, cancelled, "")
	assertRedirect(t, "a cancelled login", answer, targetFailed)
	assertBrowserCookieCleared(t, "a cancelled login", answer)
	if b.cookie(httpapi.SessionCookie) != "" {
		t.Error("a cancelled login set a session")
	}

	answer = b.send(http.MethodGet, h.idp.authorize(t, b.begin(t), user.Subject, nil).RequestURI(), "")
	assertRedirect(t, "a signed in browser", answer, targetSignedIn)
	assertBrowserCookieCleared(t, "a signed in browser", answer)
	if age, set := sessionMaxAge(answer); !set || age <= 43000 || age > 43200 {
		t.Errorf("session Max-Age %d, set %v", age, set)
	}
	if want := "__Host-authz_session=" + b.cookie(httpapi.SessionCookie) + "; Path=/; Max-Age="; !strings.HasPrefix(answer.Result().Header.Values("Set-Cookie")[1], want) {
		t.Errorf("%v", answer.Result().Header.Values("Set-Cookie"))
	}

	own := b.send(http.MethodGet, "/api/auth/account", "")
	var account accountAnswer
	decodeAnswer(t, own, &account)
	if strings.Contains(own.Body.String(), user.Subject) || account.Email == nil || *account.Email != user.Email ||
		len(account.Identities) != 1 || account.Identities[0].Issuer != test.FixtureIssuer || account.Identities[0].Reference == "" {
		t.Errorf("%s", own.Body)
	}
	var shape map[string]jsontext.Value
	decodeAnswer(t, own, &shape)
	if keys := slices.Sorted(maps.Keys(shape)); !slices.Equal(keys, []string{"email", "identities", "mfa"}) {
		t.Errorf("%v", keys)
	}
}

func TestTheCallbackDoesNotReadTheHostHeader(t *testing.T) {
	h := newHTTPStack(t, 0)
	user := fixture.Account(t, h.s, fixture.AccountSpec{Email: "host@example.test"})
	b := h.browser(t)
	callback := h.idp.authorize(t, b.begin(t), user.Subject, nil)
	answer := b.send(http.MethodGet, callback.RequestURI(), "", func(r *http.Request) { r.Host = "evil.test" })
	assertRedirect(t, "another Host", answer, targetSignedIn)
}

func TestAFaultOfTheCallbackIsNotALoginFailureAndLogsNoSecret(t *testing.T) {
	h := newHTTPStack(t, 0)
	b := h.browser(t)
	callback := h.idp.authorize(t, b.begin(t), "any-subject", nil)
	exec(t, h.conn, `REVOKE ALL ON oidc_login_attempt FROM product_identity`)
	answer := b.send(http.MethodGet, callback.RequestURI(), "")
	if answer.Code != http.StatusServiceUnavailable || answer.Body.String() != unavailable {
		t.Fatalf("%d %s", answer.Code, answer.Body)
	}
	if b.cookie(httpapi.BrowserCookie) == "" {
		t.Error("a fault cleared the browser cookie, so the browser cannot try the attempt again")
	}
	logged := h.log.String()
	if logged == "" {
		t.Error("the fault was not logged")
	}
	for _, secret := range []string{callback.Query().Get("code"), callback.Query().Get("state"), b.cookie(httpapi.BrowserCookie)} {
		if secret == "" || strings.Contains(logged, secret) {
			t.Errorf("the log holds a secret of the request: %s", logged)
		}
	}
}

func TestLogoutOverItsRoutes(t *testing.T) {
	h := newHTTPStack(t, 0)
	user := fixture.Account(t, h.s, fixture.AccountSpec{Email: "logout@example.test"})
	other := fixture.Session(t, h.s, user.ID, fixture.SessionSpec{})
	b := h.browser(t)
	b.setSession(fixture.Session(t, h.s, user.ID, fixture.SessionSpec{}))
	answer := b.send(http.MethodPost, "/api/auth/logout", "")
	wantAnswer(t, "logout", answer, http.StatusOK, `{"status":"revoked"}`)
	if !slices.Contains(answer.Result().Header.Values("Set-Cookie"), "__Host-authz_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure") {
		t.Errorf("%v", answer.Result().Header.Values("Set-Cookie"))
	}
	if b.cookie(httpapi.SessionCookie) != "" {
		t.Error("the session cookie stayed")
	}
	if count := queryOne[int32](t, h.conn, unrevokedOfOwner, user.ID); count != 1 {
		t.Errorf("logout ended %d of the sessions", 2-count)
	}
	b.setSession(other)
	wantAnswer(t, "logout-all", b.send(http.MethodPost, "/api/auth/logout-all", ""), http.StatusOK, `{"status":"revoked"}`)
	if count := queryOne[int32](t, h.conn, unrevokedOfOwner, user.ID); count != 0 {
		t.Errorf("%d sessions stayed after logout-all", count)
	}
	b.setSession(other)
	wantAnswer(t, "the account after logout-all", b.send(http.MethodGet, "/api/auth/account", ""), http.StatusUnauthorized, authFailed)
}

func TestADeadSessionIsRefusedInTheOrderOfTheContract(t *testing.T) {
	h := newHTTPStack(t, 0)
	user := fixture.Account(t, h.s, fixture.AccountSpec{Email: "dead@example.test"})
	revoked := fixture.Session(t, h.s, user.ID, fixture.SessionSpec{})
	exec(t, h.conn, revokeSessionOf, digestOf(t, revoked))
	dead := credential.NewSessionSecret()
	for name, secret := range map[string]string{"absent": dead, "revoked": revoked} {
		b := h.browser(t)
		b.setSession(secret)
		h.modes.take()
		wantAnswer(t, name+", no CSRF", b.send(http.MethodPost, "/api/auth/mfa/totp/confirm", "{", func(r *http.Request) { r.Header.Del("X-Csrf-Token") }), http.StatusForbidden, denied)
		wantAnswer(t, name+", a bad body", b.send(http.MethodPost, "/api/auth/mfa/totp/confirm", "{}"), http.StatusBadRequest, invalid)
		if modes := h.modes.take(); len(modes) != 0 {
			t.Errorf("%s: a refused shape opened %v", name, modes)
		}
		wantAnswer(t, name+", a valid body", b.send(http.MethodPost, "/api/auth/mfa/totp/confirm", `{"code":"123456"}`), http.StatusUnauthorized, authFailed)
		if modes := h.modes.take(); len(modes) == 0 {
			t.Errorf("%s: no transaction resolved the session", name)
		}
		for _, path := range []string{"/api/auth/logout", "/api/auth/logout-all"} {
			wantAnswer(t, name+" at "+path, b.send(http.MethodPost, path, ""), http.StatusUnauthorized, authFailed)
			if modes := h.modes.take(); !slices.Equal(modes, []database.Mode{database.ModeRead}) {
				t.Errorf("%s at %s: %v, want only the shared fence", name, path, modes)
			}
		}
	}
}

func TestTheAccountOfNoEmailAnswersNull(t *testing.T) {
	h := newHTTPStack(t, 0)
	user := fixture.Account(t, h.s, fixture.AccountSpec{})
	b := h.browser(t)
	b.setSession(fixture.Session(t, h.s, user.ID, fixture.SessionSpec{}))
	answer := b.send(http.MethodGet, "/api/auth/account", "")
	if answer.Code != http.StatusOK || !strings.HasPrefix(answer.Body.String(), `{"email":null,"identities":[{"issuer":"`) {
		t.Errorf("%d %s", answer.Code, answer.Body)
	}
}

func forged(address string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("X-Forwarded-For", address) }
}

func TestAForgedForwardedHeaderDoesNotMoveTheLimiterAtHopZero(t *testing.T) {
	h := newHTTPStack(t, 0)
	b := h.browser(t)
	const begin = "/api/auth/oidc/begin"
	body := `{"issuer":"` + test.FixtureIssuer + `"}`
	for attempt := range 20 {
		if answer := b.send(http.MethodPost, begin, body, forged("198.51.100."+strconv.Itoa(attempt+1))); answer.Code != http.StatusOK {
			t.Fatalf("attempt %d: %d %s", attempt, answer.Code, answer.Body)
		}
	}
	wantAnswer(t, "the socket's 21st begin", b.send(http.MethodPost, begin, body, forged("198.51.100.200")), http.StatusUnauthorized, authFailed)
}

func TestTheTrustedHopChoosesTheClientOfTheLimiter(t *testing.T) {
	h := newHTTPStack(t, 1)
	b := h.browser(t)
	const begin = "/api/auth/oidc/begin"
	body := `{"issuer":"` + test.FixtureIssuer + `"}`
	for attempt := range 21 {
		if answer := b.send(http.MethodPost, begin, body, forged("198.51.100."+strconv.Itoa(attempt+1))); answer.Code != http.StatusOK {
			t.Fatalf("attempt %d of its own client: %d %s", attempt, answer.Code, answer.Body)
		}
	}
	for attempt := range 20 {
		if answer := b.send(http.MethodPost, begin, body, forged("203.0.113.5")); answer.Code != http.StatusOK {
			t.Fatalf("attempt %d: %d %s", attempt, answer.Code, answer.Body)
		}
	}
	wantAnswer(t, "the client's 21st begin", b.send(http.MethodPost, begin, body, forged("203.0.113.5")), http.StatusUnauthorized, authFailed)
}

// The account is limited from any client; the hop decides which client each attempt also counts for.
func TestTheSecondFactorRoutesCountTheAccountAndTheClientOfTheHop(t *testing.T) {
	for hop, c := range map[int]struct {
		buckets func(int32) bool
	}{
		0: {func(count int32) bool { return count <= 3 }},
		1: {func(count int32) bool { return count > 20 }},
	} {
		h := newHTTPStack(t, hop)
		user := fixture.Account(t, h.s, fixture.AccountSpec{Email: "limited@example.test"})
		b := h.browser(t)
		b.setSession(fixture.Session(t, h.s, user.ID, fixture.SessionSpec{}))
		for attempt := range 20 {
			answer := b.send(http.MethodPost, "/api/auth/mfa/verify", `{"code":"123456"}`, forged("198.51.100."+strconv.Itoa(attempt+1)))
			if answer.Code != http.StatusConflict {
				t.Fatalf("hop %d, attempt %d: %d %s", hop, attempt, answer.Code, answer.Body)
			}
		}
		wantAnswer(t, "the 21st attempt of the account", b.send(http.MethodPost, "/api/auth/mfa/verify", `{"code":"123456"}`, forged("198.51.100.200")), http.StatusUnauthorized, authFailed)
		if count := queryOne[int32](t, h.conn, limiterBuckets); !c.buckets(count) {
			t.Errorf("hop %d: %d buckets", hop, count)
		}
	}
}

// Every route that counts an attempt counts the client of the hop: the client's bucket has a row, the bucket
// of the other candidate has none. The table is emptied per route, so no row comes from another route.
func TestEveryRouteOfTheLimiterCountsTheClientOfTheHop(t *testing.T) {
	const socket, forwarded = "192.0.2.1", "198.51.100.7"
	issuerBody := `{"issuer":"` + test.FixtureIssuer + `"}`
	activateBody := `{"issuer":"` + test.FixtureIssuer + `","token":"` + credential.NewSessionSecret() + `"}`
	routes := []struct {
		method, path, body, purpose string
		session                     bool
	}{
		{http.MethodPost, "/api/auth/mfa/totp/setup", "", "mfa", true},
		{http.MethodPost, "/api/auth/mfa/totp/confirm", `{"code":"123456"}`, "mfa", true},
		{http.MethodPost, "/api/auth/mfa/verify", `{"code":"123456"}`, "mfa", true},
		{http.MethodPost, "/api/auth/mfa/recovery-codes", "", "mfa", true},
		{http.MethodDelete, "/api/auth/mfa/totp", "", "mfa", true},
		{http.MethodPost, "/api/auth/oidc/begin", issuerBody, "oidc", false},
		{http.MethodPost, "/api/auth/oidc/activate", activateBody, "oidc", false},
	}
	for hop, c := range map[int]struct{ counted, other string }{
		0: {socket, forwarded},
		1: {forwarded, socket},
	} {
		h := newHTTPStack(t, hop)
		for _, route := range routes {
			exec(t, h.conn, `DELETE FROM rate_limit`)
			b := h.browser(t)
			if route.session {
				user := fixture.Account(t, h.s, fixture.AccountSpec{})
				b.setSession(fixture.Session(t, h.s, user.ID, fixture.SessionSpec{}))
			}
			b.send(route.method, route.path, route.body, forged(forwarded))
			for client, want := range map[string]int32{c.counted: 1, c.other: 0} {
				buckets, err := credential.RateLimitBuckets(client, client, route.purpose)
				if err != nil {
					t.Fatal(err)
				}
				if got := queryOne[int32](t, h.conn, bucketRows, buckets[0].Key); got != want {
					t.Errorf("hop %d, %s %s, client %s: %d rows, want %d", hop, route.method, route.path, client, got, want)
				}
			}
		}
	}
}

func TestBeginSetsTheBrowserCookieAndRefusesAnUnknownIssuer(t *testing.T) {
	h := newHTTPStack(t, 0)
	b := h.browser(t)
	answer := b.send(http.MethodPost, "/api/auth/oidc/begin", `{"issuer":"`+test.FixtureIssuer+`"}`)
	if want := "__Host-authz_browser=" + b.cookie(httpapi.BrowserCookie) + "; Path=/; Max-Age=600; SameSite=Lax; HttpOnly; Secure"; !slices.Contains(answer.Result().Header.Values("Set-Cookie"), want) {
		t.Errorf("%v", answer.Result().Header.Values("Set-Cookie"))
	}
	if strings.Contains(answer.Body.String(), "\x5cu0026") {
		t.Errorf("the URL was escaped for HTML: %s", answer.Body)
	}
	before := queryOne[int32](t, h.conn, attemptsTotal)
	for name, body := range map[string]string{
		"unknown":          `{"issuer":"https://other.fixture"}`,
		"empty":            `{"issuer":""}`,
		"a NUL":            `{"issuer":"` + test.FixtureIssuer + nulEscape + `"}`,
		"the longest form": `{"issuer":"` + strings.Repeat("x", 2048) + `"}`,
	} {
		wantAnswer(t, name, b.send(http.MethodPost, "/api/auth/oidc/begin", body), http.StatusUnauthorized, authFailed)
	}
	if after := queryOne[int32](t, h.conn, attemptsTotal); after != before {
		t.Errorf("%d attempts, was %d", after, before)
	}
}

func TestTheRootActivatesThroughItsRoutes(t *testing.T) {
	h := newHTTPStack(t, 0)
	rootID, token := pendingRoot(t, h.s, "bootstrap", "--operation", "8e0f8a4e-3c55-4a8a-9a43-3c7b6f1f2a10", "--email", "root@example.test")
	b := h.browser(t)
	const activate = "/api/auth/oidc/activate"
	for name, body := range map[string]string{
		"an unknown token": `{"issuer":"` + test.FixtureIssuer + `","token":"` + credential.NewSessionSecret() + `"}`,
		"an empty token":   `{"issuer":"` + test.FixtureIssuer + `","token":""}`,
		"a NUL":            `{"issuer":"` + test.FixtureIssuer + `","token":"` + token + nulEscape + `"}`,
		"another issuer":   `{"issuer":"https://other.fixture","token":"` + token + `"}`,
	} {
		wantAnswer(t, name, b.send(http.MethodPost, activate, body), http.StatusUnauthorized, authFailed)
	}
	var begun struct {
		AuthorizationURL string `json:"authorizationUrl"`
	}
	decodeAnswer(t, b.send(http.MethodPost, activate, `{"issuer":"`+test.FixtureIssuer+`","token":"`+token+`"}`), &begun)
	if b.cookie(httpapi.BrowserCookie) == "" {
		t.Fatal("no browser cookie")
	}
	answer := b.send(http.MethodGet, h.idp.authorize(t, begun.AuthorizationURL, "root-subject", verifiedEmailClaims("root@example.test")).RequestURI(), "")
	assertRedirect(t, "the activation", answer, targetSignedIn)
	identity, err := resolve(t, h.s, database.ModeRead, b.cookie(httpapi.SessionCookie))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if identity.UserID != rootID || identity.Kind != "root" || identity.Fresh {
		t.Errorf("%+v", identity)
	}
	answer = b.send(http.MethodGet, h.idp.authorize(t, b.begin(t), "root-subject", nil).RequestURI(), "")
	assertRedirect(t, "a later login of the Root", answer, targetSignedIn)
	if fresh(t, h.s, b.cookie(httpapi.SessionCookie)) {
		t.Error("a login of the Root made the session fresh")
	}
	own := b.send(http.MethodGet, "/api/auth/account", "")
	var account accountAnswer
	decodeAnswer(t, own, &account)
	if strings.Contains(own.Body.String(), "root-subject") || len(account.Identities) != 1 || account.Identities[0].Reference == "" {
		t.Errorf("%s", own.Body)
	}
}
