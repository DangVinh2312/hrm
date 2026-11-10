//go:build integration

package app

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/test/fixture"
)

const m6State = `SELECT concat_ws('|',
 (SELECT count(*)||':'||coalesce(sum(version),0)||':'||count(*) FILTER (WHERE state='closed') FROM attendance_period),
 (SELECT count(*) FROM attendance_period_event),
 (SELECT count(*) FROM attendance_adjustment),
 (SELECT count(*) FROM hr_idempotency))`

var (
	m6Sheet         = "/api/hr/employees/:id/attendance"
	m6Period        = "/api/hr/attendance/periods/:month"
	m6Close         = "/api/hr/attendance/periods/:month/close"
	m6Reopen        = "/api/hr/attendance/periods/:month/reopen"
	m6Adjustments   = "/api/hr/employees/:id/attendance-adjustments"
	m6NoCompanyID   = "one company anchor: no record key to be outside the scope"
	m6NoMonthRecord = "the path names a month, not a record: an untouched month is an open one"
	m6AdjustPayload = `{"workDate":"2031-03-10","minutes":60,"reason":"`
	m6Transition    = regexp.MustCompile(`^\{"month":"[0-9]{4}-[0-9]{2}","state":"(open|closed)","version":"[1-9][0-9]*"\}$`)
)

// m6Month is a past month that no other prepare of the run closed.
func m6Month(w *m1World) string {
	w.name()
	return time.Date(2000, time.Month(w.names), 1, 0, 0, 0, 0, time.UTC).Format("2006-01")
}

func m6PeriodWrite() m1Cells {
	return m1With(m1Write(), func(c *m1Cells) {
		c.noGrant, c.deny, c.fresh = m1Refused(403), m1Refused(403), m1Refused(403)
		c.boundary = m1NA("the permission is outside the hrAdministration boundary package")
		c.foreign, c.absent, c.absentEmployee = m1NA(m6NoCompanyID), m1NA(m6NoMonthRecord), m1NA("no employee in the path")
		c.invalid, c.extra = m1Refused(400), m1Refused(400)
	})
}

