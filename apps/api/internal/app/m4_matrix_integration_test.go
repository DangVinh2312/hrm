//go:build integration

package app

import (
	"encoding/json/v2"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"hrm/api/internal/httpapi"
	"hrm/api/test/fixture"
)

const m4State = `SELECT concat_ws('|',
 (SELECT version::text FROM work_calendar),
 (SELECT count(*) FROM work_calendar_change),
 (SELECT count(*) FROM work_schedule),
 (SELECT count(*) FROM work_schedule_shift),
 (SELECT count(*)||':'||count(*) FILTER (WHERE valid_to IS NULL) FROM employee_schedule),
 (SELECT count(*) FROM employee_schedule_shift),
 (SELECT count(*) FROM attendance_period),
 (SELECT count(*) FROM audit_outbox))`

var (
	m4Week         = `[` + strings.Repeat(`[[540,780],[840,1080]],`, 5) + `[],[]]`
	m4LongWeek     = `[` + strings.Repeat(`[[480,1020]],`, 5) + `[],[]]`
	m4Date         = `[0-9]{4}-[0-9]{2}-[0-9]{2}`
	m4Effective    = regexp.MustCompile(`^\{"effectiveFrom":"` + m4Date + `"\}$`)
	m4ID           = regexp.MustCompile(`^\{"id":"` + m1UUID + `"\}$`)
	m4NoCalendarID = "one calendar anchor: no record key to be outside the scope"
)

// m4Target swaps the whole target, for edits of a query string.
func m4Target(target string) m1Edit {
	return func(r m1Request) m1Request { r.target = target; return r }
}

// m4Future is a business date after today that no other prepare of the run used.
func m4Future(w *m1World) string {
	w.name()
	return time.Date(2032, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, w.names).Format(time.DateOnly)
}

func m4Version(t *testing.T, w *m1World) string {
	t.Helper()
	return w.scalar(t, `SELECT version::text FROM work_calendar`)
}

func m4Employee(t *testing.T, w *m1World) string {
	t.Helper()
	return fixture.Employee(t, w.stack, fixture.EmployeeSpec{}).ID
}

// m4Frame is a frame of a new employee, written by Root.
func m4Frame(t *testing.T, w *m1World) (string, string) {
	t.Helper()
	employee := m4Employee(t, w)
	var created struct {
		ID string `json:"id"`
	}
	body := w.asRoot(t, http.MethodPost, m1Request{"/api/hr/employees/" + employee + "/schedule-frames", `{"validFrom":"2031-05-05","validTo":null,"days":` + m4Week + `}`}, http.StatusCreated)
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	return employee, created.ID
}

func m4CalendarRead() m1Cells {
	return m1With(m1Read(), func(c *m1Cells) {
		c.noGrant, c.deny = m1Refused(404), m1Refused(404)
		c.foreign, c.absent, c.absentEmployee = m1NA(m4NoCalendarID), m1NA("no key in the path"), m1NA("no employee in the path")
	})
}

func m4CalendarWrite(body bool) m1Cells {
	return m1With(m1Write(), func(c *m1Cells) {
		c.noGrant, c.deny, c.fresh = m1Refused(403), m1Refused(403), m1Refused(403)
		c.boundary = m1NA("the permission is outside the hrAdministration boundary package")
		c.foreign, c.absent, c.absentEmployee = m1NA(m4NoCalendarID), m1NA("the path names a date, not a record"), m1NA("no employee in the path")
		c.invalid, c.extra = m1Refused(400), m1Refused(400)
		if !body {
			c.extra = m1NA("the route reads no body")
		}
	})
}

func m4EmployeeRead() m1Cells {
	return m1With(m1Read(), func(c *m1Cells) {
		c.noGrant, c.deny, c.foreign, c.absent = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404)
		c.absentEmployee, c.invalid = m1NA("employee is the target, no second key"), m1Refused(400)
	})
}

func m4EmployeeWrite(body bool) m1Cells {
	return m1With(m1Write(), func(c *m1Cells) {
		c.noGrant, c.deny, c.foreign, c.absent, c.fresh = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(403)
		c.boundary = m1NA("the permission is outside the hrAdministration boundary package")
		c.absentEmployee = m1NA("employee is the target, no second key")
		c.invalid, c.extra = m1Refused(400), m1Refused(400)
		if !body {
			c.extra = m1NA("the route reads no body")
		}
	})
}

