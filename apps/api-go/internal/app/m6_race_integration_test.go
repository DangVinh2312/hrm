//go:build integration

package app

import (
	"context"
	"encoding/json/v2"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const m6PeriodClosed = `{"statusCode":409,"code":"error.periodClosed"}`

type m6Outcome struct {
	status int
	body   string
}

// m6Totals is the part of a sheet that a closed month keeps in its snapshot.
type m6Totals struct {
	ScheduledMinutes   int `json:"scheduledMinutes"`
	PaidHolidayMinutes int `json:"paidHolidayMinutes"`
	UnpaidMinutes      int `json:"unpaidMinutes"`
	AnnualLeaveMinutes int `json:"annualLeaveMinutes"`
	PaidMinutes        int `json:"paidMinutes"`
	WfhDays            int `json:"wfhDays"`
	LateCount          int `json:"lateCount"`
	LateMinutes        int `json:"lateMinutes"`
	EarlyCount         int `json:"earlyCount"`
	EarlyMinutes       int `json:"earlyMinutes"`
	AdjustmentMinutes  int `json:"adjustmentMinutes"`
}

// blocked reports whether n data-login backends wait on a lock within 3 s, a margin for a loaded machine.
func (w *m1World) blocked(t *testing.T, n int) bool {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if w.scalar(t, `SELECT (count(*) >= $1)::text FROM pg_stat_activity WHERE datname=current_database() AND usename='product_data' AND cardinality(pg_blocking_pids(pid))>0`, n) == "true" {
			return true
		}
	}
	return false
}

