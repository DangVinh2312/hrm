//go:build integration

package app

import (
	"encoding/json/v2"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/test/fixture"
	"regexp"
	"slices"
	"strings"
	"testing"
)

const m2Identity = `{"dateOfBirth":null,"documentKind":null,"documentNumber":null,"taxCode":null,"gender":null,"phone":null,"workEmail":null}`
const m2State = `SELECT concat_ws('|',
 (SELECT revision::text FROM authz_state WHERE singleton),
 (SELECT count(*)||':'||coalesce(sum(version),0) FROM employee),
 (SELECT count(*)||':'||coalesce(sum(version),0) FROM employee_identity),
 (SELECT count(*) FROM employment_status_period),
 (SELECT count(*) FROM leave_rate),
 (SELECT count(*) FROM object_ref),
 (SELECT count(*) FROM audit_outbox))`

func m2CreateBody(w *m1World) string {
	return `{"code":"` + strings.ReplaceAll(w.name(), " ", "-") + `","fullName":"Matrix employee","hiredOn":"2026-01-05","status":"probation","position":null,"classification":null,"identity":` + m2Identity + `}`
}
func m2Employee(t *testing.T, w *m1World) string {
	t.Helper()
	var value struct {
		ID string `json:"id"`
	}
	body := w.asRoot(t, "POST", m1Request{"/api/hr/employees", m2CreateBody(w)}, 201)
	if err := json.Unmarshal([]byte(body), &value); err != nil {
		t.Fatal(err)
	}
	return value.ID
}
func m2Target(suffix, body string) func(*testing.T, *m1World) m1Request {
	return func(t *testing.T, w *m1World) m1Request {
		updated := strings.Replace(body, "UPDATED", strings.ReplaceAll(w.name(), " ", "-"), 1)
		return m1Request{"/api/hr/employees/" + m2Employee(t, w) + suffix, updated}
	}
}
func m2ReadCells(list bool) m1Cells {
	c := m1Read()
	c.absentEmployee = m1NA("employee is the target, no second key")
	c.noGrant, c.deny, c.foreign, c.absent = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404)
	c.invalid = m1Refused(400)
	if list {
		c.noGrant, c.deny = m1Cell{status: 200, body: `{"items":[],"total":"0"}`}, m1Cell{status: 200, body: `{"items":[],"total":"0"}`}
		c.foreign = m1NA("scope filters the list")
		c.absent = m1NA("no target key")
	}
	return c
}
func m2WriteCells(fresh, boundary, create bool) m1Cells {
	c := m1Write()
	c.noGrant, c.deny, c.foreign, c.absent = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404)
	c.boundary = m1NA("boundary is optional for this action")
	c.fresh = m1NA("policy has no fresh requirement")
	c.absentEmployee = m1NA("employee is the target, no second key")
	c.invalid, c.extra = m1Refused(400), m1Refused(400)
	if fresh {
		c.fresh = m1Refused(403)
	}
	if boundary {
		c.noGrant, c.boundary = m1Refused(403), m1Refused(403)
	}
	if create {
		c.noGrant, c.deny = m1Refused(403), m1Refused(403)
		c.foreign = m1NA("target is the company anchor")
		c.absent = m1NA("no target key")
	}
	return c
}