var m4Matrix = map[httpapi.Route]m1Row{
	{Method: http.MethodGet, Path: "/api/hr/work-calendar"}: {
		cells:     m1With(m4CalendarRead(), func(c *m1Cells) { c.invalid = m1Refused(400) }),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/hr/work-calendar?year=2031"} },
		invalid:   []m1Edit{m4Target("/api/hr/work-calendar"), m4Target("/api/hr/work-calendar?year=31"), m4Target("/api/hr/work-calendar?year=2101"), m4Target("/api/hr/work-calendar?year=2031&year=2032"), m4Target("/api/hr/work-calendar?year=2031&limit=1")},
		shape:     regexp.MustCompile(`^\{"version":"[1-9][0-9]*","year":2031,"holidays":\[.*\],"makeupDays":\[.*\]\}$`),
		rootAudit: "access.workCalendar.read",
	},
	{Method: http.MethodPut, Path: "/api/hr/work-calendar/holidays"}: {
		cells: m4CalendarWrite(true),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/work-calendar/holidays", `{"expectedVersion":"` + m4Version(t, w) + `","from":"2031-03-03","to":"2031-03-04","name":"` + w.name() + `"}`}
		},
		invalid: []m1Edit{
			m1Body(`{}`), m1Replace(`"2031-03-04"`, `"2031-03-02"`), m1Replace(`"2031-03-04"`, `"2031-04-04"`), m1Replace(`"2031-03-03"`, `"2031-02-29"`),
			m1Body(`{"expectedVersion":"1","from":"2031-03-03","to":"2031-03-04","name":"  "}`), m1Body(`{"expectedVersion":"0","from":"2031-03-03","to":"2031-03-04","name":"x"}`),
		},
		extra:     m1Extra,
		shape:     m1Version,
		audit:     "hr.work-calendar.update",
		rootAudit: "hr.work-calendar.update",
	},
	{Method: http.MethodPut, Path: "/api/hr/work-calendar/days/:date"}: {
		cells: m4CalendarWrite(true),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/work-calendar/days/2031-04-01", `{"expectedVersion":"` + m4Version(t, w) + `","holiday":"` + w.name() + `"}`}
		},
		invalid: []m1Edit{
			m1Segment(5, "2031-02-29"), m1Segment(5, "2031-4-01"), m1Body(`{"expectedVersion":"1"}`), m1Body(`{"expectedVersion":"1","holiday":null,"makeup":null}`),
			m1Body(`{"expectedVersion":"1","holiday":" "}`), m1Body(`{"expectedVersion":"1","makeup":{"asWeekday":8,"frameSource":"company"}}`),
			m1Body(`{"expectedVersion":"1","makeup":{"asWeekday":1,"frameSource":"company"}}`),
		},
		extra:     m1Extra,
		shape:     m1Version,
		audit:     "hr.work-calendar.update",
		rootAudit: "hr.work-calendar.update",
	},
	{Method: http.MethodGet, Path: "/api/hr/work-calendar/schedule"}: {
		cells: m1With(m4CalendarRead(), func(c *m1Cells) {
			c.invalid = m1NA("the route reads no parameter, query or body")
		}),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/hr/work-calendar/schedule"} },
		shape:     regexp.MustCompile(`^\{"today":"` + m4Date + `","maxMinutes":480,"versions":\[\{"effectiveFrom":.*\}\]\}$`),
		rootAudit: "access.workCalendar.read",
	},
	{Method: http.MethodPut, Path: "/api/hr/work-calendar/schedule/:effectiveFrom"}: {
		cells: m4CalendarWrite(true),
		prepare: func(_ *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/work-calendar/schedule/" + m4Future(w), `{"days":` + m4Week + `}`}
		},
		invalid: []m1Edit{
			m1Segment(5, "2032-02-30"), m1Segment(5, "2020-01-06"), m1Body(`{}`), m1Body(`{"days":[]}`), m1Body(`{"days":null}`),
			m1Body(`{"days":` + m4LongWeek + `}`), m1Body(`{"days":[[],[],[],[],[],[],[]]}`),
		},
		extra:     m1Extra,
		shape:     m4Effective,
		audit:     "hr.work-schedule.update",
		rootAudit: "hr.work-schedule.update",
	},
	{Method: http.MethodDelete, Path: "/api/hr/work-calendar/schedule/:effectiveFrom"}: {
		cells: m1With(m4CalendarWrite(false), func(c *m1Cells) {
			c.absent = m1Refused(409)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			target := "/api/hr/work-calendar/schedule/" + m4Future(w)
			w.asRoot(t, http.MethodPut, m1Request{target, `{"days":` + m4Week + `}`}, http.StatusOK)
			return m1Request{target: target}
		},
		absent:    m1Segment(5, "2099-01-05"),
		invalid:   []m1Edit{m1Segment(5, "2032-02-30"), m1Segment(5, "1900-01-01")},
		shape:     m4Effective,
		audit:     "hr.work-schedule.update",
		rootAudit: "hr.work-schedule.update",
	},
	{Method: http.MethodGet, Path: "/api/hr/employees/:id/schedule-frames"}: {
		cells: m4EmployeeRead(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/hr/employees/" + m4Employee(t, w) + "/schedule-frames"}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m1Segment(4, "bad"), m1Segment(4, "00000000-0000-4000-8000-00000000000A")},
		shape:     regexp.MustCompile(`^\{"today":"` + m4Date + `","maxMinutes":480,"frames":\[\]\}$`),
		rootAudit: "access.employee.readSchedule",
	},
	{Method: http.MethodPost, Path: "/api/hr/employees/:id/schedule-frames"}: {
		cells: m4EmployeeWrite(true),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/hr/employees/" + m4Employee(t, w) + "/schedule-frames", `{"validFrom":"2031-05-05","validTo":"2031-06-30","days":` + m4Week + `}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m1Body(`{}`), m1Replace(`"2031-06-30"`, `"2031-05-04"`), m1Replace(`,"validTo":"2031-06-30"`, ``),
			m1Replace(`"2031-05-05"`, `"2020-01-06"`), m1Body(`{"validFrom":"2031-05-05","validTo":null,"days":` + m4LongWeek + `}`),
			m1Body(`{"validFrom":"2031-05-05","validTo":null,"days":[[],[],[],[],[],[[540,780]],[]]}`),
		},
		extra:     m1Extra,
		shape:     m4ID,
		audit:     "hr.employee-schedule.update",
		rootAudit: "hr.employee-schedule.update",
	},
	{Method: http.MethodDelete, Path: "/api/hr/employees/:id/schedule-frames/:frameId"}: {
		cells: m1With(m4EmployeeWrite(false), func(c *m1Cells) {
			c.absentEmployee = m1Refused(409)
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			employee, frame := m4Frame(t, w)
			return m1Request{target: "/api/hr/employees/" + employee + "/schedule-frames/" + frame}
		},
		absent: m1Segment(4, m1Absent),
		// The second key is the frame: an absent one, or one of another employee, is the same 409.
		absentEmployee: m1Segment(6, m1Absent),
		invalid:        []m1Edit{m1Segment(4, "bad"), m1Segment(6, "bad")},
		shape:          m4ID,
		audit:          "hr.employee-schedule.update",
		rootAudit:      "hr.employee-schedule.update",
	},
	{Method: http.MethodGet, Path: "/api/hr/employees/:id/schedule"}: {
		cells: m4EmployeeRead(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/hr/employees/" + m4Employee(t, w) + "/schedule?from=2031-03-10&to=2031-03-16"}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Segment(4, "bad"), m4Swap("?from=2031-03-10&to=2031-03-16", ""), m4Swap("to=2031-03-16", "to=2031-03-09"),
			m4Swap("to=2031-03-16", "to=2031-06-16"), m4Swap("to=2031-03-16", "to=2031-03-16&limit=1"), m4Swap("to=2031-03-16", "to=2031-02-30"),
		},
		shape:     regexp.MustCompile(`^\{"employeeId":"` + m1UUID + `","days":\[\{"date":"2031-03-10","kind":"workday","shifts":\[\[540,780\],\[840,1080\]\]\},.*\{"date":"2031-03-16","kind":"off","shifts":\[\]\}\]\}$`),
		rootAudit: "access.employee.readSchedule",
	},
}

func m4Swap(old, replacement string) m1Edit {
	return func(r m1Request) m1Request { r.target = strings.Replace(r.target, old, replacement, 1); return r }
}

var m4Routes = []httpapi.Route{
	{Method: http.MethodGet, Path: "/api/hr/work-calendar"},
	{Method: http.MethodPut, Path: "/api/hr/work-calendar/holidays"},
	{Method: http.MethodPut, Path: "/api/hr/work-calendar/days/:date"},
	{Method: http.MethodGet, Path: "/api/hr/work-calendar/schedule"},
	{Method: http.MethodPut, Path: "/api/hr/work-calendar/schedule/:effectiveFrom"},
	{Method: http.MethodDelete, Path: "/api/hr/work-calendar/schedule/:effectiveFrom"},
	{Method: http.MethodGet, Path: "/api/hr/employees/:id/schedule-frames"},
	{Method: http.MethodPost, Path: "/api/hr/employees/:id/schedule-frames"},
	{Method: http.MethodDelete, Path: "/api/hr/employees/:id/schedule-frames/:frameId"},
	{Method: http.MethodGet, Path: "/api/hr/employees/:id/schedule"},
}

func TestM4RoutesAreMigrated(t *testing.T) {
	for _, route := range m4Routes {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s not migrated", route)
		}
		if _, ok := m4Matrix[route]; !ok {
			t.Errorf("%s served with no M4 matrix", route)
		}
	}
	if len(m4Matrix) != len(m4Routes) {
		t.Errorf("%d M4 matrix rows, want %d", len(m4Matrix), len(m4Routes))
	}
}

