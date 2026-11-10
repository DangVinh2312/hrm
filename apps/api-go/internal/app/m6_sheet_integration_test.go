//go:build integration

package app

import (
	"context"
	"encoding/json/v2"
	"net/http"
	"strings"
	"testing"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendance"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture/attendanceoracle"
)

// oracle is the correlated facts of month: exactly ids, or with nil every employee employed in it.
func (w *m1World) oracle(t *testing.T, month string, ids []string) []attendancecore.FactsRow {
	t.Helper()
	facts, err := database.Run(t.Context(), w.stack.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) ([]attendancecore.FactsRow, error) {
		return attendanceoracle.LoadFacts(tx, month, ids)
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return facts
}

func oracleTotals(t *testing.T, month string, row attendancecore.FactsRow) attendancecore.Totals {
	t.Helper()
	totals, err := attendancecore.TotalsOf(month, row)
	if err != nil {
		t.Fatal(err)
	}
	return totals
}

// oracleSheet is the body the sheet route owes for employee in month: the totals of the oracle facts.
func (w *m1World) oracleSheet(t *testing.T, month, employee string) string {
	t.Helper()
	rows := w.oracle(t, month, []string{employee})
	if len(rows) != 1 {
		t.Fatalf("oracle facts of %s in %s: %d rows", employee, month, len(rows))
	}
	state := attendancecore.PeriodOpen
	if rows[0].PeriodState != nil {
		state = *rows[0].PeriodState
	}
	body, err := json.Marshal(attendance.SheetView{EmployeeID: employee, Month: month, PeriodState: state, Totals: oracleTotals(t, month, rows[0])})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func (w *m1World) sheetBody(t *testing.T, month, employee string) string {
	t.Helper()
	status, body := w.send(http.MethodGet, "hr", m1Request{target: "/api/hr/employees/" + employee + "/attendance?month=" + month}, nil)
	if status != http.StatusOK {
		t.Fatalf("sheet of %s in %s: %d %s", employee, month, status, body)
	}
	return body
}

// hrm-attendance :35 (F-01, F-03..F-08) and :148 (D05, D-01), hrm-attendance-effects-equivalence :235 and the close
// of :333. Pending requests are written in SQL as fixtureRequest does, because the submit window of the DB clock
// excludes a fixed past month; every kind then reaches approved through the decision route (late and early on the
// lead's approval alone, a final stage by Root), beside a cancellation, a rejection and a pending request, a paid
// holiday and signed adjustments through their routes. The sheet route answers the totals of the correlated facts
// for every employee and month, byte for byte, and the same bytes again; the close stores the canonical snapshot,
// version and hash of those facts for every employee of the month.
func TestM6TheSheetOfRealRequestsIsTheOracleAndTheCloseStoresIt(t *testing.T) {
	w := newM5cWorld(t)
	_, a := m6Member(t, w)
	_, b := m6Member(t, w)
	approve := `{"expectedVersion":"1","decision":"approve"}`
	decide := func(request, actor, body, state string) {
		t.Helper()
		if outcome := w.call(t, http.MethodPost, actor, "/api/hr/requests/"+request+"/decision", body, true)(); outcome.status != http.StatusOK || !strings.Contains(outcome.body, `"state":"`+state+`"`) {
			t.Fatalf("decision on %s by %s: %+v, want %s", request, actor, outcome, state)
		}
	}
	final := func(employee, kind, day string) string {
		t.Helper()
		request := m6Request(t, w, employee, kind, day, "pending_final")
		decide(request, "hr", approve, "approved")
		return request
	}
	final(a, "annual-leave", "2026-02-27")
	annual := final(a, "annual-leave", "2026-03-02")
	final(a, "unpaid-leave", "2026-03-03")
	decide(m6Request(t, w, a, "late-arrival", "2026-03-04", "pending_lead"), "hr", approve, "approved")
	decide(m6Request(t, w, a, "early-departure", "2026-03-05", "pending_lead"), "hr", approve, "approved")
	final(a, "wfh", "2026-03-06")
	cancelled := final(a, "unpaid-leave", "2026-03-09")
	w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/requests/"+cancelled+"/cancel", `{"expectedVersion":"2","reason":"Cancel"}`, true)(), http.StatusOK)
	m6Request(t, w, a, "annual-leave", "2026-03-10", "pending_lead")
	decide(m6Request(t, w, a, "wfh", "2026-03-11", "pending_final"), "hr", `{"expectedVersion":"1","decision":"reject","reason":"No"}`, "rejected")
	w.expect(t, w.call(t, http.MethodPut, "hr", "/api/hr/work-calendar/days/2026-03-12", `{"expectedVersion":"`+m4Version(t, w)+`","holiday":"Sheet holiday"}`, false)(), http.StatusOK)
	before := w.live(t, "2026-03", a)
	final(a, "annual-leave", "2026-03-13")
	final(a, "unpaid-leave", "2026-03-13")
	overlap := w.live(t, "2026-03", a)
	decide(m6Request(t, w, a, "annual-leave", "2026-03-18", "pending_final"), "root", approve, "approved")
	for _, entry := range []string{`"2026-03-16","minutes":120`, `"2026-03-17","minutes":-60`, `"2026-04-03","minutes":30`} {
		w.expect(t, w.call(t, http.MethodPost, "hr", "/api/hr/employees/"+a+"/attendance-adjustments", `{"workDate":`+entry+`,"reason":"Sheet"}`, true)(), http.StatusCreated)
	}
	final(a, "annual-leave", "2026-04-14")
	edge := m6Request(t, w, b, "wfh", "2026-03-31", "pending_final")
	w.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes) VALUES($1,'wfh',DATE '2026-04-01',540,1080,540)`, edge)
	decide(edge, "hr", approve, "approved")

	// Two approved requests on the same working minutes are counted once.
	if annualAndUnpaid := overlap.AnnualLeaveMinutes + overlap.UnpaidMinutes - before.AnnualLeaveMinutes - before.UnpaidMinutes; annualAndUnpaid != 240 || overlap.PaidMinutes-before.PaidMinutes != before.UnpaidMinutes-overlap.UnpaidMinutes {
		t.Errorf("overlapping leave: %+v -> %+v", before, overlap)
	}
	march := w.live(t, "2026-03", a)
	if got := [5]int{march.LateCount, march.EarlyCount, march.WfhDays, march.PaidHolidayMinutes, march.AdjustmentMinutes}; got != [5]int{1, 1, 1, 480, 60} || march.UnpaidMinutes == 0 || march.AnnualLeaveMinutes == 0 {
		t.Errorf("March of every kind: %+v", march)
	}
	counters := func(employee string) string {
		return w.scalar(t, `SELECT coalesce(string_agg(to_char(month,'YYYY-MM')||'='||approved_count, ',' ORDER BY month), '') FROM wfh_month_counter WHERE employee_id=$1`, employee)
	}
	if debits := w.scalar(t, `SELECT count(*)::text FROM leave_ledger WHERE source_request_id=$1`, annual); debits != "1" || counters(a) != "2026-03=1" || counters(b) != "2026-03=1,2026-04=1" {
		t.Errorf("debits of the annual leave %s, WFH counters %q and %q", debits, counters(a), counters(b))
	}

	for _, employee := range []string{a, b} {
		for _, month := range []string{"2026-02", "2026-03", "2026-04"} {
			body := w.sheetBody(t, month, employee)
			if want := w.oracleSheet(t, month, employee); body != want || !strings.Contains(body, `"periodState":"open"`) {
				t.Errorf("sheet of %s in %s:\n got %s\nwant %s", employee, month, body, want)
			}
			if again := w.sheetBody(t, month, employee); again != body {
				t.Errorf("recomputed sheet of %s in %s: %s, then %s", employee, month, body, again)
			}
		}
	}

	month := "2026-03"
	facts := w.oracle(t, month, nil)
	employees := make([]attendancecore.SnapshotEmployee, len(facts))
	for i, row := range facts {
		employees[i] = attendancecore.SnapshotEmployee{EmployeeID: row.ID, Totals: oracleTotals(t, month, row)}
	}
	want := attendancecore.BuildSnapshot(month, m4Version(t, w), employees)
	canonical, err := attendancecore.CanonicalSnapshot(want)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := attendancecore.SnapshotHash(want)
	if err != nil {
		t.Fatal(err)
	}
	if closed := w.expect(t, w.closeMonth(t, month)(), http.StatusOK); closed != `{"month":"2026-03","state":"closed","version":"2"}` {
		t.Errorf("close: %s", closed)
	}
	stored := w.scalar(t, `SELECT snapshot::text FROM attendance_period WHERE month=DATE '2026-03-01'`)
	row := w.scalar(t, `SELECT p.version||':'||p.snapshot_hash||':'||e.snapshot_hash||':'||(p.snapshot = CAST($1 AS jsonb))
      FROM attendance_period p JOIN attendance_period_event e ON e.month=p.month AND e.version=p.version AND e.event='close'
     WHERE p.month=DATE '2026-03-01'`, string(canonical))
	if row != "2:"+hash+":"+hash+":true" {
		t.Errorf("stored version, hashes and snapshot %s, want hash %s", row, hash)
	}
	verified, err := attendancecore.VerifiedSnapshot(month, []byte(stored), hash)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := attendancecore.CanonicalSnapshot(verified); err != nil || string(again) != string(canonical) || len(verified.Employees) < 2 {
		t.Errorf("stored snapshot of %d employees differs from the oracle's %d: %v", len(verified.Employees), len(employees), err)
	}
	if body := w.sheetBody(t, month, a); body != w.oracleSheet(t, month, a) || !strings.Contains(body, `"periodState":"closed"`) {
		t.Errorf("sheet of the closed month: %s", body)
	}
}