var m2Matrix = map[httpapi.Route]m1Row{
	{Method: "GET", Path: "/api/hr/employees"}:              {cells: m2ReadCells(true), prepare: func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/hr/employees"} }, invalid: []m1Edit{m1Query("limit=101"), m1Query("limit=1&limit=2"), m1Query("sort=code")}, shape: m1Page, rootAudit: "access.employee.read"},
	{Method: "GET", Path: "/api/hr/employees/:id"}:          {cells: m2ReadCells(false), prepare: m2Target("", ""), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad")}, shape: regexp.MustCompile(`^\{"id":"` + m1UUID + `","code":.*"periods":\[.*\],"teams":\[.*\].*\}$`), rootAudit: "access.employee.read"},
	{Method: "GET", Path: "/api/hr/employees/:id/identity"}: {cells: m2ReadCells(false), prepare: m2Target("/identity", ""), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad")}, shape: regexp.MustCompile(`^\{"employeeId":"` + m1UUID + `","version":"1",.*"workEmail":null\}$`), rootAudit: "access.employeeIdentity.read"},
	{Method: "GET", Path: "/api/hr/employees/:id/leave-rates"}: {cells: m1With(m2ReadCells(false), func(c *m1Cells) {
		empty := m1Cell{status: 200, body: `{"items":[]}`}
		c.noGrant, c.deny, c.foreign, c.absent = empty, empty, empty, empty
	}), prepare: m2Target("/leave-rates", ""), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad")}, shape: regexp.MustCompile(`^\{"items":\[.*\]\}$`), rootAudit: "access.leaveRate.read"},
	{Method: "POST", Path: "/api/hr/employees"}:                 {cells: m2WriteCells(true, false, true), prepare: func(t *testing.T, w *m1World) m1Request { return m1Request{"/api/hr/employees", m2CreateBody(w)} }, invalid: []m1Edit{m1Body(`{}`), m1Body(`{"fullName":"x"}`)}, extra: m1Extra, shape: regexp.MustCompile(`^\{"id":"` + m1UUID + `"\}$`), audit: "hr.employee.create", rootAudit: "hr.employee.create"},
	{Method: "PATCH", Path: "/api/hr/employees/:id"}:            {cells: m2WriteCells(false, false, false), prepare: m2Target("", `{"expectedVersion":"1","code":"UPDATED","fullName":"Updated","position":null,"classification":null}`), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad"), m1Body(`{}`)}, extra: m1Extra, shape: m1Version, audit: "hr.employee.update", rootAudit: "hr.employee.update"},
	{Method: "POST", Path: "/api/hr/employees/:id/official"}:    {cells: m2WriteCells(false, false, false), prepare: m2Target("/official", `{"effectiveOn":"2026-02-01"}`), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad"), m1Body(`{"effectiveOn":"2026-02-30"}`)}, extra: m1Extra, shape: m1Version, audit: "hr.employee.status", rootAudit: "hr.employee.status"},
	{Method: "POST", Path: "/api/hr/employees/:id/termination"}: {cells: m2WriteCells(false, false, false), prepare: m2Target("/termination", `{"terminatedOn":"2026-03-15"}`), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad"), m1Body(`{}`)}, extra: m1Extra, shape: m1Version, audit: "hr.employee.status", rootAudit: "hr.employee.status"},
	{Method: "POST", Path: "/api/hr/employees/:id/leave-rates"}: {cells: m2WriteCells(true, false, false), prepare: m2Target("/leave-rates", `{"effectiveFrom":"2026-02-01","annualMinutes":6000}`), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad"), m1Body(`{"effectiveFrom":"2026-02-01","annualMinutes":6000.0}`)}, extra: m1Extra, shape: regexp.MustCompile(`^\{"id":"` + m1UUID + `"\}$`), audit: "hr.leave-rate.adjust", rootAudit: "hr.leave-rate.adjust"},
	{Method: "PUT", Path: "/api/hr/employees/:id/identity"}:     {cells: m2WriteCells(true, false, false), prepare: m2Target("/identity", `{"expectedVersion":"1","identity":`+m2Identity+`}`), absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad"), m1Body(`{}`)}, extra: m1Extra, shape: m1Version, audit: "hr.employee-identity.update", rootAudit: "hr.employee-identity.update"},
	{Method: "PUT", Path: "/api/hr/employees/:id/account"}: {cells: m2WriteCells(true, true, false), prepare: func(t *testing.T, w *m1World) m1Request {
		account := fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{"hr.employee"}})
		return m1Request{"/api/hr/employees/" + m2Employee(t, w) + "/account", `{"expectedVersion":"1","accountId":"` + account.ID + `"}`}
	}, absent: m1Segment(4, m1Absent), invalid: []m1Edit{m1Segment(4, "bad"), m1Body(`{}`)}, extra: m1Extra, shape: m1Version, audit: "hr.employee.link-account", rootAudit: "hr.employee.link-account"},
}

var m2AuthenticatedMatrix = map[httpapi.Route]bool{
	{Method: "GET", Path: "/api/auth/session"}:    false,
	{Method: "GET", Path: "/api/auth/me"}:         false,
	{Method: "GET", Path: "/api/hr/employees/me"}: true,
}

func TestM2RoutesAreMigrated(t *testing.T) {
	for route := range m2Matrix {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s not migrated", route)
		}
	}
	for route := range m2AuthenticatedMatrix {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s not migrated", route)
		}
	}
	count := 0
	for _, route := range httpapi.MigratedRoutes {
		_, m4 := m4Matrix[route]
		if _, m5a := m5aMatrix[route]; m4 || m5a {
			continue
		}
		if strings.HasPrefix(route.Path, "/api/hr/employees") || route.Path == "/api/auth/me" || route.Path == "/api/auth/session" {
			count++
			_, authorized := m2Matrix[route]
			_, authenticated := m2AuthenticatedMatrix[route]
			if !authorized && !authenticated {
				t.Errorf("%s served with no M2 matrix", route)
			}
		}
	}
	if count != 14 {
		t.Errorf("%d M2 routes, want 14", count)
	}
}

func newM2World(t *testing.T) *m1World {
	w := newM1World(t)
	w.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) SELECT gen_random_uuid(),e.id,'probation',e.hired_on FROM employee e WHERE NOT EXISTS(SELECT FROM employment_status_period p WHERE p.employee_id=e.id)`)
	for _, actor := range []string{"hr", "denied", "scoped"} {
		w.exec(t, `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('employee.linkAccount','UTF8'),convert_to('hrAdministration','UTF8'),1)`, w.ids[actor])
	}
	for permission, template := range map[string]string{"employee.read": "allEmployees", "employee.update": "allEmployees", "employee.adjustLeaveRate": "allEmployees", "employee.linkAccount": "allEmployees", "employeeIdentity.read": "allIdentities", "employeeIdentity.update": "allIdentities", "leaveRate.read": "allLeaveRates", "hrCompany.createEmployee": "company"} {
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", template)
	}
	for _, action := range []string{"update", "adjustLeaveRate", "linkAccount"} {
		w.exec(t, m1InsertRule, w.ids["scoped"], "employee."+action, "allow", "selfEmployee")
	}
	w.exec(t, m1InsertRule, w.ids["scoped"], "employeeIdentity.update", "allow", "selfIdentity")
	return w
}

func TestTheM2RoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM2World(t)
	statuses := m1ContractStatuses(t)
	for _, route := range httpapi.MigratedRoutes {
		if row, ok := m2Matrix[route]; ok {
			t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, row, statuses[route]) })
		}
	}
}

func TestM2AuthenticatedRoutesWithRealSessions(t *testing.T) {
	w := newM2World(t)
	for route, profile := range m2AuthenticatedMatrix {
		path := route.Path
		for _, actor := range []string{"", "expired", "suspended"} {
			status, body := w.send("GET", actor, m1Request{target: path}, nil)
			if status != 401 || body != `{"statusCode":401,"code":"error.authenticationFailed"}` {
				t.Errorf("%s %s: %d %s", path, actor, status, body)
			}
		}
		for _, actor := range []string{"none", "hr", "root"} {
			status, body := w.send("GET", actor, m1Request{target: path}, nil)
			if status != 200 {
				t.Fatalf("%s %s: %d %s", path, actor, status, body)
			}
			if strings.Contains(body, "authEpoch") || strings.Contains(body, `"kind"`) || strings.Contains(body, "documentNumber") {
				t.Fatal("private field in bootstrap response")
			}
			if profile {
				var v struct {
					Employee     *struct{} `json:"employee"`
					CompanyScope bool      `json:"companyScope"`
				}
				if err := json.Unmarshal([]byte(body), &v); err != nil {
					t.Fatal(err)
				}
				if v.Employee != nil || v.CompanyScope != (actor != "none") {
					t.Fatalf("profile %s: %s", actor, body)
				}
			} else {
				var v struct {
					UserID string   `json:"userId"`
					Menus  []string `json:"menus"`
				}
				if err := json.Unmarshal([]byte(body), &v); err != nil {
					t.Fatal(err)
				}
				if v.UserID != w.ids[actor] {
					t.Fatal("wrong bootstrap identity")
				}
				if actor == "none" && len(v.Menus) != 0 {
					t.Fatal("roleless menu")
				}
				if actor == "root" && path == "/api/auth/me" && !slices.Equal(v.Menus, []string{"approvals", "employees", "teams", "calendar", "reports", "accounts", "settings", "roles"}) {
					t.Fatalf("Root menus: %v", v.Menus)
				}
			}
		}
	}
}
