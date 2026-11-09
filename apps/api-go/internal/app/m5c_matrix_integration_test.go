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
	"hrm/api-go/test/fixture"
)

var (
	m5cDecisionRoute = httpapi.Route{Method: http.MethodPost, Path: "/api/hr/requests/:id/decision"}
	m5cRoutes        = []httpapi.Route{
		m5cDecisionRoute,
		{Method: http.MethodGet, Path: "/api/hr/approvals/lead"},
		{Method: http.MethodGet, Path: "/api/hr/approvals/final"},
		{Method: http.MethodGet, Path: "/api/hr/approvals/decided"},
	}
	m5cOnList   = "no id in the path: the list is filtered by the scope in SQL before the page"
	m5cListOf   = []m1Edit{m1Query("limit=0"), m1Query("limit=abc"), m1Query("limit=101"), m1Query("offset=-1"), m1Query("sort=kind"), m1Query("limit=1&limit=2")}
	m5cDecided  = `,"decision":\{"stage":"(lead|final)","decision":"reject","actorKind":"user","decidedAt":"[^"]+Z"\}`
	m5cRejected = regexp.MustCompile(`^\{"id":"` + m1UUID + `","state":"rejected","version":"2"\}$`)
)

// m5cItem is one queue item in state; name and decision are the extra members of the decided history.
func m5cItem(state, name, decision string) string {
	return `\{"id":"` + m1UUID + `","employeeId":"` + m1UUID + `",` + name + `"kind":"late-arrival","state":"` + state + `","version":"[1-9][0-9]*","teamId":"` + m1UUID +
		`","createdAt":"[^"]+Z","startDate":"` + m4Date + `","endDate":"` + m4Date + `","minutes":60` + decision + `\}`
}

func m5cPage(item string, empty bool) *regexp.Regexp {
	if empty {
		return regexp.MustCompile(`^\{"items":\[(` + item + `(,` + item + `)*)?\],"total":"[0-9]+"\}$`)
	}
	return regexp.MustCompile(`^\{"items":\[` + item + `(,` + item + `)*\],"total":"[1-9][0-9]*"\}$`)
}

// m5cRequest is a late arrival of the owner led by lead, in state, written in SQL; a rejected one carries
// the lead's reject.
func m5cRequest(t *testing.T, w *m1World, lead, state string) string {
	t.Helper()
	owner := w.ids["owner "+lead]
	request := w.scalar(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),e.id,e.account_id,m.team_id,'late-arrival',$2,'Matrix'
        FROM gen_random_uuid() g, employee e JOIN team_membership m ON m.employee_id=e.id AND m.is_primary AND m.ends_at IS NULL
       WHERE e.account_id=$1 RETURNING id::text`, owner, state)
	w.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      VALUES($1,'late-arrival',CAST($2 AS date),540,600,60)`, request, m5bDate(t, w))
	if state == "rejected" {
		w.exec(t, `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,reason)
        VALUES(gen_random_uuid(),$1,'lead','reject','user',$2,'Matrix')`, request, w.ids[lead])
	}
	return request
}

func m5cQueue(state string) func(*testing.T, *m1World) m1Request {
	return func(t *testing.T, w *m1World) m1Request {
		for _, lead := range []string{"hr", "denied", "none"} {
			m5cRequest(t, w, lead, state)
		}
		target := map[string]string{"pending_lead": "lead", "pending_final": "final", "rejected": "decided"}[state]
		return m1Request{target: "/api/hr/approvals/" + target}
	}
}

func m5cList(shape *regexp.Regexp, prepare func(*testing.T, *m1World) m1Request, rootAudit string) m1Row {
	return m1Row{
		cells: m1With(m1Read(), func(c *m1Cells) {
			c.noGrant, c.deny, c.idempotency, c.invalid = m5bEmptyPage, m5bEmptyPage, m5bNoKey, m1Refused(400)
			c.foreign, c.absent, c.absentEmployee = m1NA(m5cOnList), m1NA("no id in the path"), m1NA("no employee in the path")
		}),
		prepare:   prepare,
		invalid:   m5cListOf,
		shape:     shape,
		rootAudit: rootAudit,
	}
}

