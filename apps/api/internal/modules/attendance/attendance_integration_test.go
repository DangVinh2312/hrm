//go:build integration

package attendance

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/modules/attendancecore"
	testdb "hrm/api/test"
	"hrm/api/test/fixture"
)

// attendanceFixture: H = HR/Admin, E = employee in the team of L, L = lead, O = employee outside the team,
// C = COO, N = signed in without any HR role, R = Root. Every profile is hired on 2026-01-05 (March 2026
// has 22 weekdays of 480 minutes). Past months are fixed; nothing depends on the run date except where a
// test reads the DB clock itself. Synthetic people only.
type attendanceFixture struct {
	s         *testdb.Stack
	conn      *pgx.Conn
	service   *Service
	fresh     map[string]string
	stale     map[string]string
	accounts  map[string]string
	employees map[string]string
	team      string
}

const march = "2026-03"
const marchBase = 22 * 480

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func newAttendanceFixture(t *testing.T) *attendanceFixture {
	t.Helper()
	f := &attendanceFixture{s: testdb.NewDatabase(t), fresh: map[string]string{}, stale: map[string]string{}, accounts: map[string]string{}, employees: map[string]string{}}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	f.accounts["R"] = fixture.Root(t, f.s).ID
	f.team = f.one(t, `INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Attendance' FROM gen_random_uuid() g RETURNING id::text`)
	for _, name := range []string{"H", "L", "E", "O", "C", "N"} {
		f.person(t, name, map[string][]string{"H": {"hr.employee", "hr.admin"}, "C": {"hr.employee", "hr.coo"}, "N": nil}, name != "N", name == "L" || name == "E")
	}
	f.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, f.team, f.employees["L"])
	f.sessions(t, "R")
	c, err := declarations.NewCore()
	mustDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	mustDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	mustDB(t, err)
	ops := NewOperations()
	a, err := authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), nil, ops.All()...)
	mustDB(t, err)
	f.service = ops.Bind(a)
	return f
}

// person makes an account with roles (hr.employee unless listed), hired on 2026-01-05 and linked when hired.
func (f *attendanceFixture) person(t *testing.T, name string, roles map[string][]string, hired, member bool) {
	t.Helper()
	own, ok := roles[name]
	if !ok {
		own = []string{"hr.employee"}
	}
	f.accounts[name] = fixture.Account(t, f.s, fixture.AccountSpec{Roles: own}).ID
	if hired {
		f.employees[name] = fixture.Employee(t, f.s, fixture.EmployeeSpec{Code: "A-" + name, AccountID: f.accounts[name], HiredOn: "2026-01-05"}).ID
	}
	if member {
		f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, f.employees[name])
	}
	f.sessions(t, name)
}

func (f *attendanceFixture) sessions(t *testing.T, name string) {
	t.Helper()
	f.fresh[name] = fixture.Session(t, f.s, f.accounts[name], fixture.SessionSpec{Fresh: true})
	f.stale[name] = fixture.Session(t, f.s, f.accounts[name], fixture.SessionSpec{})
}

// hire is an employee without an account, hired on hiredOn.
func (f *attendanceFixture) hire(t *testing.T, name, hiredOn string) string {
	t.Helper()
	f.employees[name] = fixture.Employee(t, f.s, fixture.EmployeeSpec{Code: "A-" + name, HiredOn: hiredOn}).ID
	return f.employees[name]
}

