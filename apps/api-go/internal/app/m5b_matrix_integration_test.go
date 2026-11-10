//go:build integration

package app

import (
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/test/fixture"
)

const m5bState = `SELECT concat_ws('|',
 (SELECT count(*)||':'||coalesce(sum(version),0) FROM work_request),
 (SELECT count(*) FROM work_request_segment),
 (SELECT count(*) FROM request_decision),
 (SELECT coalesce(sum(approved_count),0) FROM wfh_month_counter))`

// m5bDay is a weekday of the next ten weeks that no other prepare of the run used, inside the default
// request window of the DB clock.
const m5bDay = `SELECT to_char(` + hrbase.BusinessToday + ` + (8 - extract(isodow FROM ` + hrbase.BusinessToday + `)::int)
  + CAST($1 AS int) % 5 + 7 * (CAST($1 AS int) / 5 % 10),'YYYY-MM-DD')`

var (
	m5bEmptyPage = m1Cell{status: http.StatusOK, body: `{"items":[],"total":"0"}`}
	m5bNoKey     = m1NA("a read takes no idempotency key")
	m5bOwn       = "the target is the caller's own profile, never named in the request"
	m5bSubmitted = regexp.MustCompile(`^\{"id":"` + m1UUID + `","state":"(pending_lead|pending_final|approved)","version":"1"\}$`)
)

func m5bDate(t *testing.T, w *m1World) string {
	t.Helper()
	w.name()
	return w.scalar(t, m5bDay, w.names)
}

// m5bRequest is a pending late arrival of the profile of account in its primary team, written in SQL.
func m5bRequest(t *testing.T, w *m1World, account string) string {
	t.Helper()
	request := w.scalar(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),e.id,e.account_id,m.team_id,'late-arrival','pending_lead','Matrix'
        FROM gen_random_uuid() g, employee e JOIN team_membership m ON m.employee_id=e.id AND m.is_primary AND m.ends_at IS NULL
       WHERE e.account_id=$1 RETURNING id::text`, account)
	w.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      VALUES($1,'late-arrival',CAST($2 AS date),540,600,60)`, request, m5bDate(t, w))
	return request
}

var m5bMatrix = map[httpapi.Route]m1Row{
	{Method: http.MethodPost, Path: "/api/hr/requests"}: {
		cells: m1With(m1Write(), func(c *m1Cells) {
			c.noGrant, c.deny, c.invalid, c.extra, c.idempotency = m1Refused(404), m1Refused(404), m1Refused(400), m1Refused(400), m5aKeyReused
			c.boundary = m1NA("the permission is outside the hrAdministration boundary package")
			c.fresh = m1NA("the policy of the permission carries no fresh@1")
			c.foreign, c.absent, c.absentEmployee = m1NA(m5bOwn), m1NA(m5bOwn), m1NA(m5bOwn)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/requests", `{"kind":"late-arrival","reason":"Matrix","date":"` + m5bDate(t, w) + `","expectedMinute":600}`}
		},
		invalid: []m1Edit{
			m1Body(`{}`), m1Body(`[]`), m1Replace(`"late-arrival"`, `"overtime"`), m1Replace(`"expectedMinute":600`, `"expectedMinute":600.0`),
			m1Replace(`"expectedMinute":600`, `"expectedMinute":1441`), m1Replace(`"reason":"Matrix"`, `"reason":"   "`),
			m1Replace(`"expectedMinute":600`, `"expectedMinute":600,"dates":null`), m1Replace(`"expectedMinute":600`, `"expectedMinute":600,"teamId":"bad"`),
		},
		extra:     m1Extra,
		shape:     m5bSubmitted,
		audit:     "hr.request.submit",
		rootAudit: "hr.request.submit",
		keyed:     true,
		reuse:     m1Replace(`"expectedMinute":600`, `"expectedMinute":660`),
	},
	{Method: http.MethodGet, Path: "/api/hr/requests"}: {
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny, c.idempotency, c.invalid = m5bEmptyPage, m5bEmptyPage, m5bNoKey, m1Refused(400)
			c.foreign = m1NA("no id in the path: the list is the caller's own profile under the scope in SQL, before the page")
			c.absent, c.absentEmployee = m1NA("no id in the path"), m1NA("no employee in the path")
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			for _, owner := range []string{"hr", "root", "denied", "none"} {
				m5bRequest(t, w, w.ids[owner])
			}
			return m1Request{target: "/api/hr/requests"}
		},
		invalid:   []m1Edit{m1Query("limit=0"), m1Query("limit=abc"), m1Query("limit=101"), m1Query("offset=-1"), m1Query("sort=kind"), m1Query("limit=1&limit=2")},
		shape:     regexp.MustCompile(`^\{"items":\[\{"id":"` + m1UUID + `","kind":"[a-z-]+","state":"[a-z_]+","version":"1","teamId":"` + m1UUID + `","createdAt":"[^"]+Z","startDate":"` + m4Date + `","endDate":"` + m4Date + `","minutes":[0-9]+\}.*\],"total":"[1-9][0-9]*"\}$`),
		rootAudit: "access.workRequest.read",
	},
	{Method: http.MethodGet, Path: "/api/hr/requests/:id"}: {
		cells: m1With(m4EmployeeRead(), func(c *m1Cells) {
			c.idempotency = m5bNoKey
			c.absentEmployee = m1NA("the request is the target, no second key")
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/hr/requests/" + m5bRequest(t, w, w.ids["hr"])}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m1Segment(4, "bad"), m1Segment(4, "6F5196CB-3843-472A-846D-839AB840EBD9")},
		shape:     regexp.MustCompile(`^\{"id":"` + m1UUID + `","employeeId":"` + m1UUID + `","teamId":"` + m1UUID + `","kind":"late-arrival","state":"pending_lead","version":"1","reason":"Matrix","createdAt":"[^"]+Z","segments":\[\{"date":"` + m4Date + `","startMinute":540,"endMinute":600,"minutes":60\}\],"decisions":\[\]\}$`),
		rootAudit: "access.workRequest.read",
	},
}

var m5bRoutes = []httpapi.Route{
	{Method: http.MethodPost, Path: "/api/hr/requests"},
	{Method: http.MethodGet, Path: "/api/hr/requests"},
	{Method: http.MethodGet, Path: "/api/hr/requests/:id"},
}

func TestM5bRoutesAreMigrated(t *testing.T) {
	for _, route := range m5bRoutes {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s not migrated", route)
		}
		if _, ok := m5bMatrix[route]; !ok {
			t.Errorf("%s served with no M5b matrix", route)
		}
	}
	if len(m5bMatrix) != len(m5bRoutes) {
		t.Errorf("%d M5b matrix rows, want %d", len(m5bMatrix), len(m5bRoutes))
	}
}

// newM5bWorld gives hr, denied, none and Root an official profile in one new team, so the 404 of none and
// denied is the missing grant or the deny, not a missing profile; scoped keeps its profile outside it.
func newM5bWorld(t *testing.T, edits ...func(*steps)) *m1World {
	w := newM1World(t, edits...)
	w.exec(t, m1InsertRule, w.ids["denied"], "employee.submitRequest", "deny", "allEmployees")
	w.exec(t, m1InsertRule, w.ids["denied"], "workRequest.read", "deny", "allRequests")
	team := w.team(t)
	for _, name := range []string{"hr", "denied", "none", "root"} {
		employee := fixture.Employee(t, w.stack, fixture.EmployeeSpec{AccountID: w.ids[name], HiredOn: "2020-01-06"}).ID
		w.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official',DATE '2020-01-06')`, employee)
		w.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, team, employee)
	}
	return w
}

