package employee

import (
	"context"
	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/httpapi"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func (readPort) Create(context.Context, string, CreateInput) (Created, error) {
	return Created{ID: testID}, nil
}
func (readPort) Update(context.Context, string, UpdateInput) (Versioned, error) {
	return Versioned{Version: "2"}, nil
}
func (readPort) Official(context.Context, string, OfficialInput) (Versioned, error) {
	return Versioned{Version: "2"}, nil
}
func (readPort) Terminate(context.Context, string, TerminationInput) (Versioned, error) {
	return Versioned{Version: "2"}, nil
}
func (readPort) UpdateIdentity(context.Context, string, IdentityUpdateInput) (Versioned, error) {
	return Versioned{Version: "2"}, nil
}
func (readPort) AdjustLeaveRate(context.Context, string, LeaveRateInput) (Created, error) {
	return Created{ID: testID}, nil
}
func (readPort) LinkAccount(context.Context, string, AccountLinkInput) (Versioned, error) {
	return Versioned{Version: "2"}, nil
}

func TestEmployeeWriteRoutesCSRFAndStrictBodies(t *testing.T) {
	const origin = "http://localhost:3000"
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(io.Discard, nil)))
	group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: origin}, func(string, string) bool { return true })
	if err := (Routes{Employees: readPort{}, Origin: origin}).Register(group); err != nil {
		t.Fatal(err)
	}
	identity := identityJSON(nil)
	for _, tc := range []struct {
		method, suffix, body string
		success              int
	}{
		{"POST", "", `{"code":"NV1","fullName":"Fixture","hiredOn":"2026-01-05","status":"official","position":null,"classification":null,"identity":` + identity + `}`, 201},
		{"PATCH", "/" + testID, `{"expectedVersion":"1","code":"NV1","fullName":"Fixture","position":null,"classification":null}`, 200},
		{"POST", "/" + testID + "/official", `{"effectiveOn":"2026-02-01"}`, 200},
		{"POST", "/" + testID + "/termination", `{"terminatedOn":"2026-03-15"}`, 200},
		{"POST", "/" + testID + "/leave-rates", `{"effectiveFrom":"2026-02-01","annualMinutes":6000}`, 201},
		{"PUT", "/" + testID + "/identity", `{"expectedVersion":"1","identity":` + identity + `}`, 200},
		{"PUT", "/" + testID + "/account", `{"expectedVersion":"1","accountId":null}`, 200},
	} {
		for _, mode := range []string{"ok", "csrf", "origin", "extra"} {
			body := tc.body
			if mode == "csrf" {
				body = "{"
			}
			if mode == "extra" {
				body = strings.TrimSuffix(body, "}") + `,"extra":true}`
			}
			req := httptest.NewRequest(tc.method, "/api/hr/employees"+tc.suffix, strings.NewReader(body))
			token := strings.Repeat("A", 43)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Cookie", httpapi.CookieName(origin, httpapi.SessionCookie)+"="+token+"; "+httpapi.CookieName(origin, httpapi.CSRFCookie)+"="+token)
			req.Header.Set("Origin", origin)
			req.Header.Set("X-Csrf-Token", token)
			want := tc.success
			switch mode {
			case "csrf":
				req.Header.Del("X-Csrf-Token")
				want = 403
			case "origin":
				req.Header.Set("Origin", "https://foreign.example.test")
				want = 403
			case "extra":
				want = 400
			}
			out := httptest.NewRecorder()
			engine.ServeHTTP(out, req)
			if out.Code != want {
				t.Errorf("%s %s %s: %d %s, want %d", tc.method, tc.suffix, mode, out.Code, out.Body.String(), want)
			}
		}
	}
}