func (f *attendanceFixture) one(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	mustDB(t, f.conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *attendanceFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.conn.Exec(t.Context(), sql, args...)
	mustDB(t, err)
}

func (f *attendanceFixture) sheet(t *testing.T, actor, name string, month *string) (SheetView, bool) {
	t.Helper()
	view, found, err := f.service.Sheet(t.Context(), f.fresh[actor], SheetQuery{EmployeeID: f.employees[name], Month: month})
	mustDB(t, err)
	return view, found
}

func (f *attendanceFixture) paid(t *testing.T, name, month string) int {
	t.Helper()
	view, found := f.sheet(t, "H", name, &month)
	if !found {
		t.Fatalf("HR does not read the sheet of %s", name)
	}
	return view.PaidMinutes
}

func (f *attendanceFixture) closeMonth(t *testing.T, month string) PeriodResult {
	t.Helper()
	result, err := f.service.ClosePeriod(t.Context(), f.fresh["H"], month)
	mustDB(t, err)
	return result
}

func (f *attendanceFixture) reopen(t *testing.T, month, reason string) PeriodResult {
	t.Helper()
	result, err := f.service.ReopenPeriod(t.Context(), f.fresh["H"], ReopenInput{Month: month, Reason: reason})
	mustDB(t, err)
	return result
}

// adjustment writes an entry the way a committed adjustment leaves it, by the superuser.
func (f *attendanceFixture) adjustment(t *testing.T, name, day string, minutes int) {
	t.Helper()
	f.exec(t, `INSERT INTO attendance_adjustment(id,employee_id,work_date,minutes,reason,actor_account_id)
      VALUES(gen_random_uuid(),$1,CAST($2 AS date),$3,'Fixture',$4)`, f.employees[name], day, minutes, f.accounts["H"])
}

func (f *attendanceFixture) audits(t *testing.T, kind string) int {
	t.Helper()
	n, err := strconv.Atoi(f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')=$1`, kind))
	mustDB(t, err)
	return n
}

func rejectedWith(err error, code apperror.Code) bool {
	rejection, ok := errors.AsType[apperror.Rejection](err)
	return ok && rejection.Code == code
}

func sqlState(err error) string {
	if pg, ok := errors.AsType[*pgconn.PgError](err); ok {
		return pg.Code
	}
	return ""
}

// waitBlocked returns once n data-login backends wait on a lock. 3 s is a margin for a loaded machine to
// reach the lock, not a bound on when it could; a command that never takes the lock never shows here.
func (f *attendanceFixture) waitBlocked(t *testing.T, n int) {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if f.one(t, `SELECT (count(*) >= $1)::text FROM pg_stat_activity WHERE datname=current_database() AND usename='product_data' AND cardinality(pg_blocking_pids(pid))>0`, n) == "true" {
			return
		}
	}
	t.Fatalf("%d commands did not wait on a lock", n)
}

// holding runs during inside a superuser transaction that first ran lock, and commits it.
func (f *attendanceFixture) holding(t *testing.T, lock string, args []any, during func(tx pgx.Tx)) {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), lock, args...)
	mustDB(t, err)
	during(tx)
	mustDB(t, tx.Commit(t.Context()))
}

func TestTheSheetIsTheLiveMonthOfOneEmployee(t *testing.T) {
	f := newAttendanceFixture(t)
	month := march
	full, found := f.sheet(t, "E", "E", &month)
	want := SheetView{EmployeeID: f.employees["E"], Month: march, PeriodState: attendancecore.PeriodOpen,
		Totals: attendancecore.Totals{ScheduledMinutes: marchBase, PaidMinutes: marchBase}}
	if !found || full != want {
		t.Fatalf("own sheet %v %+v", found, full)
	}
	f.adjustment(t, "E", "2026-03-10", 120)
	f.adjustment(t, "O", "2026-03-10", -480)
	f.hire(t, "S2", "2026-03-16")
	if got, _ := f.sheet(t, "H", "E", &month); got.PaidMinutes != marchBase+120 || got.AdjustmentMinutes != 120 || got.ScheduledMinutes != marchBase {
		t.Errorf("HR reads %+v", got)
	}
	if got := f.paid(t, "O", march); got != marchBase-480 {
		t.Errorf("another employee's sheet %d", got)
	}
	if got := f.paid(t, "S2", march); got != 12*480 {
		t.Errorf("nothing before the hire date: %d", got)
	}
	if got := f.paid(t, "S2", "2026-02"); got != 0 {
		t.Errorf("a month before the hire: %d", got)
	}
	if _, found := f.sheet(t, "R", "E", &month); !found {
		t.Error("Root reads the sheet")
	}
	for _, actor := range []string{"L", "C", "O", "N"} {
		if view, found := f.sheet(t, actor, "E", &month); found {
			t.Errorf("%s reads %+v", actor, view)
		}
	}
	if _, found := f.sheet(t, "L", "L", &month); !found {
		t.Error("a lead reads their own sheet")
	}
	view, found, err := f.service.Sheet(t.Context(), f.fresh["H"], SheetQuery{EmployeeID: "00000000-0000-4000-8000-000000000000", Month: &month})
	if err != nil || found {
		t.Errorf("absent employee %v %+v %v", found, view, err)
	}
	today := f.one(t, `SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'YYYY-MM')`)
	if current, found := f.sheet(t, "E", "E", nil); !found || current.Month != today {
		t.Errorf("default month %q, want %q", current.Month, today)
	}
	f.closeMonth(t, march)
	if closed, _ := f.sheet(t, "E", "E", &month); closed.PeriodState != attendancecore.PeriodClosed || closed.PaidMinutes != marchBase+120 {
		t.Errorf("closed month sheet %+v", closed)
	}
}