var m6Matrix = map[httpapi.Route]m1Row{
	{Method: http.MethodGet, Path: m6Sheet}: {
		cells: m4EmployeeRead(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/hr/employees/" + m4Employee(t, w) + "/attendance?month=2031-03"}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m4Swap("month=2031-03", "month=2031-13"), m4Swap("month=2031-03", "month=1899-12"),
			m4Swap("month=2031-03", "month=2031-3"), m4Swap("month=2031-03", "month=2031-03&month=2031-03"),
			m4Swap("month=2031-03", "month=2031-03&limit=1"), m4Swap("month=2031-03", "x=1"),
		},
		shape:     regexp.MustCompile(`^\{"employeeId":"` + m1UUID + `","month":"2031-03","periodState":"open","scheduledMinutes":[0-9]+,.*,"adjustmentMinutes":0\}$`),
		rootAudit: "access.employee.readAttendance",
	},
	{Method: http.MethodGet, Path: m6Period}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny = m1Refused(404), m1Refused(404)
			c.foreign, c.absent, c.absentEmployee = m1NA(m6NoCompanyID), m1NA(m6NoMonthRecord), m1NA("no employee in the path")
			c.invalid = m1Refused(400)
		}),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/hr/attendance/periods/2031-03"} },
		invalid:   []m1Edit{m1Segment(5, "2031-13"), m1Segment(5, "2031-3"), m1Segment(5, "1899-12"), m1Segment(5, "2031-03-01")},
		shape:     regexp.MustCompile(`^\{"month":"2031-03","state":"open","version":"[1-9][0-9]*","events":\[.*\]\}$`),
		rootAudit: "access.hrCompany.read",
	},
	{Method: http.MethodPost, Path: m6Close}: {
		cells: m6PeriodWrite(),
		prepare: func(_ *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/attendance/periods/" + m6Month(w) + "/close", `{}`}
		},
		invalid: []m1Edit{
			m1Segment(5, "2031-13"), m1Segment(5, "20x1-01"), m1Body(`[]`), m1Body(`{`), m1Body(`null`),
			m1Body(`{"expectedVersion":"1"}`), m1Body(`{"a":1,"a":1}`),
		},
		extra:     m1Body(`{"extra":1}`),
		shape:     m6Transition,
		audit:     "hr.attendance-period.close",
		rootAudit: "hr.attendance-period.close",
	},
	{Method: http.MethodPost, Path: m6Reopen}: {
		cells: m6PeriodWrite(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			month := m6Month(w)
			w.asRoot(t, http.MethodPost, m1Request{"/api/hr/attendance/periods/" + month + "/close", `{}`}, http.StatusOK)
			return m1Request{"/api/hr/attendance/periods/" + month + "/reopen", `{"reason":"` + w.name() + `"}`}
		},
		invalid: []m1Edit{
			m1Segment(5, "2031-13"), m1Body(`{}`), m1Body(`{"reason":"   "}`), m1Body(`{"reason":null}`), m1Body(`{"reason":1}`),
			m1Body(`{"reason":"` + strings.Repeat("x", 1001) + `"}`), m1Body(`[]`), m1Body(`{"reason":"a","reason":"b"}`),
		},
		extra:     m1Extra,
		shape:     m6Transition,
		audit:     "hr.attendance-period.reopen",
		rootAudit: "hr.attendance-period.reopen",
	},
	{Method: http.MethodGet, Path: m6Adjustments}: {
		cells: m4EmployeeRead(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/hr/employees/" + m4Employee(t, w) + "/attendance-adjustments?month=2031-03"}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m4Swap("?month=2031-03", ""), m4Swap("month=2031-03", "month=2031-13"), m4Swap("month=2031-03", "month=2031-03&limit=101"),
			m4Swap("month=2031-03", "month=2031-03&month=2031-03"), m4Swap("month=2031-03", "month=2031-03&x=1"),
		},
		shape:     regexp.MustCompile(`^\{"employeeId":"` + m1UUID + `","month":"2031-03","periodState":"open","adjustmentMinutes":0,"total":"0","items":\[\]\}$`),
		rootAudit: "access.employee.readAttendanceAdjustment",
	},
	{Method: http.MethodPost, Path: m6Adjustments}: {
		cells: m1With(m4EmployeeWrite(true), func(c *m1Cells) { c.idempotency = m5aKeyReused }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/employees/" + m4Employee(t, w) + "/attendance-adjustments", m6AdjustPayload + w.name() + `"}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m1Body(`{}`), m1Body(`[]`), m1Replace(`"minutes":60`, `"minutes":0`), m1Replace(`"minutes":60`, `"minutes":1441`),
			m1Replace(`"minutes":60`, `"minutes":60.0`), m1Replace(`"minutes":60`, `"minutes":"60"`), m1Replace(`"2031-03-10"`, `"2031-02-30"`),
			m1Body(`{"workDate":"2031-03-10","minutes":60,"reason":"   "}`), m1Body(`{"workDate":"2031-03-10","minutes":60,"reason":"x","reference":null}`),
			m1Body(`{"workDate":"2031-03-10","minutes":60,"reason":"x","reference":" QD-1"}`), m1Body(`{"workDate":"2031-03-10","minutes":60}`),
		},
		extra:     m1Extra,
		shape:     m4ID,
		audit:     "hr.attendance.adjust",
		rootAudit: "hr.attendance.adjust",
		keyed:     true,
		reuse:     m1Replace(`"minutes":60`, `"minutes":120`),
	},
}

// m6Routes is the explicit M6 inventory; a route of the wave left out of MigratedRoutes or of the matrix is red.
var m6Routes = []httpapi.Route{
	{Method: http.MethodGet, Path: m6Sheet},
	{Method: http.MethodGet, Path: m6Period},
	{Method: http.MethodPost, Path: m6Close},
	{Method: http.MethodPost, Path: m6Reopen},
	{Method: http.MethodGet, Path: m6Adjustments},
	{Method: http.MethodPost, Path: m6Adjustments},
}

func TestEveryM6RouteIsMigratedWithAFullMatrix(t *testing.T) {
	if len(m6Routes) != 6 || len(m6Matrix) != len(m6Routes) {
		t.Errorf("M6=%d matrix=%d, want 6/6", len(m6Routes), len(m6Matrix))
	}
	for _, route := range m6Routes {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s: M6 route is not migrated", route)
		}
		row, ok := m6Matrix[route]
		if !ok {
			t.Errorf("%s: M6 route has no matrix", route)
			continue
		}
		checkMatrixRow(t, route, row)
	}
	for route := range m6Matrix {
		if !slices.Contains(m6Routes, route) {
			t.Errorf("%s: matrix outside the explicit M6 inventory", route)
		}
	}
}

