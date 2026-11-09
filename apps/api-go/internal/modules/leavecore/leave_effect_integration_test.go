//go:build integration

package leavecore_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/leavecore"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

type ledger struct {
	t           *testing.T
	s           *testdb.Stack
	conn        *pgx.Conn
	team, owner string
}

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func newLedger(t *testing.T) *ledger {
	t.Helper()
	s := testdb.NewDatabase(t)
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, conn.Close(context.WithoutCancel(t.Context()))) })
	l := &ledger{t: t, s: s, conn: conn, owner: fixture.Account(t, s, fixture.AccountSpec{}).ID}
	l.team = l.text("INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Leave' FROM gen_random_uuid() g RETURNING id::text")
	return l
}

func (l *ledger) text(sql string, args ...any) string {
	l.t.Helper()
	var value string
	mustDB(l.t, l.conn.QueryRow(l.t.Context(), sql, args...).Scan(&value))
	return value
}

func (l *ledger) exec(sql string, args ...any) {
	l.t.Helper()
	_, err := l.conn.Exec(l.t.Context(), sql, args...)
	mustDB(l.t, err)
}

// employee is hired on 2026-01-05 in status from that day at 5760 minutes a year (480 a counted month).
func (l *ledger) employee(status string) string {
	l.t.Helper()
	id := fixture.Employee(l.t, l.s, fixture.EmployeeSpec{HiredOn: "2026-01-05"}).ID
	l.exec("INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,$2,'2026-01-05')", id, status)
	l.exec(`INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
      SELECT g,public.hr_register_object('leaveRate',g),$1,'2026-01-05',5760 FROM gen_random_uuid() g`, id)
	return id
}

func (l *ledger) request(employee, state string, segments ...leavecore.DatedMinutes) string {
	l.t.Helper()
	id := l.text(`INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'annual-leave',$4,'Fixture' FROM gen_random_uuid() g
      RETURNING id::text`, employee, l.owner, l.team, state)
	for _, s := range segments {
		l.exec(`INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
        VALUES($1,'annual-leave',CAST($2 AS date),540,1080,$3)`, id, s.Date, s.Minutes)
	}
	return id
}

func (l *ledger) entries(employee, kind string) int {
	l.t.Helper()
	var n int
	mustDB(l.t, l.conn.QueryRow(l.t.Context(), "SELECT count(*)::int FROM leave_ledger WHERE employee_id=$1 AND entry_kind=$2", employee, kind).Scan(&n))
	return n
}

func (l *ledger) bucket(employee string) string {
	l.t.Helper()
	return l.text("SELECT COALESCE(max(revision)::text,'none') FROM leave_bucket WHERE employee_id=$1 AND year=2026", employee)
}

func (l *ledger) write(work func(tx *database.Tx) error) error {
	_, err := database.Run(l.t.Context(), l.s.Runner, database.ModeWrite, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		return struct{}{}, work(tx)
	}, database.RunOptions{})
	return err
}

func day(date string, minutes int) leavecore.DatedMinutes {
	return leavecore.DatedMinutes{Date: date, Minutes: minutes}
}

func TestAssertAvailableCountsApprovedPendingAndTheNewSegments(t *testing.T) {
	l := newLedger(t)
	e := l.employee("official")
	available := func(segments ...leavecore.DatedMinutes) error {
		return l.write(func(tx *database.Tx) error { return leavecore.AssertAvailable(tx, e, segments) })
	}
	// 480 accrued per counted month: 1440 to the end of March.
	mustDB(t, available(day("2026-03-02", 480), day("2026-03-03", 480), day("2026-03-04", 480)))
	insufficient := func(err error) bool {
		rejection, ok := errors.AsType[apperror.Rejection](err)
		return ok && rejection.Code == "error.insufficientLeave"
	}
	err := available(day("2026-03-02", 480), day("2026-03-03", 480), day("2026-03-04", 480), day("2026-03-05", 120))
	if !insufficient(err) {
		t.Fatalf("one slot more: %v", err)
	}
	if status, _, _ := apperror.Response(err); status != 422 {
		t.Fatalf("insufficient leave answers %d", status)
	}
	if err := available(day("2026-02-02", 480), day("2026-02-03", 480), day("2026-02-04", 480)); !insufficient(err) {
		t.Fatalf("February has only 960 accrued: %v", err)
	}
	l.request(e, "pending_final", day("2026-01-20", 120))
	if err := available(day("2026-03-02", 480), day("2026-03-03", 480), day("2026-03-04", 480)); !insufficient(err) {
		t.Fatalf("a pending request does not count: %v", err)
	}
	mustDB(t, available(day("2026-03-02", 480), day("2026-03-03", 480), day("2026-03-04", 360)))
	if err := available(); !errors.Is(err, leavecore.ErrNoSegment) {
		t.Fatalf("no segment: %v", err)
	}
}