// The lead queue of Root is empty (Root leads no team), so its shape takes an empty page too; the lead's
// own requests are checked in TestM5cTheLeadQueueHoldsWhatTheLeadDecides.
var m5cMatrix = map[httpapi.Route]m1Row{
	{Method: http.MethodGet, Path: "/api/hr/approvals/lead"}:    m5cList(m5cPage(m5cItem("pending_lead", "", ""), true), m5cQueue("pending_lead"), "access.workRequest.decideLead"),
	{Method: http.MethodGet, Path: "/api/hr/approvals/final"}:   m5cList(m5cPage(m5cItem("pending_final", "", ""), false), m5cQueue("pending_final"), "access.workRequest.decideFinal"),
	{Method: http.MethodGet, Path: "/api/hr/approvals/decided"}: m5cList(m5cPage(m5cItem("rejected", `"employeeName":"[^"]+",`, m5cDecided), false), m5cQueue("rejected"), "access.workRequest.readDecided"),
}

// The decision is classified by session only, so the guard of authorize routes does not list it; its row
// is checked here with the same cells.
var m5cDecision = m1Row{
	cells: m1With(m1Write(), func(c *m1Cells) {
		c.noGrant, c.deny, c.foreign, c.absent, c.invalid, c.extra, c.idempotency = m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(404), m1Refused(400), m1Refused(400), m5aKeyReused
		c.boundary = m1NA("the permissions are outside the hrAdministration boundary package")
		c.fresh = m1NA("the stage policies carry no fresh@1")
		c.absentEmployee = m1NA("the request is the target, no employee in the path")
	}),
	prepare: func(t *testing.T, w *m1World) m1Request {
		return m1Request{"/api/hr/requests/" + m5cRequest(t, w, "hr", "pending_final") + "/decision", `{"expectedVersion":"1","decision":"reject","reason":"Matrix"}`}
	},
	absent: m1Segment(4, m1Absent),
	invalid: []m1Edit{
		m1Segment(4, "bad"), m1Body(`{}`), m1Body(`[]`), m1Replace(`"reject"`, `"skip"`), m1Replace(`"expectedVersion":"1"`, `"expectedVersion":1`),
		m1Replace(`"expectedVersion":"1"`, `"expectedVersion":"01"`), m1Replace(`,"reason":"Matrix"`, ``), m1Replace(`"Matrix"`, `"   "`),
		m1Replace(`"reason":"Matrix"`, `"reason":"Matrix","acknowledgeWfhLimit":null`), m1Replace(`"reason":"Matrix"`, `"reason":"Matrix","stage":"final"`),
	},
	extra:     m1Extra,
	shape:     m5cRejected,
	audit:     "hr.request.decide-final",
	rootAudit: "hr.request.decide-final",
	keyed:     true,
	reuse:     m1Replace(`"reason":"Matrix"`, `"reason":"Other"`),
}

func TestM5cRoutesAreMigrated(t *testing.T) {
	for _, route := range m5cRoutes {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s not migrated", route)
		}
		if _, ok := m5cMatrix[route]; !ok && route != m5cDecisionRoute {
			t.Errorf("%s served with no M5c matrix", route)
		}
	}
	if len(m5cMatrix)+1 != len(m5cRoutes) {
		t.Errorf("%d M5c matrix rows, want %d", len(m5cMatrix)+1, len(m5cRoutes))
	}
}