// held runs attempts behind a superuser transaction that ran lock: attempt i+1 starts once i+1 data-login
// backends wait, so they reach the rows they contend for in the given order; then the holder commits.
func (w *m1World) held(t *testing.T, lock string, attempts ...func() m6Outcome) []m6Outcome {
	t.Helper()
	holder, err := w.stack.Cluster.ConnectSuperuser(t.Context(), w.stack.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := holder.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	tx, err := holder.Begin(t.Context())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := tx.Exec(t.Context(), lock); err != nil {
		t.Fatal(test.Redact(err))
	}
	done := make([]chan m6Outcome, len(attempts))
	reached := true
	for i, attempt := range attempts {
		done[i] = make(chan m6Outcome, 1)
		go func() { done[i] <- attempt() }()
		if reached = w.blocked(t, i+1); !reached {
			break
		}
	}
	end := tx.Commit
	if !reached {
		end = tx.Rollback
	}
	if err := end(t.Context()); err != nil {
		t.Fatal(test.Redact(err))
	}
	outcomes := make([]m6Outcome, 0, len(attempts))
	for _, outcome := range done {
		if outcome != nil {
			outcomes = append(outcomes, <-outcome)
		}
	}
	if !reached {
		t.Fatalf("the attempts were never in flight together: %+v", outcomes)
	}
	return outcomes
}

// gated holds audit_outbox in SHARE mode: a command runs to its audit append with every row lock it took still
// held, so the first attempt is mid-commit when the second reaches its locks.
func (w *m1World) gated(t *testing.T, attempts ...func() m6Outcome) []m6Outcome {
	t.Helper()
	return w.held(t, `LOCK TABLE audit_outbox IN SHARE MODE`, attempts...)
}

// call is an attempt of actor; its key is drawn here, before it runs, because w.conn is not safe across goroutines.
func (w *m1World) call(t *testing.T, method, actor, target, body string, keyed bool) func() m6Outcome {
	t.Helper()
	var edit func(*http.Request)
	if keyed {
		edit = m1Key(w.scalar(t, `SELECT gen_random_uuid()::text`), nil)
	}
	return func() m6Outcome {
		status, answer := w.send(method, actor, m1Request{target, body}, edit)
		return m6Outcome{status, answer}
	}
}

func (w *m1World) closeMonth(t *testing.T, month string) func() m6Outcome {
	t.Helper()
	return w.call(t, http.MethodPost, "hr", "/api/hr/attendance/periods/"+month+"/close", `{}`, false)
}

func (w *m1World) reopenMonth(t *testing.T, month string) {
	t.Helper()
	if status, body := w.send(http.MethodPost, "hr", m1Request{"/api/hr/attendance/periods/" + month + "/reopen", `{"reason":"Race round"}`}, nil); status != http.StatusOK {
		t.Fatalf("reopen %s: %d %s", month, status, body)
	}
}

// stored is the snapshot entry of employee in the closed month, or false when the snapshot does not hold it.
func (w *m1World) stored(t *testing.T, month, employee string) (m6Totals, bool) {
	t.Helper()
	text := w.scalar(t, `SELECT coalesce((SELECT e::text FROM attendance_period p, jsonb_array_elements(p.snapshot->'employees') e
      WHERE p.month=CAST($1 AS date) AND p.state='closed' AND e->>'employeeId'=$2),'')`, month+"-01", employee)
	if text == "" {
		return m6Totals{}, false
	}
	var totals m6Totals
	if err := json.Unmarshal([]byte(text), &totals); err != nil {
		t.Fatal(err)
	}
	return totals, true
}

func (w *m1World) live(t *testing.T, month, employee string) m6Totals {
	t.Helper()
	status, body := w.send(http.MethodGet, "hr", m1Request{target: "/api/hr/employees/" + employee + "/attendance?month=" + month}, nil)
	var totals m6Totals
	if err := json.Unmarshal([]byte(body), &totals); status != http.StatusOK || err != nil {
		t.Fatalf("sheet of %s: %d %s %v", employee, status, body, err)
	}
	return totals
}

// m6Member is an official employee of the team hr leads, with an account, a leave rate and a fresh session.
func m6Member(t *testing.T, w *m1World) (string, string) {
	t.Helper()
	name := w.name()
	w.ids[name] = fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{m1Employee}}).ID
	w.secrets[name] = fixture.Session(t, w.stack, w.ids[name], fixture.SessionSpec{Fresh: true})
	employee := fixture.Employee(t, w.stack, fixture.EmployeeSpec{AccountID: w.ids[name], HiredOn: "2020-01-06"}).ID
	w.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official',DATE '2020-01-06')`, employee)
	w.exec(t, `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) SELECT g,public.hr_register_object('leaveRate',g),$1,DATE '2020-01-06',5760 FROM gen_random_uuid() g`, employee)
	w.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at)
      SELECT gen_random_uuid(),a.team_id,$1,true,statement_timestamp()-interval '1 hour'
        FROM team_lead_assignment a JOIN employee l ON l.id=a.lead_employee_id WHERE l.account_id=$2 AND a.ends_at IS NULL`, employee, w.ids["hr"])
	return name, employee
}

// m6Request is a request of kind on day in state, written in SQL as the TypeScript fixtureRequest does.
func m6Request(t *testing.T, w *m1World, employee, kind, day, state string) string {
	t.Helper()
	request := w.scalar(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),e.id,e.account_id,m.team_id,$2,$3,'Race'
        FROM gen_random_uuid() g, employee e JOIN team_membership m ON m.employee_id=e.id AND m.is_primary AND m.ends_at IS NULL
       WHERE e.id=$1 RETURNING id::text`, employee, kind, state)
	span := map[string][2]int{"wfh": {540, 1080}, "annual-leave": {540, 780}, "unpaid-leave": {540, 780}, "late-arrival": {540, 600}, "early-departure": {1020, 1080}}[kind]
	start, end := span[0], span[1]
	w.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      VALUES($1,$2,CAST($3 AS date),$4,$5,$6)`, request, kind, day, start, end, end-start)
	return request
}

// m6Days is the month of the latest weekday on or before the DB date (inside the submit window), that weekday,
// and three other weekdays of the month.
func m6Days(t *testing.T, w *m1World) (string, string, []string) {
	t.Helper()
	latest := w.scalar(t, `SELECT to_char(d,'YYYY-MM-DD') FROM generate_series(`+hrbase.BusinessToday+` - 6, `+hrbase.BusinessToday+`, interval '1 day') g(d)
      WHERE extract(isodow FROM d) < 6 ORDER BY d DESC LIMIT 1`)
	others := strings.Split(w.scalar(t, `SELECT string_agg(to_char(d,'YYYY-MM-DD'),',' ORDER BY d) FROM (
      SELECT d FROM generate_series(date_trunc('month',CAST($1 AS date)), date_trunc('month',CAST($1 AS date)) + interval '27 days', interval '1 day') g(d)
       WHERE extract(isodow FROM d) < 6 AND d <> CAST($1 AS date) ORDER BY d LIMIT 3) x`, latest), ",")
	return latest[:7], latest, others
}

// m6Writer is one command that changes the numbers of a month: it is set up, then raced against the close.
type m6Writer struct {
	name string
	// prepare returns the attempt and the employee whose sheet it changes ("" when the attempt creates it).
	prepare func(t *testing.T, w *m1World, month, day string) (func() m6Outcome, string)
}

func m6Writers(t *testing.T, w *m1World, latest string) []m6Writer {
	t.Helper()
	approval := func(kind string) func(*testing.T, *m1World, string, string) (func() m6Outcome, string) {
		return func(t *testing.T, w *m1World, _, day string) (func() m6Outcome, string) {
			_, employee := m6Member(t, w)
			request := m6Request(t, w, employee, kind, day, "pending_final")
			return w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+request+"/decision", `{"expectedVersion":"1","decision":"approve"}`, true), employee
		}
	}
	cancel := func(kind string) func(*testing.T, *m1World, string, string) (func() m6Outcome, string) {
		return func(t *testing.T, w *m1World, _, day string) (func() m6Outcome, string) {
			_, employee := m6Member(t, w)
			request := m6Request(t, w, employee, kind, day, "pending_final")
			if outcome := w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+request+"/decision", `{"expectedVersion":"1","decision":"approve"}`, true)(); outcome.status != http.StatusOK {
				t.Fatalf("approve %s: %+v", kind, outcome)
			}
			return w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+request+"/cancel", `{"expectedVersion":"2","reason":"Race"}`, true), employee
		}
	}
	return []m6Writer{
		{"wfh approval", approval("wfh")},
		{"annual leave approval", approval("annual-leave")},
		{"wfh cancellation", cancel("wfh")},
		{"annual leave cancellation", cancel("annual-leave")},
		{"submit", func(t *testing.T, w *m1World, _, _ string) (func() m6Outcome, string) {
			name, employee := m6Member(t, w)
			return w.call(t, http.MethodPost, name, "/api/hr/requests", `{"kind":"wfh","reason":"Race","dates":["`+latest+`"]}`, true), employee
		}},
		{"adjustment", func(t *testing.T, w *m1World, _, day string) (func() m6Outcome, string) {
			_, employee := m6Member(t, w)
			return w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+employee+"/attendance-adjustments", `{"workDate":"`+day+`","minutes":45,"reason":"Race"}`, true), employee
		}},
		{"calendar day", func(t *testing.T, w *m1World, _, day string) (func() m6Outcome, string) {
			_, employee := m6Member(t, w)
			return w.call(t, http.MethodPut, "hr", "/api/hr/work-calendar/days/"+day, `{"expectedVersion":"`+m4Version(t, w)+`","holiday":"Race holiday"}`, false), employee
		}},
		{"termination", func(t *testing.T, w *m1World, _, day string) (func() m6Outcome, string) {
			_, employee := m6Member(t, w)
			return w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+employee+"/termination", `{"terminatedOn":"`+day+`"}`, false), employee
		}},
		{"hire", func(t *testing.T, w *m1World, _, day string) (func() m6Outcome, string) {
			code := strings.ReplaceAll(w.name(), " ", "-")
			return w.call(t, http.MethodPost, "hr", "/api/hr/employees", `{"code":"`+code+`","fullName":"Race hire","hiredOn":"`+day+`","status":"probation","position":null,"classification":null,"identity":`+m2Identity+`}`, false), ""
		}},
	}
}

// m6Writes is everything the writers raced against a close may write, without the period and the close's audit.
const m6Writes = `SELECT concat_ws('|',
 (SELECT count(*)||':'||coalesce(sum(version),0) FROM work_request),
 (SELECT count(*) FROM request_decision),
 (SELECT coalesce(sum(approved_count),0) FROM wfh_month_counter),
 (SELECT count(*) FROM leave_ledger),
 (SELECT count(*) FROM attendance_adjustment),
 (SELECT count(*) FROM hr_idempotency),
 (SELECT count(*)||':'||coalesce(sum(version),0) FROM employee),
 (SELECT count(*) FROM employment_status_period),
 (SELECT version FROM work_calendar),
 (SELECT count(*) FROM audit_outbox WHERE event_kind <> convert_to('hr.attendance-period.close','UTF8')))`

// Every writer of a month's numbers raced against its close, in both orders, through the routes. A writer that
// holds its locks first commits: it wrote, and its effect is on the sheet (a pending submit has none) and in the
// snapshot. A close that holds the month first makes the writer 409 error.periodClosed: nothing written, the sheet
// as before. Either way the snapshot holds exactly the live sheet afterwards and its calendar version is the
// final one.
func TestM6TheCloseRacingEveryWriterKeepsTheSnapshotEqualToTheSheet(t *testing.T) {
	w := newM5cWorld(t)
	month, latest, days := m6Days(t, w)
	w.exec(t, `INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING`, month+"-01")
	for _, writer := range m6Writers(t, w, latest) {
		for round, writerFirst := range []bool{true, false} {
			order := map[bool]string{true: "writer first", false: "close first"}[writerFirst]
			t.Run(writer.name+"/"+order, func(t *testing.T) {
				w.signIn(t)
				attempt, employee := writer.prepare(t, w, month, days[round])
				writes := w.scalar(t, m6Writes)
				var before m6Totals
				if employee != "" {
					before = w.live(t, month, employee)
				}
				var outcomes []m6Outcome
				if writerFirst {
					outcomes = w.gated(t, attempt, w.closeMonth(t, month))
				} else {
					outcomes = w.gated(t, w.closeMonth(t, month), attempt)
					outcomes[0], outcomes[1] = outcomes[1], outcomes[0]
				}
				written, closed := outcomes[0], outcomes[1]
				if closed.status != http.StatusOK {
					t.Fatalf("close: %+v", closed)
				}
				if writerFirst != (written.status < 300) || !writerFirst && written.body != m6PeriodClosed {
					t.Errorf("writer: %+v", written)
				}
				if after := w.scalar(t, m6Writes); writerFirst == (after == writes) {
					t.Errorf("writes %s -> %s", writes, after)
				}
				if employee == "" && writerFirst {
					var created struct {
						ID string `json:"id"`
					}
					if err := json.Unmarshal([]byte(written.body), &created); err != nil {
						t.Fatal(err)
					}
					employee = created.ID
				}
				if employee != "" {
					stored, held := w.stored(t, month, employee)
					live := w.live(t, month, employee)
					if !held || stored != live || live == (m6Totals{}) {
						t.Errorf("snapshot %+v (held %t) differs from the sheet %+v", stored, held, live)
					}
					if moved := live != before; writer.name != "hire" && moved != (writerFirst && writer.name != "submit") {
						t.Errorf("sheet %+v -> %+v", before, live)
					}
				}
				if version := w.scalar(t, `SELECT snapshot->>'calendarVersion' FROM attendance_period WHERE month=CAST($1 AS date)`, month+"-01"); version != m4Version(t, w) {
					t.Errorf("snapshot calendar %s, final %s", version, m4Version(t, w))
				}
				w.reopenMonth(t, month)
			})
		}
	}
}

// m6Contention counts the deadlocks, lock timeouts and retries of the app's runner: a retry ends a deadlock with
// the right outcome, so only the count tells one happened.
type m6Contention struct {
	mu    sync.Mutex
	count int
}

func (c *m6Contention) observe(using *steps) {
	using.runner.OnMetric = func(metric database.Metric, _ database.Mode, _ float64) {
		if metric == database.MetricDeadlock || metric == database.MetricTimeout || metric == database.MetricRetry {
			c.mu.Lock()
			c.count++
			c.mu.Unlock()
		}
	}
}

func (c *m6Contention) seen() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.count
}

// hrm-period-concurrency :249 and hrm-attendance-adjust :646 F-31: a holder keeps work_calendar; the first
// command takes the employee and the month FOR SHARE and waits at the calendar, the close waits for the month,
// the calendar change waits behind the holder. Released, the three are in the order that could deadlock: the
// first command and the close finish, the change finishes or is 409 error.periodClosed, no transaction met a
// deadlock, a lock timeout or a retry, and the snapshot is at the calendar version that was final when the month
// closed.
func TestM6ACommandACalendarChangeAndTheCloseOfOneMonthAllFinish(t *testing.T) {
	contention := &m6Contention{}
	w := newM5cWorld(t, contention.observe)
	month, latest, days := m6Days(t, w)
	w.exec(t, `INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING`, month+"-01")
	for round, first := range []string{"submit", "adjustment"} {
		t.Run(first, func(t *testing.T) {
			w.signIn(t)
			name, employee := m6Member(t, w)
			command := w.call(t, http.MethodPost, name, "/api/hr/requests", `{"kind":"wfh","reason":"Race","dates":["`+latest+`"]}`, true)
			if first == "adjustment" {
				command = w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+employee+"/attendance-adjustments", `{"workDate":"`+latest+`","minutes":30,"reason":"Race"}`, true)
			}
			change := w.call(t, http.MethodPut, "hr", "/api/hr/work-calendar/days/"+days[round], `{"expectedVersion":"`+m4Version(t, w)+`","holiday":"Race holiday"}`, false)
			contended := contention.seen()
			outcomes := w.held(t, `SELECT 1 FROM work_calendar FOR UPDATE`, command, w.closeMonth(t, month), change)
			if n := contention.seen() - contended; n != 0 {
				t.Errorf("%d deadlocks, lock timeouts or retries in the race", n)
			}
			if outcomes[0].status != http.StatusCreated || outcomes[1].status != http.StatusOK {
				t.Fatalf("%s %+v, close %+v", first, outcomes[0], outcomes[1])
			}
			if changed := outcomes[2]; changed.status != http.StatusOK && changed.body != m6PeriodClosed {
				t.Errorf("calendar change: %+v", changed)
			}
			if row := w.scalar(t, `SELECT state||':'||(snapshot->>'calendarVersion') FROM attendance_period WHERE month=CAST($1 AS date)`, month+"-01"); row != "closed:"+m4Version(t, w) {
				t.Errorf("period %s, final calendar %s", row, m4Version(t, w))
			}
			stored, held := w.stored(t, month, employee)
			if live := w.live(t, month, employee); !held || stored != live || first == "adjustment" && stored.AdjustmentMinutes != 30 {
				t.Errorf("snapshot %+v (held %t), sheet %+v", stored, held, live)
			}
			w.reopenMonth(t, month)
		})
	}
}

// Two transitions of one month in flight together: the first holds the company and the month up to its audit,
// the second waits for it. A second close (or reopen) of the month the first just moved is 409 with nothing
// written; a reopen behind a close goes through; the version moves once per committed transition and the
// history holds exactly those.
func TestM6CompetingTransitionsOfOneMonthMoveItOnce(t *testing.T) {
	w := newM6World(t)
	month := "2019-04"
	reopen := func() func() m6Outcome {
		return w.call(t, http.MethodPost, "hr", "/api/hr/attendance/periods/"+month+"/reopen", `{"reason":"Race"}`, false)
	}
	for _, round := range []struct {
		name     string
		attempts []func() m6Outcome
		want     [2]int
		state    string
	}{
		{"close and close", []func() m6Outcome{w.closeMonth(t, month), w.closeMonth(t, month)}, [2]int{200, 409}, "closed:2:1"},
		{"reopen and reopen", []func() m6Outcome{reopen(), reopen()}, [2]int{200, 409}, "open:3:2"},
		{"close and reopen", []func() m6Outcome{w.closeMonth(t, month), reopen()}, [2]int{200, 200}, "open:5:4"},
	} {
		outcomes := w.gated(t, round.attempts...)
		for i, outcome := range outcomes {
			if outcome.status != round.want[i] || outcome.status == http.StatusConflict && !m1Refused(http.StatusConflict).answers(outcome.status, outcome.body) {
				t.Errorf("%s #%d: %+v", round.name, i, outcome)
			}
		}
		if state := w.scalar(t, `SELECT p.state||':'||p.version||':'||(SELECT count(*) FROM attendance_period_event e WHERE e.month=p.month) FROM attendance_period p WHERE p.month=CAST($1 AS date)`, month+"-01"); state != round.state {
			t.Errorf("%s: %s, want %s", round.name, state, round.state)
		}
	}
	if history := w.scalar(t, `SELECT string_agg(event||version,',' ORDER BY version) FROM attendance_period_event WHERE month=CAST($1 AS date)`, month+"-01"); history != "close2,reopen3,close4,reopen5" {
		t.Errorf("history %s", history)
	}
}

// hrm-period-concurrency :67 (B-22): a hire, a confirmation as official or a termination dated in or before a
// closed month is 409 error.periodClosed with nothing written; the months after it stay open and the closed one
// keeps its snapshot; reopened, all three go through.
func TestM6EmploymentChangesInAClosedMonthWaitForItsReopen(t *testing.T) {
	w := newM6World(t)
	hire := func(hiredOn, status string) m6Outcome {
		code := strings.ReplaceAll(w.name(), " ", "-")
		return w.call(t, http.MethodPost, "hr", "/api/hr/employees", `{"code":"`+code+`","fullName":"Period hire","hiredOn":"`+hiredOn+`","status":"`+status+`","position":null,"classification":null,"identity":`+m2Identity+`}`, false)()
	}
	id := func(body string) string {
		var created struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal([]byte(body), &created); err != nil {
			t.Fatal(err)
		}
		return created.ID
	}
	staying := id(w.expect(t, hire("2026-01-05", "official"), http.StatusCreated))
	leaving := id(w.expect(t, hire("2026-01-05", "official"), http.StatusCreated))
	later := id(w.expect(t, hire("2026-01-05", "official"), http.StatusCreated))
	probation := id(w.expect(t, hire("2026-01-12", "probation"), http.StatusCreated))
	w.expect(t, w.closeMonth(t, "2026-02")(), http.StatusOK)
	snapshot, _ := w.stored(t, "2026-02", staying)
	refused := func(name string, outcome m6Outcome, before string) {
		t.Helper()
		if outcome.body != m6PeriodClosed || w.state(t) != before {
			t.Errorf("%s: %+v, state %s -> %s", name, outcome, before, w.state(t))
		}
	}
	for _, hiredOn := range []string{"2026-02-10", "2026-01-26"} {
		before := w.state(t)
		refused("hire "+hiredOn, hire(hiredOn, "official"), before)
	}
	for _, day := range []string{"2026-02-20", "2026-02-02"} {
		before := w.state(t)
		refused("official "+day, w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+probation+"/official", `{"effectiveOn":"`+day+`"}`, false)(), before)
	}
	for _, day := range []string{"2026-02-20", "2026-02-02", "2026-01-30"} {
		before := w.state(t)
		refused("termination "+day, w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+staying+"/termination", `{"terminatedOn":"`+day+`"}`, false)(), before)
	}
	w.expect(t, hire("2026-03-02", "official"), http.StatusCreated)
	w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+later+"/termination", `{"terminatedOn":"2026-03-13"}`, false)(), http.StatusOK)
	if live := w.live(t, "2026-02", staying); live != snapshot {
		t.Errorf("the closed month moved: snapshot %+v, sheet %+v", snapshot, live)
	}
	w.reopenMonth(t, "2026-02")
	w.expect(t, hire("2026-02-10", "official"), http.StatusCreated)
	w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+leaving+"/termination", `{"terminatedOn":"2026-02-20"}`, false)(), http.StatusOK)
	w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+probation+"/official", `{"effectiveOn":"2026-02-20"}`, false)(), http.StatusOK)
}

func (w *m1World) expect(t *testing.T, outcome m6Outcome, status int) string {
	t.Helper()
	if outcome.status != status {
		t.Fatalf("%d, want %d: %s", outcome.status, status, outcome.body)
	}
	return outcome.body
}

// Request effects through the routes on the Go sheet: the COO's own request is approved at submit and counts
// (hrm-coo-submit :55); a closed month refuses it with nothing written and takes it once reopened (:153);
// cancelling approved WFH, unpaid leave, a late arrival and an early departure gives back the sheet of before (hrm-cancel :213,
// :232); a closed month refuses the cancellation of approved leave, its debit stands, and the reopened month
// takes it (:253).
func TestM6RequestEffectsMoveTheSheetAndAClosedMonthWaitsForItsReopen(t *testing.T) {
	w := newM5cWorld(t)
	month, latest, _ := m6Days(t, w)
	coo, cooEmployee := m6Member(t, w)
	w.exec(t, `INSERT INTO user_role(user_id,role_key) VALUES($1,convert_to('hr.coo','UTF8'))`, w.ids[coo])
	submit := func(body string) m6Outcome {
		return w.call(t, http.MethodPost, coo, "/api/hr/requests", body, true)()
	}
	if body := w.expect(t, submit(`{"kind":"late-arrival","reason":"Own","date":"`+latest+`","expectedMinute":600}`), http.StatusCreated); !strings.Contains(body, `"state":"approved","version":"1"`) {
		t.Errorf("C-26 submit: %s", body)
	}
	if sheet := w.live(t, month, cooEmployee); sheet.LateCount != 1 {
		t.Errorf("C-26 sheet %+v", sheet)
	}
	w.expect(t, w.closeMonth(t, month)(), http.StatusOK)
	before := w.state(t)
	wfh := `{"kind":"wfh","reason":"Own","dates":["` + latest + `"]}`
	if body := w.expect(t, submit(wfh), http.StatusConflict); body != m6PeriodClosed || w.state(t) != before {
		t.Errorf("B-22 closed month: %s, state %s -> %s", body, before, w.state(t))
	}
	w.reopenMonth(t, month)
	if body := w.expect(t, submit(wfh), http.StatusCreated); !strings.Contains(body, `"state":"approved"`) {
		t.Errorf("B-22 reopened: %s", body)
	}
	if sheet := w.live(t, month, cooEmployee); sheet.WfhDays != 1 || sheet.LateCount != 1 {
		t.Errorf("reopened sheet %+v", sheet)
	}

	_, employee := m6Member(t, w)
	empty := w.live(t, "2026-04", employee)
	approve := func(kind, day string) string {
		request := m6Request(t, w, employee, kind, day, "pending_final")
		w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+request+"/decision", `{"expectedVersion":"1","decision":"approve"}`, true)(), http.StatusOK)
		return request
	}
	approved := []string{approve("wfh", "2026-04-14"), approve("unpaid-leave", "2026-04-15"), approve("late-arrival", "2026-04-16"), approve("early-departure", "2026-04-17")}
	if during := w.live(t, "2026-04", employee); during.WfhDays != 1 || during.UnpaidMinutes != 240 || during.LateCount != 1 || during.EarlyCount != 1 {
		t.Errorf("approved effects %+v", during)
	}
	for _, request := range approved {
		w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+request+"/cancel", `{"expectedVersion":"2","reason":"Cancel"}`, true)(), http.StatusOK)
	}
	if after := w.live(t, "2026-04", employee); after != empty || w.scalar(t, `SELECT coalesce(sum(approved_count),0)::text FROM wfh_month_counter WHERE employee_id=$1`, employee) != "0" {
		t.Errorf("cancelled effects %+v, before %+v", after, empty)
	}

	leave := approve("annual-leave", "2026-02-10")
	w.expect(t, w.closeMonth(t, "2026-02")(), http.StatusOK)
	ledger := func() string {
		return w.scalar(t, `SELECT count(*)::text FROM leave_ledger WHERE source_request_id=$1 OR reverses_entry_id IN (SELECT id FROM leave_ledger WHERE source_request_id=$1)`, leave)
	}
	before = w.state(t)
	cancel := `{"expectedVersion":"2","reason":"Closed"}`
	if body := w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+leave+"/cancel", cancel, true)(), http.StatusConflict); body != m6PeriodClosed || w.state(t) != before || ledger() != "1" {
		t.Errorf("F-11 closed month: %s, ledger %s", body, ledger())
	}
	w.reopenMonth(t, "2026-02")
	w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+leave+"/cancel", cancel, true)(), http.StatusOK)
	if n := ledger(); n != "2" {
		t.Errorf("F-11 reopened: ledger %s", n)
	}
}