func newM4World(t *testing.T) *m1World {
	w := newM1World(t)
	for permission, template := range map[string]string{
		"workCalendar.read": "calendar", "workCalendar.manage": "calendar", "workCalendar.manageSchedule": "calendar",
		"employee.readSchedule": "allEmployees", "employee.manageSchedule": "allEmployees",
	} {
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", template)
	}
	w.exec(t, m1InsertRule, w.ids["scoped"], "employee.manageSchedule", "allow", "selfEmployee")
	return w
}

func TestTheM4RoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM4World(t)
	statuses := m1ContractStatuses(t)
	for _, route := range httpapi.MigratedRoutes {
		if row, ok := m4Matrix[route]; ok {
			t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, row, statuses[route]) })
		}
	}
}

// The foreign cells of the frame routes send scoped, whose grants are selfEmployee: it reads and writes
// the frames of its own employee, so the 404 on another employee is the scope, not a missing grant.
func TestM4ScopedGrantsReachOnlyTheirOwnEmployee(t *testing.T) {
	w := newM4World(t)
	own := "/api/hr/employees/" + w.scalar(t, `SELECT id::text FROM employee WHERE account_id=$1`, w.ids["scoped"])
	for _, target := range []string{own + "/schedule-frames", own + "/schedule?from=2031-03-10&to=2031-03-16"} {
		if status, body := w.send(http.MethodGet, "scoped", m1Request{target: target}, nil); status != http.StatusOK {
			t.Errorf("scoped GET %s: %d %s", target, status, body)
		}
	}
	add := m1Request{own + "/schedule-frames", `{"validFrom":"2031-05-05","validTo":"2031-06-30","days":` + m4Week + `}`}
	w.succeed(t, "scoped add", "scoped", http.MethodPost, add, m4ID, http.StatusCreated, "hr.employee-schedule.update")
	frame := w.scalar(t, `SELECT s.id::text FROM employee_schedule s JOIN employee e ON e.id=s.employee_id WHERE e.account_id=$1`, w.ids["scoped"])
	w.succeed(t, "scoped end", "scoped", http.MethodDelete, m1Request{target: own + "/schedule-frames/" + frame}, m4ID, http.StatusOK, "hr.employee-schedule.update")
}

// A frame is reached only through its employee: the frame of another employee is the 409 of no frame.
func TestM4FrameOfAnotherEmployeeIsNoFrame(t *testing.T) {
	w := newM4World(t)
	_, frame := m4Frame(t, w)
	own := "/api/hr/employees/" + w.scalar(t, `SELECT id::text FROM employee WHERE account_id=$1`, w.ids["scoped"])
	for actor, employee := range map[string]string{"hr": "/api/hr/employees/" + m4Employee(t, w), "scoped": own} {
		before := w.scalar(t, m4State)
		status, body := w.send(http.MethodDelete, actor, m1Request{target: employee + "/schedule-frames/" + frame}, nil)
		if !m1Refused(http.StatusConflict).answers(status, body) {
			t.Errorf("%s: %d %s", actor, status, body)
		}
		if after := w.scalar(t, m4State); after != before {
			t.Errorf("%s changed the state: %s -> %s", actor, before, after)
		}
	}
}
