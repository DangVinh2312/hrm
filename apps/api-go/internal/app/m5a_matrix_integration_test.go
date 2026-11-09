//go:build integration

package app

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"

	"hrm/api-go/internal/httpapi"
	"hrm/api-go/test/fixture"
)

const m5aState = `SELECT concat_ws('|',
 (SELECT count(*) FROM leave_ledger),
 (SELECT count(*)||':'||coalesce(sum(revision),0) FROM leave_bucket),
 (SELECT count(*) FROM hr_idempotency),
 (SELECT count(*) FROM attendance_period),
 (SELECT count(*) FROM audit_outbox))`

var (
	m5aKeyReused     = m1Cell{status: 422, body: `{"statusCode":422,"code":"error.idempotencyKeyReused"}`}
	m5aEmptyPage     = m1Cell{status: http.StatusOK, body: `{"year":2031,"total":"0","items":[]}`}
	m5aNoKey         = m1NA("a read takes no idempotency key")
	m5aAdjustPayload = `{"minutes":480,"effectiveOn":"2031-03-10","reference":"`
)

// m5aPending is a new employee with a pending annual-leave request in March 2031 and no accrual, so HR's
// reconciliation lists it and a caller outside the scope must not.
func m5aPending(t *testing.T, w *m1World) {
	t.Helper()
	employee := m4Employee(t, w)
	request := w.scalar(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'annual-leave','pending_lead','Matrix' FROM gen_random_uuid() g
      RETURNING id::text`, employee, w.ids["hr"], w.team(t))
	w.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      VALUES($1,'annual-leave',DATE '2031-03-10',540,1080,480)`, request)
}

var m5aMatrix = map[httpapi.Route]m1Row{
	{Method: http.MethodGet, Path: "/api/hr/employees/:id/leave-balance"}: {
		cells: m1With(m4EmployeeRead(), func(c *m1Cells) { c.idempotency = m5aNoKey }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/hr/employees/" + m4Employee(t, w) + "/leave-balance?date=2031-03-31"}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m4Swap("date=2031-03-31", "date=2031-02-30"), m4Swap("date=2031-03-31", "date=2031-03-31&date=2031-03-31"),
			m4Swap("date=2031-03-31", "year=2031"), m4Swap("date=2031-03-31", "date=2031-03-31&limit=1"), m4Swap("date=2031-03-31", "date=1899-12-31"),
		},
		shape:     regexp.MustCompile(`^\{"employeeId":"` + m1UUID + `","year":2031,"asOn":"2031-03-31","annualMinutes":null,"entitledMinutes":0,"usedMinutes":0,"futureApprovedMinutes":0,"pendingMinutes":0,"availableMinutes":0\}$`),
		rootAudit: "access.employee.readLeaveBalance",
	},
	{Method: http.MethodGet, Path: "/api/hr/leave/reconciliation"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny, c.idempotency = m5aEmptyPage, m5aEmptyPage, m5aNoKey
			c.foreign = m1NA("no id in the path: the list is filtered by the scope in SQL before the page")
			c.absent, c.absentEmployee = m1NA("no id in the path"), m1NA("no employee in the path")
			c.invalid = m1Refused(400)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			m5aPending(t, w)
			return m1Request{target: "/api/hr/leave/reconciliation?year=2031"}
		},
		invalid: []m1Edit{
			m4Target("/api/hr/leave/reconciliation?year=31"), m4Target("/api/hr/leave/reconciliation?year=2101"),
			m4Target("/api/hr/leave/reconciliation?year=2031&limit=101"), m4Target("/api/hr/leave/reconciliation?year=2031&x=1"),
			m4Target("/api/hr/leave/reconciliation?year=2031&year=2031"),
		},
		shape:     regexp.MustCompile(`^\{"year":2031,"total":"[1-9][0-9]*","items":\[\{"employeeId":"` + m1UUID + `","employeeCode":".*","month":3,"accruedMinutes":0,"approvedMinutes":0,"pendingMinutes":480,"excessMinutes":480,"requestIds":\["` + m1UUID + `"\]\}.*\]\}$`),
		rootAudit: "access.employee.readLeaveBalance",
	},
	{Method: http.MethodPost, Path: "/api/hr/employees/:id/leave-adjustments"}: {
		cells: m1With(m4EmployeeWrite(true), func(c *m1Cells) { c.idempotency = m5aKeyReused }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/employees/" + m4Employee(t, w) + "/leave-adjustments", m5aAdjustPayload + w.name() + `"}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m1Body(`{}`), m1Replace(`"minutes":480`, `"minutes":0`), m1Replace(`"minutes":480`, `"minutes":480.0`),
			m1Replace(`"minutes":480`, `"minutes":175681`), m1Replace(`"2031-03-10"`, `"2031-02-30"`),
			m1Body(`{"minutes":480,"effectiveOn":"2031-03-10","reference":"   "}`), m1Body(`{"minutes":480,"effectiveOn":"2031-03-10"}`), m1Body(`[]`),
		},
		extra:     m1Extra,
		shape:     m4ID,
		audit:     "hr.leave.adjust",
		rootAudit: "hr.leave.adjust",
		keyed:     true,
		reuse:     m1Replace(`"minutes":480`, `"minutes":960`),
	},
}