type storedPeriod struct {
	State, Version string
	Hash, Snapshot *string
}

func (f *attendanceFixture) stored(t *testing.T, month string) storedPeriod {
	t.Helper()
	var p storedPeriod
	mustDB(t, f.conn.QueryRow(t.Context(), `SELECT state, version::text, snapshot_hash, snapshot::text FROM attendance_period WHERE month = CAST($1 || '-01' AS date)`, month).Scan(&p.State, &p.Version, &p.Hash, &p.Snapshot))
	return p
}

// verified reads the stored snapshot back through the report's reader: its hash covers the canonical form.
func (f *attendanceFixture) verified(t *testing.T, month string) (attendancecore.Snapshot, storedPeriod) {
	t.Helper()
	p := f.stored(t, month)
	if p.Hash == nil || p.Snapshot == nil {
		t.Fatalf("%s has no snapshot: %+v", month, p)
	}
	snapshot, err := attendancecore.VerifiedSnapshot(month, []byte(*p.Snapshot), *p.Hash)
	if err != nil {
		t.Fatalf("stored snapshot of %s: %v", month, err)
	}
	return snapshot, p
}

func entryOf(snapshot attendancecore.Snapshot, employeeID string) *attendancecore.SnapshotEmployee {
	for i := range snapshot.Employees {
		if snapshot.Employees[i].EmployeeID == employeeID {
			return &snapshot.Employees[i]
		}
	}
	return nil
}

const periodWrites = `SELECT concat_ws('|',
 (SELECT string_agg(to_char(month,'YYYY-MM')||':'||state||':'||version, ',' ORDER BY month) FROM attendance_period),
 (SELECT count(*) FROM attendance_period_event),
 (SELECT count(*) FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'hr.attendance-period.%'))`

