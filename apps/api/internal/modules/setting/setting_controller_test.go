package setting

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/httpapi"
)

const routesOrigin = "https://app.fixture"

var _ Port = (*Service)(nil)

type allowShape struct{}

func (allowShape) Authenticate(*http.Request) error { return nil }

// recordingPort answers every read with found and records each call, so a test sees what reached it.
type recordingPort struct {
	found bool
	err   error
	calls []string
}

func (p *recordingPort) List(_ context.Context, secret string) (ListView, bool, error) {
	p.calls = append(p.calls, "list "+secret)
	return ListView{Settings: []View{}, CanUpdate: CanUpdate{Rule: true}}, p.found, p.err
}
func (p *recordingPort) Profile(_ context.Context, secret string) (ProfileView, bool, error) {
	p.calls = append(p.calls, "profile "+secret)
	return ProfileView{CompanyName: "X", DefaultLocale: "vi"}, p.found, p.err
}
func (p *recordingPort) Security(_ context.Context, secret string) (SecurityView, bool, error) {
	p.calls = append(p.calls, "security "+secret)
	return SecurityPolicy(), p.found, p.err
}
func (p *recordingPort) History(_ context.Context, secret string, query HistoryQuery) (HistoryView, bool, error) {
	p.calls = append(p.calls, fmt.Sprintf("history %s %s %d %d", secret, query.Key, query.Limit, query.Offset))
	return HistoryView{Total: "0"}, p.found, p.err
}
func (p *recordingPort) Update(_ context.Context, secret string, input UpdateInput) (UpdateResult, error) {
	p.calls = append(p.calls, fmt.Sprintf("update %s %s %+v %s", secret, input.Key, input.Value, input.ExpectedVersion))
	return UpdateResult{Version: "1"}, p.err
}

func settingRoutes(t *testing.T, port Port) http.Handler {
	t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), allowShape{}, func(resource, action string) bool { return resource == "setting" })
	if err := (Routes{Settings: port, Origin: routesOrigin}).Register(group); err != nil {
		t.Fatal(err)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
	return httpapi.NewHandler(engine)
}

func request(method, target, body string, csrf bool) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Origin", routesOrigin)
	cookie := "__Host-authz_session=s3cret"
	if csrf {
		token := strings.Repeat("c", 43)
		r.Header.Set("X-Csrf-Token", token)
		cookie += "; __Host-authz_csrf=" + token
	}
	r.Header.Set("Cookie", cookie)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	return r
}

func serve(handler http.Handler, r *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, r)
	return recorder
}

func TestEachPutParsesForTheGroupOfItsRouteWithTheSessionSecret(t *testing.T) {
	port := &recordingPort{found: true}
	handler := settingRoutes(t, port)
	for target, body := range map[string]string{
		"/api/administration/settings/rule/hr.wfhMonthLimit": `{"value":6,"expectedVersion":"0"}`,
		"/api/administration/settings/profile/company.name":  `{"value":"X","expectedVersion":"0"}`,
	} {
		answer := serve(handler, request(http.MethodPut, target, body, true))
		if answer.Code != http.StatusOK || answer.Body.String() != `{"version":"1"}` {
			t.Fatalf("%s: %d %s", target, answer.Code, answer.Body)
		}
	}
	for target, body := range map[string]string{
		"/api/administration/settings/rule/company.name":        `{"value":"X","expectedVersion":"0"}`,
		"/api/administration/settings/profile/hr.wfhMonthLimit": `{"value":6,"expectedVersion":"0"}`,
		"/api/administration/settings/rule/hr.wfhMonthLimit":    `{"value":6,"expectedVersion":"0","extra":1}`,
		"/api/administration/settings/rule/hr.nope":             `{"value":6,"expectedVersion":"0"}`,
	} {
		answer := serve(handler, request(http.MethodPut, target, body, true))
		if answer.Code != http.StatusBadRequest || answer.Body.String() != `{"statusCode":400,"code":"error.invalidRequest"}` {
			t.Errorf("%s %s: %d %s", target, body, answer.Code, answer.Body)
		}
	}
	for _, body := range []string{`null`, `[]`, `"x"`, `{`} {
		if answer := serve(handler, request(http.MethodPut, "/api/administration/settings/rule/hr.wfhMonthLimit", body, true)); answer.Code != http.StatusBadRequest {
			t.Errorf("body %s: %d", body, answer.Code)
		}
	}
	slices.Sort(port.calls)
	if !slices.Equal(port.calls, []string{
		"update s3cret company.name {Kind:2 Int:0 Text:X} 0",
		"update s3cret hr.wfhMonthLimit {Kind:1 Int:6 Text:} 0",
	}) {
		t.Fatalf("calls: %q", port.calls)
	}
}

