//go:build integration

package attendance

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
)

const newKey = `SELECT gen_random_uuid()::text`

// adjustWrites is everything an adjustment may write; a refused one leaves it unchanged.
const adjustWrites = `SELECT concat_ws('|',
 (SELECT count(*) FROM attendance_adjustment),
 (SELECT count(*) FROM attendance_period),
 (SELECT count(*) FROM hr_idempotency WHERE operation='attendance.adjust'),
 (SELECT count(*) FROM audit_outbox))`

type adjustOutcome struct {
	result AdjustmentResult
	err    error
}

type adjustSpec struct {
	key, workDate, reason string
	minutes               int
	reference             *string
}

func (f *attendanceFixture) input(t *testing.T, name string, spec adjustSpec) AdjustmentInput {
	t.Helper()
	if spec.key == "" {
		spec.key = f.one(t, newKey)
	}
	if spec.workDate == "" {
		spec.workDate = "2026-03-10"
	}
	if spec.minutes == 0 {
		spec.minutes = 120
	}
	if spec.reason == "" {
		spec.reason = "Qu" + string(rune(0xea)) + "n ch" + string(rune(0x1ea5)) + "m c" + string(rune(0xf4)) + "ng"
	}
	return AdjustmentInput{EmployeeID: f.employees[name], IdempotencyKey: spec.key, WorkDate: spec.workDate, Minutes: spec.minutes, Reason: spec.reason, Reference: spec.reference}
}

func (f *attendanceFixture) adjust(t *testing.T, actor, name string, spec adjustSpec) adjustOutcome {
	t.Helper()
	result, err := f.service.Adjust(t.Context(), f.fresh[actor], f.input(t, name, spec))
	return adjustOutcome{result, err}
}

type entry struct{ ID, Date, Minutes, Reason, Reference, Actor string }

func (f *attendanceFixture) entries(t *testing.T, name string) []entry {
	t.Helper()
	rows, err := f.conn.Query(t.Context(), `SELECT id::text, to_char(work_date,'YYYY-MM-DD'), minutes::text, reason, coalesce(reference,'<null>'), actor_account_id::text
      FROM attendance_adjustment WHERE employee_id=$1 ORDER BY created_at, id`, f.employees[name])
	mustDB(t, err)
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[entry])
	mustDB(t, err)
	return found
}

func ref(value string) *string { return &value }

func TestHRAdjustsInOneAuditedEntryThatMovesTheSheet(t *testing.T) {
	f := newAttendanceFixture(t)
	reference := "Q" + string(rune(0x0110)) + "-2026/03 #7"
	reason := "Qu" + string(rune(0xea)) + "n ch" + string(rune(0x1ea5)) + "m c" + string(rune(0xf4)) + "ng bu" + string(rune(0x1ed5)) + "i chi" + string(rune(0x1ec1)) + "u"
	first := f.adjust(t, "H", "E", adjustSpec{minutes: 120, reason: reason, reference: &reference})
	mustDB(t, first.err)
	if got := f.entries(t, "E"); len(got) != 1 || got[0] != (entry{first.result.ID, "2026-03-10", "120", reason, reference, f.accounts["H"]}) {
		t.Fatalf("entries %+v", got)
	}
	month := march
	sheet, _ := f.sheet(t, "E", "E", &month)
	if sheet.PaidMinutes != marchBase+120 || sheet.AdjustmentMinutes != 120 || sheet.ScheduledMinutes != marchBase {
		t.Errorf("own sheet %+v", sheet)
	}
	if got := f.paid(t, "E", "2026-04"); got != 22*480 {
		t.Errorf("April moved: %d", got)
	}
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{minutes: -60, workDate: "2026-03-11"}).err)
	if got := f.paid(t, "E", march); got != marchBase+60 || len(f.entries(t, "E")) != 2 {
		t.Errorf("after the negative entry %d", got)
	}
	if f.audits(t, "hr.attendance.adjust") != 2 || f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='hr.attendance.adjust'
      AND safe_metadata->>'resource'='employee' AND safe_metadata->>'key'=$1 AND reason IS NULL
      AND strpos(safe_metadata::text, 'Q') = 0 AND strpos(safe_metadata::text, '2026-03') = 0`, f.employees["E"]) != "2" {
		t.Error("each entry is audited on the employee, without its day, reason or reference")
	}
	mustDB(t, f.adjust(t, "R", "E", adjustSpec{minutes: 5}).err)
	if f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND convert_from(event_kind,'UTF8')='hr.attendance.adjust'`, f.accounts["R"]) != "1" {
		t.Error("Root adjustment not audited")
	}
}