// newM6World: denied holds a deny over the whole scope of every M6 permission; scoped (hr.employee) reads its own
// sheet and is granted its own adjustments, so a 404 on another employee is the scope, not a missing grant.
func newM6World(t *testing.T) *m1World {
	w := newM1World(t)
	for permission, template := range map[string]string{
		"employee.readAttendance": "allEmployees", "employee.readAttendanceAdjustment": "allEmployees", "employee.adjustAttendance": "allEmployees",
		"hrCompany.read": "company", "hrCompany.managePeriod": "company",
	} {
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", template)
	}
	for _, permission := range []string{"employee.readAttendanceAdjustment", "employee.adjustAttendance"} {
		w.exec(t, m1InsertRule, w.ids["scoped"], permission, "allow", "selfEmployee")
	}
	return w
}

func TestTheM6RoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM6World(t)
	statuses := m1ContractStatuses(t)
	for _, route := range m6Routes {
		t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, m6Matrix[route], statuses[route]) })
	}
}

// Scoped reads its own sheet and adjustments, never adjusts its own attendance (403, nothing written, the key
// stays free), and does not see another employee.
func TestM6ScopedGrantsReachOnlyTheirOwnEmployee(t *testing.T) {
	w := newM6World(t)
	own := "/api/hr/employees/" + w.scalar(t, `SELECT id::text FROM employee WHERE account_id=$1`, w.ids["scoped"])
	for _, target := range []string{own + "/attendance", own + "/attendance-adjustments?month=2031-03"} {
		if status, body := w.send(http.MethodGet, "scoped", m1Request{target: target}, nil); status != http.StatusOK {
			t.Errorf("scoped GET %s: %d %s", target, status, body)
		}
	}
	before := w.state(t)
	key := m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil)
	if status, body := w.send(http.MethodPost, "scoped", m1Request{own + "/attendance-adjustments", m6AdjustPayload + `own"}`}, key); !m1Refused(http.StatusForbidden).answers(status, body) {
		t.Errorf("scoped adjusts its own attendance: %d %s", status, body)
	}
	if after := w.state(t); after != before {
		t.Errorf("the self adjustment changed the state: %s -> %s", before, after)
	}
	if status, body := w.send(http.MethodGet, "scoped", m1Request{target: "/api/hr/employees/" + m4Employee(t, w) + "/attendance"}, nil); status != http.StatusNotFound {
		t.Errorf("scoped reads another sheet: %d %s", status, body)
	}
}

