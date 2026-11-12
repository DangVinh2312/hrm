//go:build integration

package app

import (
	"encoding/json/v2"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/test/fixture"
)

type m5Result struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	Version string `json:"version"`
}

func m5Command(t *testing.T, w *m1World, actor, target, body string) m5Result {
	t.Helper()
	status, response := w.send(http.MethodPost, actor, m1Request{target, body}, m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
	if status != http.StatusCreated && status != http.StatusOK {
		t.Fatalf("%s %s: %d %s", actor, target, status, response)
	}
	var result m5Result
	if err := json.Unmarshal([]byte(response), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestM5WorkflowReconciliationDetailApprovalAndCancellation(t *testing.T) {
	w := newM5cWorld(t)
	w.ids["owner"] = w.ids["owner hr"]
	w.secrets["owner"] = fixture.Session(t, w.stack, w.ids["owner"], fixture.SessionSpec{Fresh: true})
	coo := fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.coo"}}).ID
	w.ids["coo"], w.secrets["coo"] = coo, fixture.Session(t, w.stack, coo, fixture.SessionSpec{Fresh: true})
	owner := w.scalar(t, `SELECT id::text FROM employee WHERE account_id=$1`, w.ids["owner"])
	w.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official',DATE '2020-01-06')`, owner)
	w.exec(t, `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) SELECT g,public.hr_register_object('leaveRate',g),$1,DATE '2020-01-06',5760 FROM gen_random_uuid() g`, owner)
	date := m5bDate(t, w)
	input := `{"kind":"annual-leave","reason":"Matrix","segments":[{"date":"` + date + `","startMinute":540,"endMinute":780}]}`
	r := m5Command(t, w, "owner", "/api/hr/requests", input)
	if r.State != "pending_lead" || r.Version != "1" {
		t.Fatalf("submit %+v", r)
	}
	m5Balance(t, w, owner, date, 0, 240)
	adjust := "/api/hr/employees/" + owner + "/leave-adjustments"
	m5Command(t, w, "hr", adjust, `{"minutes":-175680,"effectiveOn":"`+date[:4]+`-01-01","reference":"reconciliation"}`)
	status, response := w.send(http.MethodGet, "hr", m1Request{target: "/api/hr/leave/reconciliation?year=" + date[:4]}, nil)
	var reconciliation struct {
		Items []struct {
			RequestIDs []string `json:"requestIds"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(response), &reconciliation); err != nil || status != http.StatusOK || len(reconciliation.Items) == 0 || len(reconciliation.Items[0].RequestIDs) != 1 || reconciliation.Items[0].RequestIDs[0] != r.ID {
		t.Fatalf("reconciliation: %d %s %v", status, response, err)
	}
	status, response = w.send(http.MethodGet, "hr", m1Request{target: "/api/hr/requests/" + reconciliation.Items[0].RequestIDs[0]}, nil)
	if status != http.StatusOK || !strings.Contains(response, `"id":"`+r.ID+`"`) || !strings.Contains(response, `"reason":"Matrix"`) {
		t.Fatalf("HR opens the reconciled request: %d %s", status, response)
	}
	m5Command(t, w, "hr", adjust, `{"minutes":175680,"effectiveOn":"`+date[:4]+`-01-01","reference":"restore"}`)
	for _, actor := range []string{"hr", "coo"} {
		r = m5Command(t, w, actor, "/api/hr/requests/"+r.ID+"/decision", `{"expectedVersion":"`+r.Version+`","decision":"approve"}`)
	}
	if r.State != "approved" || r.Version != "3" || w.scalar(t, `SELECT coalesce(sum(minutes),0)::text FROM leave_ledger WHERE source_request_id=$1 AND entry_kind='debit'`, r.ID) != "240" {
		t.Fatalf("approval/effect %+v", r)
	}
	m5Balance(t, w, owner, date, 240, 0)
	r = m5Command(t, w, "hr", "/api/hr/requests/"+r.ID+"/cancel", `{"expectedVersion":"3","reason":"Cancelled"}`)
	if r.State != "cancelled" || r.Version != "4" || w.scalar(t, `SELECT coalesce(sum(minutes),0)::text FROM leave_ledger WHERE reverses_entry_id IN(SELECT id FROM leave_ledger WHERE source_request_id=$1)`, r.ID) != "240" {
		t.Fatalf("cancel/reversal %+v", r)
	}
	m5Balance(t, w, owner, date, 0, 0)
	again := m5Command(t, w, "owner", "/api/hr/requests", input)
	if again.State != "pending_lead" || again.ID == r.ID {
		t.Errorf("cancel did not free the slot: %+v", again)
	}
	again = m5Command(t, w, "hr", "/api/hr/requests/"+again.ID+"/decision", `{"expectedVersion":"1","decision":"approve"}`)
	again = m5Command(t, w, "root", "/api/hr/requests/"+again.ID+"/decision", `{"expectedVersion":"2","decision":"approve"}`)
	if again.State != "approved" || w.scalar(t, `SELECT coalesce(sum(minutes),0)::text FROM leave_ledger WHERE source_request_id=$1 AND entry_kind='debit'`, again.ID) != "240" {
		t.Fatalf("Root final approval/effect %+v", again)
	}
	again = m5Command(t, w, "root", "/api/hr/requests/"+again.ID+"/cancel", `{"expectedVersion":"3","reason":"Root cancellation"}`)
	if again.State != "cancelled" || w.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok' AND safe_metadata->>'key'=$2 AND event_kind IN(convert_to('hr.request.decide-final','UTF8'),convert_to('hr.request.cancel-approved','UTF8'))`, w.ids["root"], again.ID) != "2" {
		t.Errorf("Root effects lack their targeted audit: %+v", again)
	}
	m5Balance(t, w, owner, date, 0, 0)
}

func TestM5RootCommandsOnAnAbsentRequestAuditTheAbsentTarget(t *testing.T) {
	w := newM5cWorld(t)
	audits := func() string {
		return w.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.workRequest.read','UTF8') AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='absent' AND safe_metadata->>'key'=$2`, w.ids["root"], m1Absent)
	}
	if n := audits(); n != "0" {
		t.Fatalf("absent audits before commands: %s", n)
	}
	for i, tc := range []struct{ route, body string }{
		{"decision", `{"expectedVersion":"1","decision":"approve"}`},
		{"cancel", `{"expectedVersion":"1","reason":"Absent"}`},
	} {
		status, body := w.send(http.MethodPost, "root", m1Request{"/api/hr/requests/" + m1Absent + "/" + tc.route, tc.body}, m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
		if status != http.StatusNotFound || body != `{"statusCode":404,"code":"error.notFound"}` {
			t.Errorf("Root %s on an absent request: %d %s", tc.route, status, body)
		}
		if n := audits(); n != strconv.Itoa(i+1) {
			t.Errorf("Root %s absent audits = %s, want %d", tc.route, n, i+1)
		}
	}
}

func m5Balance(t *testing.T, w *m1World, employee, date string, used, pending int) {
	t.Helper()
	status, body := w.send(http.MethodGet, "hr", m1Request{target: "/api/hr/employees/" + employee + "/leave-balance?date=" + date}, nil)
	var balance struct {
		Used    int `json:"usedMinutes"`
		Pending int `json:"pendingMinutes"`
	}
	if err := json.Unmarshal([]byte(body), &balance); err != nil || status != http.StatusOK || balance.Used != used || balance.Pending != pending {
		t.Errorf("balance: %d %s %v, want used=%d pending=%d", status, body, err, used, pending)
	}
}

func TestM5CalendarDaysAndEndedMembershipRejectSubmitsWithoutWrites(t *testing.T) {
	w := newM5bWorld(t)
	day := w.scalar(t, `SELECT to_char(`+hrbase.BusinessToday+` + (15-extract(isodow FROM `+hrbase.BusinessToday+`)::int),'YYYY-MM-DD')`)
	saturday := w.scalar(t, `SELECT to_char(CAST($1 AS date)+5,'YYYY-MM-DD')`, day)
	for _, tc := range []struct{ date, body string }{
		{day, `"holiday":"Synthetic holiday"`},
		{saturday, `"makeup":{"asWeekday":1,"frameSource":"company"}`},
	} {
		w.asRoot(t, http.MethodPut, m1Request{"/api/hr/work-calendar/days/" + tc.date, `{"expectedVersion":"` + m4Version(t, w) + `",` + tc.body + `}`}, http.StatusOK)
	}
	for _, tc := range []struct{ body, code string }{
		{`{"kind":"late-arrival","reason":"x","date":"` + day + `","expectedMinute":600}`, "error.nonWorkingDay"},
		{`{"kind":"annual-leave","reason":"x","segments":[{"date":"` + saturday + `","startMinute":540,"endMinute":780}]}`, "error.makeupDay"},
	} {
		before := w.state(t)
		status, body := w.send(http.MethodPost, "hr", m1Request{"/api/hr/requests", tc.body}, m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
		if status != http.StatusUnprocessableEntity || body != `{"statusCode":422,"code":"`+tc.code+`"}` || w.state(t) != before {
			t.Errorf("calendar refusal: %d %s", status, body)
		}
	}
	team := w.scalar(t, `SELECT m.team_id::text FROM team_membership m JOIN employee e ON e.id=m.employee_id WHERE e.account_id=$1 AND m.ends_at IS NULL`, w.ids["hr"])
	employee := w.scalar(t, `SELECT id::text FROM employee WHERE account_id=$1`, w.ids["hr"])
	w.asRoot(t, http.MethodDelete, m1Request{target: "/api/hr/teams/" + team + "/members/" + employee}, http.StatusOK)
	workday := w.scalar(t, `SELECT to_char(CAST($1 AS date)+1,'YYYY-MM-DD')`, day)
	before := w.state(t)
	for _, requested := range []string{team, m1Absent} {
		status, body := w.send(http.MethodPost, "hr", m1Request{"/api/hr/requests", `{"kind":"late-arrival","reason":"x","date":"` + workday + `","expectedMinute":600,"teamId":"` + requested + `"}`}, m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil))
		if status != http.StatusUnprocessableEntity || body != `{"statusCode":422,"code":"error.teamNotMember"}` || w.state(t) != before {
			t.Errorf("ended/unknown membership: %d %s", status, body)
		}
	}
	if n, err := strconv.Atoi(w.scalar(t, `SELECT count(*)::text FROM work_request`)); err != nil || n != 0 {
		t.Errorf("refusals kept %d requests: %v", n, err)
	}
}