func TestAPutWithoutAValidCSRFTokenIs403BeforeTheBodyIsParsed(t *testing.T) {
	port := &recordingPort{found: true}
	handler := settingRoutes(t, port)
	for target, body := range map[string]string{
		"/api/administration/settings/rule/hr.wfhMonthLimit": `garbage`,
		"/api/administration/settings/profile/company.name":  `null`,
		"/api/administration/settings/rule/hr.nope":          `{}`,
	} {
		answer := serve(handler, request(http.MethodPut, target, body, false))
		if answer.Code != http.StatusForbidden || answer.Body.String() != `{"statusCode":403,"code":"error.accessDenied"}` {
			t.Errorf("%s: %d %s", target, answer.Code, answer.Body)
		}
	}
	foreign := request(http.MethodPut, "/api/administration/settings/rule/hr.wfhMonthLimit", `{}`, true)
	foreign.Header.Set("Origin", "https://evil.test")
	if answer := serve(handler, foreign); answer.Code != http.StatusForbidden {
		t.Errorf("foreign origin: %d", answer.Code)
	}
	if len(port.calls) != 0 {
		t.Fatalf("calls: %q", port.calls)
	}
}

func TestAReadThatReachesNothingIs404AndAViewIsAnsweredAsIs(t *testing.T) {
	empty := &recordingPort{}
	handler := settingRoutes(t, empty)
	for _, target := range []string{
		"/api/administration/settings", "/api/administration/settings/profile", "/api/administration/settings/security",
		"/api/administration/settings/hr.wfhMonthLimit/history",
	} {
		answer := serve(handler, request(http.MethodGet, target, "", false))
		if answer.Code != http.StatusNotFound || answer.Body.String() != `{"statusCode":404,"code":"error.notFound"}` {
			t.Errorf("%s: %d %s", target, answer.Code, answer.Body)
		}
	}
	for _, target := range []string{"/api/administration/settings/nope/history", "/api/administration/settings/hr.wfhMonthLimit/history?limit=0", "/api/administration/settings/hr.wfhMonthLimit/history?key=x"} {
		if answer := serve(handler, request(http.MethodGet, target, "", false)); answer.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", target, answer.Code)
		}
	}
	if len(empty.calls) != 4 || empty.calls[3] != "history s3cret hr.wfhMonthLimit 20 0" {
		t.Fatalf("calls: %q", empty.calls)
	}
	found := &recordingPort{found: true}
	handler = settingRoutes(t, found)
	for target, want := range map[string]string{
		"/api/administration/settings":                                           `{"settings":[],"canUpdate":{"rule":true,"profile":false}}`,
		"/api/administration/settings/profile":                                   `{"companyName":"X","defaultLocale":"vi"}`,
		"/api/administration/settings/security":                                  `{"freshAuthenticationSeconds":300,"sessionHours":12,"rateLimitWindowMinutes":15,"oidcAttemptMinutes":5,"idleMinutes":30}`,
		"/api/administration/settings/hr.wfhMonthLimit/history?limit=5&offset=2": `{"items":[],"total":"0"}`,
	} {
		answer := serve(handler, request(http.MethodGet, target, "", false))
		if answer.Code != http.StatusOK || answer.Body.String() != want {
			t.Errorf("%s: %d %s", target, answer.Code, answer.Body)
		}
	}
	if !strings.Contains(strings.Join(found.calls, ","), "history s3cret hr.wfhMonthLimit 5 2") {
		t.Fatalf("calls: %q", found.calls)
	}
	for status, err := range map[int]error{http.StatusForbidden: apperror.ErrAccessDenied, http.StatusConflict: apperror.ErrCommandRejected, http.StatusUnauthorized: apperror.ErrAuthenticationFailed} {
		handler = settingRoutes(t, &recordingPort{err: err})
		if answer := serve(handler, request(http.MethodGet, "/api/administration/settings", "", false)); answer.Code != status {
			t.Errorf("list %v: %d", err, answer.Code)
		}
		if answer := serve(handler, request(http.MethodPut, "/api/administration/settings/rule/hr.wfhMonthLimit", `{"value":6,"expectedVersion":"0"}`, true)); answer.Code != status {
			t.Errorf("update %v: %d", err, answer.Code)
		}
	}
}