func TestTheCloseStoresTheCanonicalSnapshotAndTheReopenKeepsTheHistory(t *testing.T) {
	f := newAttendanceFixture(t)
	f.hire(t, "GONE", "2025-06-02")
	f.exec(t, `UPDATE employee SET terminated_on = DATE '2026-02-27' WHERE id = $1`, f.employees["GONE"])
	f.adjustment(t, "E", "2026-03-10", 90)
	before := f.one(t, periodWrites)
	if _, err := f.service.ClosePeriod(t.Context(), f.stale["H"], march); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("stale HR closes: %v", err)
	}
	for _, actor := range []string{"E", "L", "C", "N"} {
		if _, err := f.service.ClosePeriod(t.Context(), f.fresh[actor], march); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s closes: %v", actor, err)
		}
		if _, err := f.service.ReopenPeriod(t.Context(), f.fresh[actor], ReopenInput{Month: march, Reason: "x"}); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s reopens: %v", actor, err)
		}
	}
	if after := f.one(t, periodWrites); after != before {
		t.Fatalf("refusals wrote %s -> %s", before, after)
	}
	if closed := f.closeMonth(t, march); closed != (PeriodResult{Month: march, State: attendancecore.PeriodClosed, Version: "2"}) {
		t.Fatalf("close %+v", closed)
	}
	if f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='hr.attendance-period.close'
      AND safe_metadata->>'resource'='hrCompany' AND safe_metadata->>'key'=$1 AND object_id IS NOT NULL AND reason IS NULL`, "00000000-0000-4000-8000-000000000c01") != "1" {
		t.Error("the close is audited once on the company")
	}
	first, row := f.verified(t, march)
	if first.FormatVersion != 2 || first.Month != march || first.CalendarVersion != f.one(t, `SELECT version::text FROM work_calendar`) {
		t.Errorf("snapshot head %+v", first)
	}
	var ids []string
	for _, e := range first.Employees {
		ids = append(ids, e.EmployeeID)
	}
	want := []string{f.employees["H"], f.employees["L"], f.employees["E"], f.employees["O"], f.employees["C"]}
	slices.Sort(want)
	if !slices.Equal(ids, want) {
		t.Errorf("employees of the month %v, want %v (id order, without the one gone in February)", ids, want)
	}
	month := march
	live, _ := f.sheet(t, "H", "E", &month)
	if entry := entryOf(first, f.employees["E"]); entry == nil || entry.Totals != live.Totals || entry.AdjustmentMinutes != 90 {
		t.Errorf("snapshot of E %+v, live %+v", entry, live)
	}
	canonical, err := attendancecore.CanonicalSnapshot(first)
	mustDB(t, err)
	if f.one(t, `SELECT (snapshot = CAST($2 AS jsonb))::text FROM attendance_period WHERE month = CAST($1 || '-01' AS date)`, march, string(canonical)) != "true" {
		t.Error("the stored jsonb is not the canonical document")
	}
	if _, err := f.service.ClosePeriod(t.Context(), f.fresh["H"], march); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("second close: %v", err)
	}
	if _, err := f.service.ReopenPeriod(t.Context(), f.stale["H"], ReopenInput{Month: march, Reason: "x"}); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("stale HR reopens: %v", err)
	}
	if reopened := f.reopen(t, march, "S"+string(rune(0x1eed))+"a l"+string(rune(0x1ecb))+"ch"); reopened != (PeriodResult{Month: march, State: attendancecore.PeriodOpen, Version: "3"}) {
		t.Fatalf("reopen %+v", reopened)
	}
	if p := f.stored(t, march); p.State != "open" || p.Version != "3" || p.Hash != nil || p.Snapshot != nil {
		t.Errorf("reopened row %+v", p)
	}
	if _, err := f.service.ReopenPeriod(t.Context(), f.fresh["H"], ReopenInput{Month: march, Reason: "again"}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("second reopen: %v", err)
	}
	if again := f.closeMonth(t, march); again.Version != "4" {
		t.Errorf("close again %+v", again)
	}
	second, secondRow := f.verified(t, march)
	if *secondRow.Hash != *row.Hash || *secondRow.Snapshot != *row.Snapshot {
		t.Error("unchanged inputs hash and store the same after a reopen")
	}
	f.reopen(t, march, "Th"+string(rune(0xea))+"m")
	f.adjustment(t, "E", "2026-03-11", -30)
	f.closeMonth(t, march)
	third, thirdRow := f.verified(t, march)
	if *thirdRow.Hash == *row.Hash || entryOf(third, f.employees["E"]).AdjustmentMinutes != 60 || len(second.Employees) != len(third.Employees) {
		t.Errorf("a new adjustment is in the next close: %+v", entryOf(third, f.employees["E"]))
	}
	rows, err := f.conn.Query(t.Context(), `SELECT version::text||':'||event||':'||coalesce(reason,'-')||':'||actor_account_id::text||':'||coalesce(snapshot_hash,'-')
      FROM attendance_period_event WHERE month = DATE '2026-03-01' ORDER BY version`)
	mustDB(t, err)
	events, err := pgx.CollectRows(rows, pgx.RowTo[string])
	mustDB(t, err)
	h := f.accounts["H"]
	wantEvents := []string{"2:close:-:" + h + ":" + *row.Hash, "3:reopen:S" + string(rune(0x1eed)) + "a l" + string(rune(0x1ecb)) + "ch:" + h + ":-",
		"4:close:-:" + h + ":" + *row.Hash, "5:reopen:Th" + string(rune(0xea)) + "m:" + h + ":-", "6:close:-:" + h + ":" + *thirdRow.Hash}
	if !slices.Equal(events, wantEvents) {
		t.Errorf("history %v", events)
	}
	if f.audits(t, "hr.attendance-period.close") != 3 || f.audits(t, "hr.attendance-period.reopen") != 2 {
		t.Error("each transition is audited once")
	}
	if f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'hr.attendance-period.%'
      AND (reason IS NOT NULL OR strpos(safe_metadata::text, $1) > 0)`, "Th"+string(rune(0xea))+"m") != "0" {
		t.Error("the reason is not audited")
	}
}