func TestOnlyFreshHRAdjustsAndEveryoneElseWritesNothing(t *testing.T) {
	f := newAttendanceFixture(t)
	before := f.one(t, adjustWrites)
	if _, err := f.service.Adjust(t.Context(), f.stale["H"], f.input(t, "E", adjustSpec{})); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("stale HR: %v", err)
	}
	for _, actor := range []string{"E", "L", "C", "O", "N"} {
		if got := f.adjust(t, actor, "E", adjustSpec{}); !errors.Is(got.err, apperror.ErrNotFound) {
			t.Errorf("%s: %+v", actor, got)
		}
	}
	input := f.input(t, "E", adjustSpec{})
	input.EmployeeID = "00000000-0000-4000-8000-000000000000"
	if _, err := f.service.Adjust(t.Context(), f.fresh["H"], input); !errors.Is(err, apperror.ErrNotFound) {
		t.Errorf("absent employee: %v", err)
	}
	if after := f.one(t, adjustWrites); after != before {
		t.Errorf("refusals wrote %s -> %s", before, after)
	}
}

func TestHRNeverAdjustsTheirOwnAttendanceAndTheKeyStaysFree(t *testing.T) {
	f := newAttendanceFixture(t)
	before := f.one(t, adjustWrites)
	key := f.one(t, newKey)
	if got := f.adjust(t, "H", "H", adjustSpec{key: key}); !errors.Is(got.err, apperror.ErrAccessDenied) {
		t.Fatalf("own attendance: %+v", got)
	}
	if after := f.one(t, adjustWrites); after != before {
		t.Errorf("the refusal wrote %s -> %s", before, after)
	}
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{key: key}).err)
	f.person(t, "H2", map[string][]string{"H2": {"hr.employee", "hr.admin"}}, true, false)
	mustDB(t, f.adjust(t, "H2", "H", adjustSpec{minutes: 30}).err)
	f.person(t, "U", map[string][]string{"U": {"hr.employee", "hr.admin"}}, false, false)
	mustDB(t, f.adjust(t, "U", "E", adjustSpec{minutes: 15}).err)
	mustDB(t, f.adjust(t, "R", "H", adjustSpec{minutes: 5}).err)
	if len(f.entries(t, "H")) != 2 || len(f.entries(t, "E")) != 2 {
		t.Error("others adjust H and H adjusts others")
	}
}

func TestARetryReplaysAndAnotherPayloadReusesTheKey(t *testing.T) {
	f := newAttendanceFixture(t)
	key := f.one(t, newKey)
	first := f.adjust(t, "H", "E", adjustSpec{key: key})
	mustDB(t, first.err)
	state := f.one(t, adjustWrites)
	if again := f.adjust(t, "H", "E", adjustSpec{key: key}); again.err != nil || again.result != first.result {
		t.Fatalf("replay %+v, first %+v", again, first)
	}
	for name, other := range map[string]adjustSpec{
		"minutes":         {key: key, minutes: 121},
		"date":            {key: key, workDate: "2026-03-11"},
		"reason":          {key: key, reason: "L" + string(rune(0xfd)) + " do kh" + string(rune(0xe1)) + "c"},
		"reference":       {key: key, reference: ref("R-2")},
		"reference null":  {key: key, reference: ref("null")},
		"another subject": {key: key},
	} {
		subject := "E"
		if name == "another subject" {
			subject = "O"
		}
		got := f.adjust(t, "H", subject, other)
		if !rejectedWith(got.err, "error.idempotencyKeyReused") {
			t.Errorf("%s: %+v", name, got)
		}
		if status, _, _ := apperror.Response(got.err); status != 422 {
			t.Errorf("%s answers %d", name, status)
		}
	}
	if after := f.one(t, adjustWrites); after != state {
		t.Errorf("replay or reuse wrote %s -> %s", state, after)
	}
	mustDB(t, f.adjust(t, "R", "E", adjustSpec{key: key}).err)
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{}).err)
	if len(f.entries(t, "E")) != 3 {
		t.Error("another actor's key and a new key are new adjustments")
	}
}