// newM5cWorld makes hr and denied COOs (denied with a deny on every approval permission), and hr, denied
// and none the leads of one team each, with an owner whose requests they would decide: so the empty pages
// of none and denied are the missing grant or the deny, not a missing request.
func newM5cWorld(t *testing.T) *m1World {
	w := newM5bWorld(t)
	for _, permission := range []string{"workRequest.decideLead", "workRequest.decideFinal", "workRequest.readDecided"} {
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", "allRequests")
	}
	for _, lead := range []string{"hr", "denied", "none"} {
		if lead != "none" {
			w.exec(t, `INSERT INTO user_role(user_id,role_key) VALUES($1,convert_to('hr.coo','UTF8'))`, w.ids[lead])
		}
		team := w.team(t)
		owner := fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{m1Employee}}).ID
		w.ids["owner "+lead] = owner
		employee := fixture.Employee(t, w.stack, fixture.EmployeeSpec{AccountID: owner, HiredOn: "2020-01-06"}).ID
		w.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, team, employee)
		w.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at)
        SELECT gen_random_uuid(),$1,e.id,statement_timestamp()-interval '1 hour' FROM employee e WHERE e.account_id=$2`, team, w.ids[lead])
	}
	return w
}

func TestTheM5cRoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM5cWorld(t)
	statuses := m1ContractStatuses(t)
	for _, route := range httpapi.MigratedRoutes {
		row, ok := m5cMatrix[route]
		if route == m5cDecisionRoute {
			row, ok = m5cDecision, true
		}
		if ok {
			t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, row, statuses[route]) })
		}
	}
}

func TestM5cTheLeadQueueHoldsWhatTheLeadDecides(t *testing.T) {
	w := newM5cWorld(t)
	request := m5cRequest(t, w, "hr", "pending_lead")
	if status, body := w.send(http.MethodGet, "hr", m1Request{target: "/api/hr/approvals/lead"}, nil); status != http.StatusOK || !strings.Contains(body, `"id":"`+request+`"`) || !m5cPage(m5cItem("pending_lead", "", ""), false).MatchString(body) {
		t.Errorf("lead queue: %d %s", status, body)
	}
	decide := m1Request{"/api/hr/requests/" + request + "/decision", `{"expectedVersion":"1","decision":"approve"}`}
	w.succeed(t, "lead approval", "hr", http.MethodPost, decide, regexp.MustCompile(`^\{"id":"`+request+`","state":"approved","version":"2"\}$`), http.StatusOK, "hr.request.decide-lead", m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
}

// Root's retry of a decision adds one access row naming the request; an IAM retry adds none.
func TestM5cARootRetryIsAuditedOnTheRequestAndAnIAMRetryIsNot(t *testing.T) {
	w := newM5cWorld(t)
	for actor, want := range map[string]int{"root": 1, "hr": 0} {
		r := m5cDecision.prepare(t, w)
		request := strings.Split(r.target, "/")[4]
		key := m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil)
		status, first := w.send(http.MethodPost, actor, r, key)
		if status != http.StatusOK {
			t.Fatalf("%s: %d %s", actor, status, first)
		}
		total := func() int {
			n, err := strconv.Atoi(w.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`, w.ids[actor]))
			if err != nil {
				t.Fatal(err)
			}
			return n
		}
		targeted := `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND object_id IS NULL AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'key'=$2`
		before, named, state := total(), w.scalar(t, targeted, w.ids[actor], request), w.state(t)
		if status, body := w.send(http.MethodPost, actor, r, key); status != http.StatusOK || body != first {
			t.Errorf("%s replay: %d %s, first %s", actor, status, body, first)
		}
		if after := total(); after != before+want {
			t.Errorf("%s replay audits %d -> %d", actor, before, after)
		}
		n, err := strconv.Atoi(named)
		if err != nil {
			t.Fatal(err)
		}
		if got := w.scalar(t, targeted, w.ids[actor], request); got != strconv.Itoa(n+want) {
			t.Errorf("%s replay: %s rows naming the request, had %d", actor, got, n)
		}
		if want == 0 && w.state(t) != state {
			t.Errorf("an IAM replay changed the state")
		}
	}
}