const m6CompanyAudits = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to($2,'UTF8')
  AND safe_metadata->>'resource'='hrCompany' AND safe_metadata->>'key'=$3 AND object_id IS NOT NULL AND reason IS NULL`

// The transitions over HTTP: an empty POST closes, a close of a closed or future month and a reopen of an open one
// are 409 with nothing written, an adjustment of a closed month is error.periodClosed, Root's close and reopen are
// audited on the company, and an audit failure rolls the transition back.
func TestM6PeriodTransitionsOverHTTP(t *testing.T) {
	w := newM6World(t)
	month := "/api/hr/attendance/periods/2019-06"
	refusals := map[int]m1Cell{
		http.StatusForbidden:          m1Refused(http.StatusForbidden),
		http.StatusConflict:           m1Refused(http.StatusConflict),
		http.StatusServiceUnavailable: {status: http.StatusServiceUnavailable, body: `{"statusCode":503,"code":"error.unavailable"}`},
	}
	transition := func(actor, path, body string, want int, version string) {
		t.Helper()
		before := w.state(t)
		status, answer := w.send(http.MethodPost, actor, m1Request{month + path, body}, nil)
		if want != http.StatusOK {
			if !refusals[want].answers(status, answer) || w.state(t) != before {
				t.Errorf("%s %s: %d %s, state %s -> %s", actor, path, status, answer, before, w.state(t))
			}
			return
		}
		if status != want || !strings.HasSuffix(answer, `"version":"`+version+`"}`) {
			t.Errorf("%s %s: %d %s", actor, path, status, answer)
		}
	}
	transition("hr", "/close", "", http.StatusOK, "2")
	transition("hr", "/close", `{}`, http.StatusConflict, "")
	transition("root", "/close", `{}`, http.StatusConflict, "")
	employee := fixture.Employee(t, w.stack, fixture.EmployeeSpec{HiredOn: "2019-01-02"}).ID
	before := w.state(t)
	status, body := w.send(http.MethodPost, "hr", m1Request{"/api/hr/employees/" + employee + "/attendance-adjustments", `{"workDate":"2019-06-10","minutes":60,"reason":"Closed"}`},
		m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
	if status != http.StatusConflict || body != `{"statusCode":409,"code":"error.periodClosed"}` || w.state(t) != before {
		t.Errorf("adjustment of a closed month: %d %s", status, body)
	}
	transition("hr", "/reopen", `{"reason":"Fix"}`, http.StatusOK, "3")
	transition("hr", "/reopen", `{"reason":"Again"}`, http.StatusConflict, "")
	status, body = w.send(http.MethodGet, "hr", m1Request{target: month}, nil)
	if status != http.StatusOK || !strings.HasPrefix(body, `{"month":"2019-06","state":"open","version":"3","events":[{"event":"reopen","version":"3","reason":"Fix","occurredAt":"`) ||
		!strings.Contains(body, `},{"event":"close","version":"2","reason":null,"occurredAt":"`) {
		t.Errorf("history: %d %s", status, body)
	}
	future := "/api/hr/attendance/periods/2099-01/close"
	before = w.state(t)
	if status, body := w.send(http.MethodPost, "hr", m1Request{future, `{}`}, nil); !m1Refused(http.StatusConflict).answers(status, body) || w.state(t) != before {
		t.Errorf("future close: %d %s", status, body)
	}

	for _, kind := range []string{"hr.attendance-period.close", "hr.attendance-period.reopen"} {
		if n := w.scalar(t, m6CompanyAudits, w.ids["root"], kind, permission.CompanyID); n != "0" {
			t.Fatalf("root %s audits before: %s", kind, n)
		}
	}
	transition("root", "/close", `{}`, http.StatusOK, "4")
	transition("root", "/reopen", `{"reason":"Root"}`, http.StatusOK, "5")
	for _, kind := range []string{"hr.attendance-period.close", "hr.attendance-period.reopen"} {
		if n := w.scalar(t, m6CompanyAudits, w.ids["root"], kind, permission.CompanyID); n != "1" {
			t.Errorf("root %s: %s audits on the company, want 1", kind, n)
		}
	}
	if n := w.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND convert_from(event_kind,'UTF8') LIKE 'hr.attendance-period.%' AND strpos(safe_metadata::text,'Root')>0`, w.ids["root"]); n != "0" {
		t.Errorf("the reopen reason is audited: %s", n)
	}

	// Root bypasses permissions, not the step-up a fresh@1 policy asks for.
	w.secrets["root stale"] = fixture.Session(t, w.stack, w.ids["root"], fixture.SessionSpec{})
	transition("root stale", "/close", `{}`, http.StatusForbidden, "")
	transition("hr", "/close", `{}`, http.StatusOK, "6")
	transition("root stale", "/reopen", `{"reason":"Stale"}`, http.StatusForbidden, "")

	w.exec(t, `CREATE FUNCTION public.fail_m6_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture audit failure''; END'; CREATE TRIGGER fail_m6_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION public.fail_m6_audit()`)
	transition("hr", "/reopen", `{"reason":"Rollback"}`, http.StatusServiceUnavailable, "")
	month = "/api/hr/attendance/periods/2019-07"
	transition("hr", "/close", `{}`, http.StatusServiceUnavailable, "")
	before = w.state(t)
	status, body = w.send(http.MethodPost, "hr", m1Request{"/api/hr/employees/" + employee + "/attendance-adjustments", `{"workDate":"2019-07-10","minutes":60,"reason":"Rollback"}`},
		m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
	if status != http.StatusServiceUnavailable || body != `{"statusCode":503,"code":"error.unavailable"}` || w.state(t) != before {
		t.Errorf("adjustment with a failing audit: %d %s", status, body)
	}
}