func TestAFutureMonthIsNotClosedAndAnEmptyPastMonthIs(t *testing.T) {
	f := newAttendanceFixture(t)
	future := f.one(t, `SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 70,'YYYY-MM')`)
	current := f.one(t, `SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'YYYY-MM')`)
	before := f.one(t, periodWrites)
	if _, err := f.service.ClosePeriod(t.Context(), f.fresh["H"], future); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("future month: %v", err)
	}
	if after := f.one(t, periodWrites); after != before {
		t.Errorf("a refused close wrote %s -> %s", before, after)
	}
	if closed := f.closeMonth(t, current); closed.State != attendancecore.PeriodClosed {
		t.Errorf("the current month closes: %+v", closed)
	}
	f.closeMonth(t, "2020-01")
	if empty, _ := f.verified(t, "2020-01"); len(empty.Employees) != 0 || f.one(t, `SELECT jsonb_typeof(snapshot->'employees')||':'||jsonb_array_length(snapshot->'employees') FROM attendance_period WHERE month = DATE '2020-01-01'`) != "array:0" {
		t.Errorf("empty month %+v", empty)
	}
	if reopened := f.reopen(t, "2020-01", "Th"+string(rune(0x1eed))); reopened.State != attendancecore.PeriodOpen {
		t.Errorf("reopen %+v", reopened)
	}
}

func TestAnAuditFailureRollsBackTheCloseAndTheReopen(t *testing.T) {
	f := newAttendanceFixture(t)
	before := f.one(t, periodWrites)
	f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
	_, err := f.service.ClosePeriod(t.Context(), f.fresh["H"], march)
	f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
	if sqlState(err) != "42501" {
		t.Fatalf("close without audit: %v", err)
	}
	if after := f.one(t, periodWrites); after != before {
		t.Errorf("a failed close kept %s -> %s", before, after)
	}
	f.closeMonth(t, march)
	closed := f.one(t, periodWrites)
	f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
	_, err = f.service.ReopenPeriod(t.Context(), f.fresh["H"], ReopenInput{Month: march, Reason: "x"})
	f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
	if sqlState(err) != "42501" {
		t.Fatalf("reopen without audit: %v", err)
	}
	if after := f.one(t, periodWrites); after != closed {
		t.Errorf("a failed reopen kept %s -> %s", closed, after)
	}
	if p := f.stored(t, march); p.State != "closed" || p.Snapshot == nil {
		t.Errorf("the snapshot is gone after a failed reopen: %+v", p)
	}
}