// rootReplayAudits counts Root's access rows of the adjustment that name the employee as their target.
const rootReplayAudits = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1
  AND event_kind=convert_to('access.employee.adjustAttendance','UTF8') AND object_id IS NULL
  AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok'
  AND safe_metadata->>'resource'='employee' AND safe_metadata->>'keyKind'='uuid' AND safe_metadata->>'key'=$2`

const replayWrites = `SELECT concat_ws('|',
 (SELECT count(*) FROM attendance_adjustment),
 (SELECT count(*) FROM hr_idempotency WHERE operation='attendance.adjust'))`

// Root's replay commits exactly one audit, the access of the employee it names, and is refused when that
// audit cannot be written. An IAM replay is never audited.
func TestARootReplayIsAuditedOnItsEmployeeAndAnIAMReplayIsNot(t *testing.T) {
	f := newAttendanceFixture(t)
	for _, run := range []struct {
		actor  string
		audits int
	}{{"R", 1}, {"H", 0}} {
		key := f.one(t, newKey)
		first := f.adjust(t, run.actor, "E", adjustSpec{key: key})
		mustDB(t, first.err)
		state := f.one(t, replayWrites)
		audits, err := strconv.Atoi(f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`, f.accounts[run.actor]))
		mustDB(t, err)
		f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
		refused := f.adjust(t, run.actor, "E", adjustSpec{key: key})
		f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
		if run.audits == 1 && (sqlState(refused.err) != "42501" || refused.result != AdjustmentResult{}) {
			t.Errorf("%s replay released without its audit: %+v", run.actor, refused)
		}
		if run.audits == 0 && (refused.err != nil || refused.result != first.result) {
			t.Errorf("%s replay needs no audit: %+v", run.actor, refused)
		}
		if again := f.adjust(t, run.actor, "E", adjustSpec{key: key}); again.err != nil || again.result != first.result {
			t.Errorf("%s replay %+v, first %+v", run.actor, again, first)
		}
		if after := f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`, f.accounts[run.actor]); after != strconv.Itoa(audits+run.audits) {
			t.Errorf("%s replays left %s audit rows, want %d", run.actor, after, audits+run.audits)
		}
		if got := f.one(t, rootReplayAudits, f.accounts[run.actor], f.employees["E"]); got != strconv.Itoa(run.audits) {
			t.Errorf("%s replay audits of the employee: %s", run.actor, got)
		}
		if after := f.one(t, replayWrites); after != state {
			t.Errorf("%s replay wrote %s -> %s", run.actor, state, after)
		}
	}
}

func TestAClosedMonthRefusesTheAdjustmentUntilItIsReopened(t *testing.T) {
	f := newAttendanceFixture(t)
	f.closeMonth(t, "2026-04")
	before := f.one(t, adjustWrites)
	refused := f.adjust(t, "H", "E", adjustSpec{workDate: "2026-04-15"})
	if !rejectedWith(refused.err, "error.periodClosed") {
		t.Fatalf("closed month: %+v", refused)
	}
	if status, _, _ := apperror.Response(refused.err); status != 409 {
		t.Errorf("closed month answers %d", status)
	}
	if after := f.one(t, adjustWrites); after != before {
		t.Errorf("a refused adjustment wrote %s -> %s", before, after)
	}
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{workDate: "2026-05-04"}).err)
	f.reopen(t, "2026-04", string(rune(0x0110))+"i"+string(rune(0x1ec1))+"u ch"+string(rune(0x1ec9))+"nh")
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{workDate: "2026-04-15"}).err)
	if len(f.entries(t, "E")) != 2 {
		t.Error("open months accept the entry")
	}
}

func TestTheDayMustBeInsideTheEmployment(t *testing.T) {
	f := newAttendanceFixture(t)
	f.hire(t, "A6", "2026-02-02")
	before := f.one(t, adjustWrites)
	if got := f.adjust(t, "H", "A6", adjustSpec{workDate: "2026-01-15"}); !errors.Is(got.err, apperror.ErrCommandRejected) {
		t.Errorf("before the hire: %+v", got)
	}
	f.exec(t, `UPDATE employee SET terminated_on = DATE '2026-03-13' WHERE id = $1`, f.employees["A6"])
	if got := f.adjust(t, "H", "A6", adjustSpec{workDate: "2026-03-16"}); !errors.Is(got.err, apperror.ErrCommandRejected) {
		t.Errorf("after the termination: %+v", got)
	}
	if after := f.one(t, adjustWrites); after != before {
		t.Errorf("refusals wrote %s -> %s", before, after)
	}
	mustDB(t, f.adjust(t, "H", "A6", adjustSpec{workDate: "2026-03-13"}).err)
	mustDB(t, f.adjust(t, "H", "A6", adjustSpec{workDate: "2026-02-02"}).err)
}

func TestThePaidTotalOfAMonthNeverGoesBelowZero(t *testing.T) {
	f := newAttendanceFixture(t)
	f.hire(t, "A7", "2026-03-30")
	at := func(day string, minutes int) error {
		return f.adjust(t, "H", "A7", adjustSpec{workDate: day, minutes: minutes}).err
	}
	if got := f.paid(t, "A7", march); got != 960 {
		t.Fatalf("two weekdays: %d", got)
	}
	mustDB(t, at("2026-03-30", -600))
	before := f.one(t, adjustWrites)
	if err := at("2026-03-31", -400); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("below zero: %v", err)
	}
	if after := f.one(t, adjustWrites); after != before {
		t.Errorf("the refusal wrote %s -> %s", before, after)
	}
	mustDB(t, at("2026-03-31", -360))
	if err := at("2026-03-31", -1); !errors.Is(err, apperror.ErrCommandRejected) || f.paid(t, "A7", march) != 0 {
		t.Errorf("at zero: %v", err)
	}
	mustDB(t, at("2026-03-31", 30))
	mustDB(t, at("2026-03-31", -30))
	mustDB(t, at("2026-04-01", -1))
	f.exec(t, `WITH r AS (INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'unpaid-leave','approved','Fixture' FROM gen_random_uuid() g RETURNING id)
      INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      SELECT r.id,'unpaid-leave',DATE '2026-04-02',540,1080,480 FROM r`, f.employees["A7"], f.accounts["H"], f.team)
	if got := f.paid(t, "A7", "2026-04"); got != 22*480-480-1 {
		t.Fatalf("approved unpaid leave counts: %d", got)
	}
	f.exec(t, `INSERT INTO attendance_adjustment(id,employee_id,work_date,minutes,reason,actor_account_id)
      SELECT gen_random_uuid(),$1,DATE '2026-04-06',-1440,'Fixture',$2 FROM generate_series(1,6)`, f.employees["A7"], f.accounts["H"])
	if err := at("2026-04-03", -(22*480-480-1-6*1440)-1); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("one minute past zero: %v", err)
	}
	mustDB(t, at("2026-04-03", -(22*480-480-1-6*1440)))
}

func TestAnAuditFailureRollsBackTheEntryAndTheClaim(t *testing.T) {
	f := newAttendanceFixture(t)
	before := f.one(t, adjustWrites)
	key := f.one(t, newKey)
	f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
	failed := f.adjust(t, "H", "E", adjustSpec{key: key})
	f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
	if sqlState(failed.err) != "42501" {
		t.Fatalf("audit failure: %+v", failed)
	}
	if after := f.one(t, adjustWrites); after != before {
		t.Errorf("a failed audit kept %s -> %s", before, after)
	}
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{key: key}).err)
	if len(f.entries(t, "E")) != 1 {
		t.Error("the same key did not succeed once")
	}
}

func TestTheListIsOneMonthNewestFirstWithItsTotalAndPage(t *testing.T) {
	f := newAttendanceFixture(t)
	first := f.adjust(t, "H", "E", adjustSpec{workDate: "2026-03-03", minutes: 30})
	second := f.adjust(t, "H", "E", adjustSpec{workDate: "2026-03-04", minutes: -10, reference: ref("R-1")})
	mustDB(t, errors.Join(first.err, second.err, f.adjust(t, "H", "E", adjustSpec{workDate: "2026-04-06", minutes: 5}).err, f.adjust(t, "H", "O", adjustSpec{workDate: "2026-03-05", minutes: 7}).err))
	query := AdjustmentQuery{EmployeeID: f.employees["E"], Month: march, Limit: 20}
	list, found, err := f.service.Adjustments(t.Context(), f.stale["H"], query)
	mustDB(t, err)
	if !found || list.EmployeeID != f.employees["E"] || list.Month != march || list.PeriodState != "open" || list.Total != "2" || list.AdjustmentMinutes != 20 || len(list.Items) != 2 {
		t.Fatalf("list %v %+v", found, list)
	}
	if a, b := list.Items[0], list.Items[1]; a.ID != second.result.ID || a.WorkDate != "2026-03-04" || a.Minutes != -10 || a.Reference == nil || *a.Reference != "R-1" ||
		b.ID != first.result.ID || b.Reference != nil || !strings.HasSuffix(b.CreatedAt, "Z") || len(b.CreatedAt) != len("2026-03-03T00:00:00.000000Z") || b.Reason == "" {
		t.Errorf("items %+v", list.Items)
	}
	query.Limit, query.Offset = 1, 1
	page, _, err := f.service.Adjustments(t.Context(), f.fresh["H"], query)
	mustDB(t, err)
	if page.Total != "2" || page.AdjustmentMinutes != 20 || len(page.Items) != 1 || page.Items[0].ID != first.result.ID {
		t.Errorf("page %+v", page)
	}
	f.closeMonth(t, march)
	closed, _, err := f.service.Adjustments(t.Context(), f.fresh["H"], query)
	mustDB(t, err)
	if closed.PeriodState != "closed" {
		t.Errorf("closed month %+v", closed)
	}
	empty, found, err := f.service.Adjustments(t.Context(), f.fresh["H"], AdjustmentQuery{EmployeeID: f.employees["E"], Month: "2026-06", Limit: 20})
	mustDB(t, err)
	if !found || empty.Items == nil || len(empty.Items) != 0 || empty.Total != "0" {
		t.Errorf("empty month %+v", empty)
	}
	if _, found, err := f.service.Adjustments(t.Context(), f.fresh["R"], query); err != nil || !found {
		t.Errorf("Root reads the list: %v", err)
	}
	for _, actor := range []string{"E", "L", "C", "N"} {
		if list, found, err := f.service.Adjustments(t.Context(), f.fresh[actor], query); err != nil || found {
			t.Errorf("%s reads %+v %v", actor, list, err)
		}
	}
	query.EmployeeID = "00000000-0000-4000-8000-000000000000"
	if list, found, err := f.service.Adjustments(t.Context(), f.fresh["H"], query); err != nil || found {
		t.Errorf("absent employee %+v %v", list, err)
	}
}

func TestTheEntriesAreAppendOnlyForTheRuntimeLogin(t *testing.T) {
	f := newAttendanceFixture(t)
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{}).err)
	f.closeMonth(t, "2026-05")
	for _, statement := range []string{
		`UPDATE attendance_adjustment SET minutes = 1`, `DELETE FROM attendance_adjustment`,
		`DELETE FROM attendance_period`, `DELETE FROM attendance_period_event`,
		`UPDATE attendance_period_event SET reason = 'x'`, `UPDATE attendance_period SET month = month`,
	} {
		f.exec(t, `SET ROLE product_data`)
		_, err := f.conn.Exec(t.Context(), statement)
		f.exec(t, `RESET ROLE`)
		if sqlState(err) != "42501" {
			t.Errorf("%s: %v", statement, err)
		}
	}
}

// The other runtime logins read none of the attendance tables, the data login cannot rewrite counters, and the
// database itself refuses rows the commands never write: a period not on the first, a closed month without its
// snapshot or an open one with it, a negative or orphan counter, a reopen without its reason, an entry out of
// its bounds.
func TestTheAttendanceTablesRefuseOtherLoginsAndImpossibleRows(t *testing.T) {
	f := newAttendanceFixture(t)
	mustDB(t, f.adjust(t, "H", "E", adjustSpec{}).err)
	f.closeMonth(t, "2026-05")
	as := func(role, statement string) string {
		t.Helper()
		f.exec(t, `SET ROLE `+role)
		_, err := f.conn.Exec(t.Context(), statement)
		f.exec(t, `RESET ROLE`)
		return sqlState(err)
	}
	for _, statement := range []string{`DELETE FROM wfh_month_counter`, `UPDATE wfh_month_counter SET employee_id = employee_id`} {
		if code := as("product_data", statement); code != "42501" {
			t.Errorf("data %s: %s", statement, code)
		}
	}
	for _, login := range []string{"product_authority", "product_identity", "product_sync"} {
		for _, table := range []string{"wfh_month_counter", "attendance_period", "attendance_period_event", "attendance_adjustment"} {
			if code := as(login, `SELECT 1 FROM `+table); code != "42501" {
				t.Errorf("%s reads %s: %s", login, table, code)
			}
		}
	}
	insert := func(statement string, args ...any) string {
		t.Helper()
		_, err := f.conn.Exec(t.Context(), statement, args...)
		return sqlState(err)
	}
	for statement, want := range map[string]string{
		`INSERT INTO attendance_period(month) VALUES (DATE '2026-03-02')`:                                                                "23514",
		`INSERT INTO attendance_period(month, state) VALUES (DATE '2025-03-01', 'closed')`:                                               "23514",
		`INSERT INTO attendance_period(month, state, snapshot, snapshot_hash) VALUES (DATE '2025-04-01', 'open', '{}', repeat('a', 64))`: "23514",
		`INSERT INTO wfh_month_counter(employee_id, month, approved_count) SELECT id, DATE '2026-03-01', -1 FROM employee LIMIT 1`:       "23514",
		`INSERT INTO wfh_month_counter(employee_id, month, approved_count) VALUES (gen_random_uuid(), DATE '2026-03-01', 1)`:             "23503",
		`INSERT INTO attendance_period_event(id, month, version, event, actor_account_id)
       SELECT gen_random_uuid(), month, 9, 'reopen', (SELECT id FROM app_user LIMIT 1) FROM attendance_period LIMIT 1`: "23514",
		`INSERT INTO attendance_period_event(id, month, version, event, reason, actor_account_id)
       SELECT gen_random_uuid(), month, 10, 'reopen', '', (SELECT id FROM app_user LIMIT 1) FROM attendance_period LIMIT 1`: "23514",
		`INSERT INTO attendance_period_event(id, month, version, event, reason, actor_account_id)
       SELECT gen_random_uuid(), month, 11, 'reopen', repeat('x', 1001), (SELECT id FROM app_user LIMIT 1) FROM attendance_period LIMIT 1`: "23514",
		`INSERT INTO attendance_period_event(id, month, version, event, reason, actor_account_id)
       SELECT gen_random_uuid(), month, 12, 'reopen', repeat('x', 1000), (SELECT id FROM app_user LIMIT 1) FROM attendance_period LIMIT 1`: "",
	} {
		if code := insert(statement); code != want {
			t.Errorf("%s: %s, want %s", statement, code, want)
		}
	}
	entry := `INSERT INTO attendance_adjustment(id, employee_id, work_date, minutes, reason, reference, actor_account_id)
      VALUES (gen_random_uuid(), $1, CAST($2 AS date), $3, $4, $5, $6)`
	if code := insert(entry, f.employees["E"], "2026-03-10", 60, "r", nil, f.accounts["H"]); code != "" {
		t.Fatalf("a valid entry: %s", code)
	}
	long := func(n int) string { return strings.Repeat("x", n) }
	for _, bad := range []struct {
		day       string
		minutes   int
		reason    string
		reference *string
	}{
		{"2026-03-10", 0, "r", nil}, {"2026-03-10", 1441, "r", nil}, {"2026-03-10", -1441, "r", nil},
		{"2026-03-10", 60, "", nil}, {"2026-03-10", 60, long(301), nil}, {"2026-03-10", 60, "a\nb", nil},
		{"2026-03-10", 60, "r", new("")}, {"2026-03-10", 60, "r", new(long(65))}, {"2026-03-10", 60, "r", new("a\nb")},
		{"1899-12-31", 60, "r", nil}, {"2101-01-01", 60, "r", nil},
	} {
		if code := insert(entry, f.employees["E"], bad.day, bad.minutes, bad.reason, bad.reference, f.accounts["H"]); code != "23514" {
			t.Errorf("%+v: %s, want 23514", bad, code)
		}
	}
}

// race holds a row lock in a superuser transaction while the commands start, and releases it once all of
// them wait; it returns every outcome.
func (f *attendanceFixture) race(t *testing.T, lock string, args []any, attempts ...func() adjustOutcome) []adjustOutcome {
	t.Helper()
	done := make(chan adjustOutcome, len(attempts))
	f.holding(t, lock, args, func(pgx.Tx) {
		for _, attempt := range attempts {
			go func() { done <- attempt() }()
		}
		f.waitBlocked(t, len(attempts))
	})
	outcomes := make([]adjustOutcome, 0, len(attempts))
	for range attempts {
		outcomes = append(outcomes, <-done)
	}
	return outcomes
}

func (f *attendanceFixture) attempt(t *testing.T, name string, spec adjustSpec) func() adjustOutcome {
	input := f.input(t, name, spec)
	return func() adjustOutcome {
		result, err := f.service.Adjust(context.Background(), f.fresh["H"], input)
		return adjustOutcome{result, err}
	}
}

func TestTwoRequestsWithOneKeyWriteOneEntryAndBothGetItsID(t *testing.T) {
	f := newAttendanceFixture(t)
	key := f.one(t, newKey)
	outcomes := f.race(t, `SELECT 1 FROM employee WHERE id=$1 FOR UPDATE`, []any{f.employees["E"]}, f.attempt(t, "E", adjustSpec{key: key}), f.attempt(t, "E", adjustSpec{key: key}))
	mustDB(t, errors.Join(outcomes[0].err, outcomes[1].err))
	if outcomes[0].result != outcomes[1].result || len(f.entries(t, "E")) != 1 {
		t.Fatalf("%+v, %d entries", outcomes, len(f.entries(t, "E")))
	}
}

// One key for two employees is not serialized by an employee lock: both pass the idempotency read before
// they wait on the period, so the later claim finds the key taken and rolls back its entry.
func TestOneKeyForTwoEmployeesRacingClaimsOnce(t *testing.T) {
	f := newAttendanceFixture(t)
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (DATE '2026-03-01')`)
	key := f.one(t, newKey)
	outcomes := f.race(t, `SELECT 1 FROM attendance_period WHERE month=DATE '2026-03-01' FOR UPDATE`, nil, f.attempt(t, "E", adjustSpec{key: key}), f.attempt(t, "O", adjustSpec{key: key}))
	won, reused := 0, 0
	for _, o := range outcomes {
		switch {
		case o.err == nil:
			won++
		case rejectedWith(o.err, "error.idempotencyKeyReused"):
			reused++
		default:
			t.Errorf("unexpected %+v", o)
		}
	}
	if total := f.one(t, `SELECT count(*)::text FROM attendance_adjustment`); won != 1 || reused != 1 || total != "1" {
		t.Fatalf("won %d, reused %d, %s entries", won, reused, total)
	}
}