func TestApplyAndReverseApprovedLeaveWriteTheLedgerOnce(t *testing.T) {
	l := newLedger(t)
	e := l.employee("official")
	apply := func(request string) error {
		return l.write(func(tx *database.Tx) error { return leavecore.ApplyApproved(tx, request) })
	}
	reverse := func(request string) error {
		return l.write(func(tx *database.Tx) error { return leavecore.ReverseApproved(tx, request) })
	}
	approved := l.request(e, "pending_final", day("2026-03-02", 480), day("2026-03-03", 240))
	mustDB(t, apply(approved))
	if l.entries(e, "debit") != 2 || l.bucket(e) != "2" {
		t.Fatalf("debits %d bucket %s", l.entries(e, "debit"), l.bucket(e))
	}
	if err := apply(approved); !database.IsUniqueViolation(err) {
		t.Fatalf("a replay must fail on UNIQUE: %v", err)
	}
	if l.entries(e, "debit") != 2 || l.bucket(e) != "2" {
		t.Fatal("a refused replay wrote")
	}

	// 960 accrued to the end of February: approved leave plus this request goes over.
	over := l.request(e, "pending_final", day("2026-02-02", 480), day("2026-02-03", 480), day("2026-02-04", 120))
	if err := apply(over); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("over the entitlement: %v", err)
	}
	if l.entries(e, "debit") != 2 || l.bucket(e) != "2" {
		t.Fatal("a refused debit wrote")
	}
	// Another pending request is not counted at approval: the first debit wins.
	l.request(e, "pending_lead", day("2026-01-26", 480))
	mustDB(t, apply(l.request(e, "pending_final", day("2026-01-27", 480))))

	// Official until 2026-03-01 (exclusive): 960 accrued covers the minutes, the day itself is refused.
	ended := l.employee("official")
	l.exec("UPDATE employment_status_period SET ends_on = '2026-03-01' WHERE employee_id = $1", ended)
	if err := apply(l.request(ended, "pending_final", day("2026-03-02", 120))); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("a day after the official period: %v", err)
	}
	if l.entries(ended, "debit") != 0 || l.bucket(ended) != "none" {
		t.Fatal("a refused debit of a day not official wrote")
	}
	mustDB(t, apply(l.request(ended, "pending_final", day("2026-02-27", 120))))
	probation := l.employee("probation")
	if err := apply(l.request(probation, "pending_final", day("2026-03-02", 120))); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("a probation day: %v", err)
	}
	if l.entries(probation, "debit") != 0 || l.bucket(probation) != "none" {
		t.Fatal("a refused probation debit wrote")
	}

	mustDB(t, reverse(approved))
	if l.entries(e, "reversal") != 2 || l.bucket(e) != "4" {
		t.Fatalf("reversals %d bucket %s", l.entries(e, "reversal"), l.bucket(e))
	}
	if err := reverse(approved); !database.IsUniqueViolation(err) {
		t.Fatalf("a second reversal must fail on UNIQUE: %v", err)
	}
	if err := reverse(over); !errors.Is(err, leavecore.ErrDebitsMismatch) {
		t.Fatalf("a request without debits: %v", err)
	}
	if err := apply("10000000-0000-4000-8000-0000000000cc"); !errors.Is(err, leavecore.ErrNotAnnualLeave) {
		t.Fatalf("missing request: %v", err)
	}
}

func TestLoadFactsSplitsTheLedgerKindsOfTheYear(t *testing.T) {
	l := newLedger(t)
	e := l.employee("official")
	cancelled := l.request(e, "cancelled", day("2026-03-02", 480), day("2026-03-03", 240))
	mustDB(t, l.write(func(tx *database.Tx) error { return leavecore.ApplyApproved(tx, cancelled) }))
	mustDB(t, l.write(func(tx *database.Tx) error { return leavecore.ReverseApproved(tx, cancelled) }))
	kept := l.request(e, "approved", day("2026-02-02", 120))
	mustDB(t, l.write(func(tx *database.Tx) error { return leavecore.ApplyApproved(tx, kept) }))
	pending := l.request(e, "pending_lead", day("2026-04-06", 240))
	l.request(e, "rejected", day("2026-04-07", 480))
	for _, entry := range []struct {
		kind, date string
		minutes    int
	}{{"opening", "2026-01-05", 600}, {"adjustment", "2026-05-11", -120}, {"opening", "2025-12-31", 900}} {
		l.exec(`INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,reference)
        VALUES(gen_random_uuid(),$1,$2,CAST($3 AS date),$4,'import:fixture')`, e, entry.kind, entry.date, entry.minutes)
	}
	facts, err := database.Run(t.Context(), l.s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (map[string]leavecore.EmployeeFacts, error) {
		return leavecore.LoadFacts(tx, []string{e, "10000000-0000-4000-8000-0000000000dd"}, 2026)
	}, database.RunOptions{})
	mustDB(t, err)
	got, ok := facts[e]
	if !ok || len(facts) != 1 {
		t.Fatalf("facts of %d employees", len(facts))
	}
	want := leavecore.EmployeeFacts{
		Accrual: leavecore.AccrualFacts{Year: 2026, HiredOn: "2026-01-05",
			Periods: []leavecore.StatusPeriod{{Status: leavecore.StatusOfficial, StartsOn: "2026-01-05"}},
			Rates:   []leavecore.RatePeriod{{EffectiveFrom: "2026-01-05", AnnualMinutes: 5760}}},
		Adjustments: []leavecore.DatedMinutes{day("2026-01-05", 600), day("2026-05-11", -120)},
		Approved:    []leavecore.DatedMinutes{day("2026-02-02", 120), day("2026-03-02", 480), day("2026-03-03", 240), day("2026-03-02", -480), day("2026-03-03", -240)},
		Pending:     []leavecore.PendingMinutes{{RequestID: pending, Date: "2026-04-06", Minutes: 240}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("facts\n got %+v\nwant %+v", got, want)
	}
	entitled, err := leavecore.Entitlement(got)
	if err != nil || entitled[0] != 1080 || entitled[4] != 2880 {
		t.Fatalf("entitlement %v %v", entitled, err)
	}
	tooMany := make([]string, leavecore.MaxFactsEmployees+1)
	for i := range tooMany {
		tooMany[i] = e
	}
	if _, err := database.Run(t.Context(), l.s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (map[string]leavecore.EmployeeFacts, error) {
		return leavecore.LoadFacts(tx, tooMany, 2026)
	}, database.RunOptions{}); !errors.Is(err, leavecore.ErrTooManyEmployees) {
		t.Fatalf("too many employees: %v", err)
	}
}