func TestTheM5bRoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM5bWorld(t)
	statuses := m1ContractStatuses(t)
	for _, route := range httpapi.MigratedRoutes {
		if row, ok := m5bMatrix[route]; ok {
			t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, row, statuses[route]) })
		}
	}
}

// m5Replayed counts the actor's access rows of permission that name the employee as their target.
const m5Replayed = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.'||$2,'UTF8')
  AND object_id IS NULL AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok'
  AND safe_metadata->>'resource'='employee' AND safe_metadata->>'key'=$3`

// A replay of a keyed route writes nothing. Root's replay adds one access row naming the employee; the submit
// adds the untargeted access of its submitter query, which every submit of Root has. An IAM replay adds none.
func TestM5ARootRetryIsAuditedOnItsEmployeeAndAnIAMRetryIsNot(t *testing.T) {
	w := newM5bWorld(t)
	adjust := m5aMatrix[httpapi.Route{Method: http.MethodPost, Path: "/api/hr/employees/:id/leave-adjustments"}]
	submit := m5bMatrix[httpapi.Route{Method: http.MethodPost, Path: "/api/hr/requests"}]
	for _, run := range []struct {
		name, permission string
		prepare          func(*testing.T, *m1World) m1Request
		employee         func(actor string, r m1Request) string
		query            int
	}{
		{"adjust", "employee.adjustLeaveBalance", adjust.prepare, func(_ string, r m1Request) string { return strings.Split(r.target, "/")[4] }, 0},
		{"submit", "employee.submitRequest", submit.prepare, func(actor string, _ m1Request) string {
			return w.scalar(t, `SELECT id::text FROM employee WHERE account_id=$1`, w.ids[actor])
		}, 1},
		{"attendance adjust", "employee.adjustAttendance", m6Matrix[httpapi.Route{Method: http.MethodPost, Path: m6Adjustments}].prepare,
			func(_ string, r m1Request) string { return strings.Split(r.target, "/")[4] }, 0},
	} {
		for actor, want := range map[string]int{"root": 1, "hr": 0} {
			r := run.prepare(t, w)
			key := m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil)
			status, first := w.send(http.MethodPost, actor, r, key)
			if status != http.StatusCreated {
				t.Fatalf("%s %s: %d %s", run.name, actor, status, first)
			}
			before, state := w.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`, w.ids[actor]), w.state(t)
			if status, body := w.send(http.MethodPost, actor, r, key); status != http.StatusCreated || body != first {
				t.Errorf("%s %s replay: %d %s, first %s", run.name, actor, status, body, first)
			}
			n, err := strconv.Atoi(before)
			if err != nil {
				t.Fatal(err)
			}
			if after := w.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`, w.ids[actor]); after != strconv.Itoa(n+want*(1+run.query)) {
				t.Errorf("%s %s replay audits %s -> %s", run.name, actor, before, after)
			}
			if got := w.scalar(t, m5Replayed, w.ids[actor], run.permission, run.employee(actor, r)); got != strconv.Itoa(want) {
				t.Errorf("%s %s replay: %s audits of the employee, want %d", run.name, actor, got, want)
			}
			if want == 0 && w.state(t) != state {
				t.Errorf("%s: an IAM replay changed the state", run.name)
			}
		}
	}
}