func TestTwoNegativeAdjustmentsRacingForTheLastMinutesOneFits(t *testing.T) {
	f := newAttendanceFixture(t)
	f.hire(t, "B4", "2026-03-30")
	outcomes := f.race(t, `SELECT 1 FROM employee WHERE id=$1 FOR UPDATE`, []any{f.employees["B4"]},
		f.attempt(t, "B4", adjustSpec{workDate: "2026-03-30", minutes: -600}), f.attempt(t, "B4", adjustSpec{workDate: "2026-03-31", minutes: -600}))
	won := 0
	for _, o := range outcomes {
		if o.err == nil {
			won++
		} else if !errors.Is(o.err, apperror.ErrCommandRejected) {
			t.Errorf("unexpected %+v", o)
		}
	}
	if won != 1 || f.paid(t, "B4", march) != 360 || len(f.entries(t, "B4")) != 1 {
		t.Errorf("won %d, paid %d", won, f.paid(t, "B4", march))
	}
}

// An adjustment racing the close of its month is in the snapshot exactly when it committed first.
func TestAnAdjustmentRacingTheCloseIsInTheSnapshotExactlyWhenItCommitted(t *testing.T) {
	f := newAttendanceFixture(t)
	const month = "2026-07"
	for i, day := range []string{"2026-07-06", "2026-07-07", "2026-07-08"} {
		name := "C" + strconv.Itoa(i)
		f.hire(t, name, "2026-01-05")
		closing := make(chan error, 1)
		outcomes := f.race(t, `SELECT 1 FROM employee e, hr_company c WHERE e.id=$1 FOR UPDATE`, []any{f.employees[name]},
			f.attempt(t, name, adjustSpec{workDate: day, minutes: 45}),
			func() adjustOutcome {
				_, err := f.service.ClosePeriod(context.Background(), f.fresh["H"], month)
				closing <- err
				return adjustOutcome{}
			})
		mustDB(t, <-closing)
		adjusted := outcomes[0]
		if outcomes[0] == (adjustOutcome{}) {
			adjusted = outcomes[1]
		}
		snapshot, _ := f.verified(t, month)
		mine := entryOf(snapshot, f.employees[name])
		m := month
		live, _ := f.sheet(t, "H", name, &m)
		if mine == nil || mine.Totals != live.Totals {
			t.Fatalf("snapshot %+v, live %+v", mine, live)
		}
		switch {
		case adjusted.err == nil:
			if mine.AdjustmentMinutes != 45 || len(f.entries(t, name)) != 1 {
				t.Errorf("a committed adjustment is missing from the snapshot: %+v", mine)
			}
		case rejectedWith(adjusted.err, "error.periodClosed"):
			if mine.AdjustmentMinutes != 0 || len(f.entries(t, name)) != 0 {
				t.Errorf("a refused adjustment left %+v", mine)
			}
		default:
			t.Errorf("unexpected %+v", adjusted)
		}
		f.reopen(t, month, "V"+string(rune(0xf2))+"ng "+strconv.Itoa(i))
	}
}

