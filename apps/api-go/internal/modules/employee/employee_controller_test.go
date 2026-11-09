package employee

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

type readPort struct{}

func (readPort) List(context.Context, string, ListQuery) (ListView, error) {
	return ListView{Total: "0"}, nil
}
func (readPort) Detail(_ context.Context, _ string, id string) (View, error) {
	return View{ID: id}, nil
}
func (readPort) Identity(_ context.Context, _ string, id string) (IdentityView, error) {
	return IdentityView{EmployeeID: id}, nil
}
func (readPort) LeaveRates(context.Context, string, string) (LeaveRateListView, error) {
	return LeaveRateListView{}, nil
}
func (readPort) Profile(context.Context, string) (SelfView, error) {
	return SelfView{CompanyScope: true}, nil
}

func TestEmployeeReadRoutesDispatchClassificationAndItemsShape(t *testing.T) {
	const origin = "http://localhost:3000"
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(io.Discard, nil)))
	group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: origin}, func(string, string) bool { return true })
	if err := (Routes{Employees: readPort{}, Origin: origin}).Register(group); err != nil {
		t.Fatal(err)
	}
	if len(group.Routes()) != 12 {
		t.Fatalf("registered %d employee routes, want 12", len(group.Routes()))
	}
	for _, route := range group.Routes() {
		if route.Path == "/api/hr/employees/me" && route.Classification != enforcement.Authenticated() {
			t.Fatal("me must be authenticated")
		}
	}
	for _, tc := range []struct{ suffix, contains string }{
		{"", `"items":[]`}, {"/" + testID, `"id":"` + testID + `"`},
		{"/" + testID + "/identity", `"employeeId":"` + testID + `"`},
		{"/" + testID + "/leave-rates", `{"items":[]}`}, {"/me", `{"employee":null,"companyScope":true}`},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/hr/employees"+tc.suffix, nil)
		req.Header.Set("Cookie", httpapi.CookieName(origin, httpapi.SessionCookie)+"="+strings.Repeat("A", 43))
		out := httptest.NewRecorder()
		engine.ServeHTTP(out, req)
		if out.Code != 200 || !strings.Contains(out.Body.String(), tc.contains) {
			t.Fatalf("%s: %d %s", tc.suffix, out.Code, out.Body.String())
		}
	}
}
