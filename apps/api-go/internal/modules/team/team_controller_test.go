package team

import (
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

type recordingPort struct {
	calls  int
	secret string
	input  string
	err    error
}

func (p *recordingPort) record(secret, input string) error {
	p.calls++
	p.secret = secret
	p.input = input
	return p.err
}
func (p *recordingPort) List(_ context.Context, s string, q ListQuery) (ListView, error) {
	return ListView{Items: []Summary{}, Total: "0"}, p.record(s, "list")
}
func (p *recordingPort) Detail(_ context.Context, s, id string) (View, error) {
	return View{ID: id, Version: "1"}, p.record(s, id)
}
func (p *recordingPort) Create(_ context.Context, s string, i CreateInput) (Created, error) {
	return Created{ID: testID}, p.record(s, i.Name)
}
func (p *recordingPort) Rename(_ context.Context, s string, i RenameInput) (Renamed, error) {
	return Renamed{Version: "2"}, p.record(s, i.TeamID)
}
func (p *recordingPort) AddMember(_ context.Context, s string, i MemberInput) (Status, error) {
	return Status{Status: "added"}, p.record(s, i.EmployeeID)
}
func (p *recordingPort) SetPrimary(_ context.Context, s string, i MembershipRef) (Status, error) {
	return Status{Status: "primary"}, p.record(s, i.EmployeeID)
}
func (p *recordingPort) EndMembership(_ context.Context, s string, i MembershipRef) (Status, error) {
	return Status{Status: "ended"}, p.record(s, i.EmployeeID)
}
func (p *recordingPort) AssignLead(_ context.Context, s string, i LeadInput) (Status, error) {
	return Status{Status: "assigned"}, p.record(s, i.TeamID)
}

type cookieAuth struct{}

func (cookieAuth) Authenticate(r *http.Request) error {
	secret, err := httpapi.SessionSecret(r, testOrigin)
	if err != nil {
		return err
	}
	if secret == "" {
		return apperror.ErrAuthenticationFailed
	}
	return nil
}

func TestTeamRoutesRegistrationAndDispatch(t *testing.T) {
	p := &recordingPort{}
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(io.Discard, nil)))
	permissions := func(resource, action string) bool {
		return resource == "team" || (resource == "hrCompany" && action == "createTeam")
	}
	group := httpapi.NewGroup(engine.Group(""), cookieAuth{}, permissions)
	if err := (Routes{Teams: p, Origin: testOrigin}).Register(group); err != nil {
		t.Fatal(err)
	}
	if len(group.Routes()) != 8 {
		t.Fatalf("registered %d routes, want 8", len(group.Routes()))
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Fatal(err)
	}
	for _, route := range group.Routes() {
		action := "assign"
		resource := "team"
		switch {
		case route.Method == "GET":
			action = "read"
		case route.Method == "PATCH":
			action = "update"
		case route.Path == "/api/hr/teams":
			resource = "hrCompany"
			action = "createTeam"
		}
		if route.Classification != enforcement.Authorize(resource, action) {
			t.Fatal("route classification mismatch")
		}
	}
	for _, tc := range []struct {
		method, suffix, body string
		status               int
		field, value         string
	}{
		{"GET", "?limit=100", "", 200, "total", "0"},
		{"POST", "", `{"name":" Team "}`, 201, "id", testID},
		{"GET", "/" + testID, "", 200, "id", testID},
		{"PATCH", "/" + testID, `{"expectedVersion":"1","name":"Renamed"}`, 200, "version", "2"},
		{"PUT", "/" + testID + "/lead", `{"employeeId":null}`, 200, "status", "assigned"},
		{"POST", "/" + testID + "/members", `{"employeeId":"` + testID + `","primary":false}`, 200, "status", "added"},
		{"DELETE", "/" + testID + "/members/" + testID, "", 200, "status", "ended"},
		{"POST", "/" + testID + "/members/" + testID + "/primary", "", 200, "status", "primary"},
	} {
		t.Run(tc.method+tc.suffix, func(t *testing.T) {
			c := inputContext(tc.body)
			c.Request.Method = tc.method
			c.Request.URL.Path = "/api/hr/teams" + strings.Split(tc.suffix, "?")[0]
			if strings.Contains(tc.suffix, "?") {
				c.Request.URL.RawQuery = "limit=100"
			}
			c.Request.Header.Add("Cookie", "__Host-authz_session=fixture-session")
			w := httptest.NewRecorder()
			before := p.calls
			engine.ServeHTTP(w, c.Request)
			if w.Code != tc.status || p.calls != before+1 || p.secret != "fixture-session" {
				t.Fatalf("status %d calls %d body %s", w.Code, p.calls-before, w.Body.String())
			}
			var answer map[string]jsontext.Value
			if err := json.Unmarshal(w.Body.Bytes(), &answer); err != nil {
				t.Fatal(err)
			}
			var value string
			if err := json.Unmarshal(answer[tc.field], &value); err != nil || value != tc.value {
				t.Fatalf("response field %s: %s", tc.field, w.Body.String())
			}
		})
	}
}

func TestTeamHandlerRefusesInputBeforeFacade(t *testing.T) {
	p := &recordingPort{}
	engine := httpapi.NewEngine(slog.New(slog.NewTextHandler(io.Discard, nil)))
	group := httpapi.NewGroup(engine.Group(""), cookieAuth{}, func(string, string) bool { return true })
	if err := (Routes{Teams: p, Origin: testOrigin}).Register(group); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		method, suffix, body string
		status               int
		csrf                 bool
	}{
		{"POST", "", `{"name":"ok","other":true}`, 400, true},
		{"PUT", "/" + testID + "/lead", `{}`, 400, true},
		{"GET", "?limit=1&limit=2", "", 400, true},
		{"GET", "/bad", "", 400, true},
		{"POST", "", `broken`, 403, false},
		{"DELETE", "/" + testID + "/members/" + testID, "", 403, false},
		{"POST", "/" + testID + "/members/" + testID + "/primary", "", 403, false},
	} {
		c := inputContext(tc.body)
		c.Request.Method = tc.method
		c.Request.URL.Path = "/api/hr/teams" + strings.Split(tc.suffix, "?")[0]
		if strings.Contains(tc.suffix, "?") {
			c.Request.URL.RawQuery = "limit=1&limit=2"
		}
		c.Request.Header.Add("Cookie", "__Host-authz_session=fixture-session")
		if !tc.csrf {
			c.Request.Header.Del("X-Csrf-Token")
		}
		w := httptest.NewRecorder()
		engine.ServeHTTP(w, c.Request)
		if w.Code != tc.status || p.calls != 0 {
			t.Fatalf("%s %s: status %d calls %d", tc.method, tc.suffix, w.Code, p.calls)
		}
	}
	p.err = apperror.ErrNotFound
	c := inputContext("")
	c.Request.Method = "GET"
	c.Request.URL.Path = "/api/hr/teams/" + testID
	c.Request.Header.Add("Cookie", "__Host-authz_session=fixture-session")
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, c.Request)
	if w.Code != 404 || w.Body.String() != `{"statusCode":404,"code":"error.notFound"}` {
		t.Fatalf("error shape: %d %s", w.Code, w.Body.String())
	}
}