// lockOrder holds second, starts an adjustment of E, then tries first with a short lock timeout: a timeout
// proves the adjustment took first before it waited on second.
func (f *attendanceFixture) lockOrder(t *testing.T, second, first string) {
	t.Helper()
	done := make(chan adjustOutcome, 1)
	attempt := f.attempt(t, "E", adjustSpec{})
	f.holding(t, second, []any{f.employees["E"]}, func(tx pgx.Tx) {
		go func() { done <- attempt() }()
		f.waitBlocked(t, 1)
		_, err := tx.Exec(t.Context(), `SET LOCAL lock_timeout = '50ms'`)
		mustDB(t, err)
		_, err = tx.Exec(t.Context(), `SAVEPOINT probe`)
		mustDB(t, err)
		_, err = tx.Exec(t.Context(), first, f.employees["E"])
		if sqlState(err) != "55P03" {
			t.Errorf("%s was free while the adjustment waited on %s: %v", first, second, err)
		}
		_, err = tx.Exec(t.Context(), `ROLLBACK TO SAVEPOINT probe`)
		mustDB(t, err)
	})
	mustDB(t, (<-done).err)
}

func TestTheAdjustmentLocksEmployeeThenPeriodThenCalendar(t *testing.T) {
	f := newAttendanceFixture(t)
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (DATE '2026-03-01')`)
	f.lockOrder(t, `SELECT 1 FROM attendance_period WHERE month=DATE '2026-03-01' AND $1::uuid IS NOT NULL FOR UPDATE`, `SELECT 1 FROM employee WHERE id=$1 FOR UPDATE`)
	f.lockOrder(t, `SELECT 1 FROM work_calendar WHERE $1::uuid IS NOT NULL FOR UPDATE`, `SELECT 1 FROM attendance_period WHERE month=DATE '2026-03-01' AND $1::uuid IS NOT NULL FOR UPDATE`)
	if len(f.entries(t, "E")) != 2 {
		t.Error("both adjustments committed after the holder let go")
	}
}