// A writer holding the month FOR SHARE (a submit, an approval, an adjustment) is waited for: the close reads
// the state and the facts once that writer committed.
func TestTheCloseReadsTheStateAndTheFactsUnderThePeriodLock(t *testing.T) {
	f := newAttendanceFixture(t)
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (DATE '2026-03-01')`)
	done := make(chan error, 1)
	f.holding(t, `SELECT 1 FROM attendance_period WHERE month = DATE '2026-03-01' FOR SHARE`, nil, func(tx pgx.Tx) {
		go func() {
			_, err := f.service.ClosePeriod(context.Background(), f.fresh["H"], march)
			done <- err
		}()
		f.waitBlocked(t, 1)
		_, err := tx.Exec(t.Context(), `INSERT INTO attendance_adjustment(id,employee_id,work_date,minutes,reason,actor_account_id)
          VALUES(gen_random_uuid(),$1,DATE '2026-03-10',45,'Writer',$2)`, f.employees["E"], f.accounts["H"])
		mustDB(t, err)
	})
	mustDB(t, <-done)
	snapshot, _ := f.verified(t, march)
	if entry := entryOf(snapshot, f.employees["E"]); entry == nil || entry.AdjustmentMinutes != 45 {
		t.Errorf("the writer's entry is not in the snapshot: %+v", entry)
	}
	f.reopen(t, march, "x")
	f.holding(t, `SELECT 1 FROM attendance_period WHERE month = DATE '2026-03-01' FOR SHARE`, nil, func(tx pgx.Tx) {
		go func() {
			_, err := f.service.ClosePeriod(context.Background(), f.fresh["H"], march)
			done <- err
		}()
		f.waitBlocked(t, 1)
		_, err := tx.Exec(t.Context(), `UPDATE attendance_period SET state='closed',version=version+1,snapshot='{}'::jsonb,snapshot_hash=repeat('b',64) WHERE month = DATE '2026-03-01'`)
		mustDB(t, err)
	})
	if err := <-done; !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("a close behind another close: %v", err)
	}
	if p := f.stored(t, march); p.Hash == nil || *p.Hash != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" || p.Version != "4" {
		t.Errorf("the close overwrote the committed close: %+v", p)
	}
}

// The close holds the company before the month and never takes the calendar, which a submit takes after
// the month.
func TestTheCloseLocksTheCompanyThenThePeriodAndNotTheCalendar(t *testing.T) {
	f := newAttendanceFixture(t)
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (DATE '2026-03-01')`)
	for _, run := range []func() error{
		func() error { _, err := f.service.ClosePeriod(context.Background(), f.fresh["H"], march); return err },
		func() error {
			_, err := f.service.ReopenPeriod(context.Background(), f.fresh["H"], ReopenInput{Month: march, Reason: "x"})
			return err
		},
	} {
		done := make(chan error, 1)
		f.holding(t, `SELECT 1 FROM attendance_period WHERE month = DATE '2026-03-01' FOR UPDATE`, nil, func(tx pgx.Tx) {
			go func() { done <- run() }()
			f.waitBlocked(t, 1)
			_, err := tx.Exec(t.Context(), `SET LOCAL lock_timeout = '50ms'`)
			mustDB(t, err)
			_, err = tx.Exec(t.Context(), `SAVEPOINT probe`)
			mustDB(t, err)
			_, err = tx.Exec(t.Context(), `SELECT 1 FROM hr_company FOR UPDATE`)
			if sqlState(err) != "55P03" {
				t.Errorf("the company was free while the command waited on the period: %v", err)
			}
			_, err = tx.Exec(t.Context(), `ROLLBACK TO SAVEPOINT probe`)
			mustDB(t, err)
		})
		mustDB(t, <-done)
	}
	f.holding(t, `SELECT 1 FROM work_calendar FOR UPDATE`, nil, func(pgx.Tx) {
		if _, err := f.service.ClosePeriod(t.Context(), f.fresh["H"], march); err != nil {
			t.Errorf("the close waited on the calendar: %v", err)
		}
	})
}