// checkIdempotency follows the granted success with key: the same request answers the same body and writes
// nothing; another payload under the key is the idempotency cell; no key, a malformed key or the header twice
// is invalid input. None of them changes the state.
func (w *m1World) checkIdempotency(t *testing.T, route httpapi.Route, row m1Row, valid m1Request, key func(*http.Request), success int, first string) {
	t.Helper()
	before := w.state(t)
	if status, body := w.send(route.Method, "hr", valid, key); status != success || body != first {
		t.Errorf("replay: %d %s, first %s", status, body, first)
	}
	if status, body := w.send(route.Method, "hr", row.reuse(valid), key); !row.cells.idempotency.answers(status, body) {
		t.Errorf("another payload under the key: %d %s", status, body)
	}
	for name, edit := range map[string]func(*http.Request){
		"no key": func(r *http.Request) { r.Header.Del("Idempotency-Key") },
		"malformed key": func(r *http.Request) {
			r.Header.Set("Idempotency-Key", strings.ToUpper(r.Header.Get("Idempotency-Key")))
		},
		"two keys": func(r *http.Request) { r.Header.Add("Idempotency-Key", r.Header.Get("Idempotency-Key")) },
	} {
		if status, body := w.send(route.Method, "hr", valid, w.keyed(t, row, edit)); !m1Refused(http.StatusBadRequest).answers(status, body) {
			t.Errorf("%s: %d %s", name, status, body)
		}
	}
	if after := w.state(t); after != before {
		t.Errorf("replay, reuse or a bad key changed the state: %s -> %s", before, after)
	}
}

var m5aRoutes = []httpapi.Route{
	{Method: http.MethodGet, Path: "/api/hr/employees/:id/leave-balance"},
	{Method: http.MethodGet, Path: "/api/hr/leave/reconciliation"},
	{Method: http.MethodPost, Path: "/api/hr/employees/:id/leave-adjustments"},
}

func TestM5aRoutesAreMigrated(t *testing.T) {
	for _, route := range m5aRoutes {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s not migrated", route)
		}
		if _, ok := m5aMatrix[route]; !ok {
			t.Errorf("%s served with no M5a matrix", route)
		}
	}
	if len(m5aMatrix) != len(m5aRoutes) {
		t.Errorf("%d M5a matrix rows, want %d", len(m5aMatrix), len(m5aRoutes))
	}
}

func newM5aWorld(t *testing.T) *m1World {
	w := newM1World(t)
	for _, permission := range []string{"employee.readLeaveBalance", "employee.adjustLeaveBalance"} {
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", "allEmployees")
	}
	w.exec(t, m1InsertRule, w.ids["scoped"], "employee.adjustLeaveBalance", "allow", "selfEmployee")
	return w
}

func TestTheM5aRoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM5aWorld(t)
	statuses := m1ContractStatuses(t)
	for _, route := range httpapi.MigratedRoutes {
		if row, ok := m5aMatrix[route]; ok {
			t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, row, statuses[route]) })
		}
	}
}

// The foreign cells send scoped, whose grants are selfEmployee: it reads and adjusts its own employee, so
// the 404 on another employee is the scope, not a missing grant; its reconciliation holds only itself.
func TestM5aScopedGrantsReachOnlyTheirOwnEmployee(t *testing.T) {
	w := newM5aWorld(t)
	m5aPending(t, w)
	own := "/api/hr/employees/" + w.scalar(t, `SELECT id::text FROM employee WHERE account_id=$1`, w.ids["scoped"])
	if status, body := w.send(http.MethodGet, "scoped", m1Request{target: own + "/leave-balance"}, nil); status != http.StatusOK {
		t.Errorf("scoped balance: %d %s", status, body)
	}
	if status, body := w.send(http.MethodGet, "scoped", m1Request{target: "/api/hr/leave/reconciliation?year=2031"}, nil); status != http.StatusOK || body != m5aEmptyPage.body {
		t.Errorf("scoped reconciliation: %d %s", status, body)
	}
	adjust := m1Request{own + "/leave-adjustments", m5aAdjustPayload + `own"}`}
	w.succeed(t, "scoped adjust", "scoped", http.MethodPost, adjust, m4ID, http.StatusCreated, "hr.leave.adjust", m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
	other := fixture.Employee(t, w.stack, fixture.EmployeeSpec{}).ID
	if status, body := w.send(http.MethodGet, "scoped", m1Request{target: "/api/hr/employees/" + other + "/leave-balance"}, nil); status != http.StatusNotFound {
		t.Errorf("scoped reads another balance: %d %s", status, body)
	}
}
