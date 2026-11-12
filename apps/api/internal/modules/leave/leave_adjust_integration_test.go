//go:build integration

package leave

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
)

const adjustState = `SELECT concat_ws('|',
 (SELECT count(*) FROM leave_ledger),
 (SELECT count(*)||':'||coalesce(sum(revision),0) FROM leave_bucket),
 (SELECT count(*) FROM hr_idempotency WHERE operation='leave.adjust'),
 (SELECT count(*) FROM audit_outbox))`

const newKey = `SELECT gen_random_uuid()::text`

type adjustOutcome struct {
	result AdjustmentResult
	err    error
}

func (f *leaveFixture) adjust(t *testing.T, actor, name, key string, minutes int, effectiveOn, reference string) adjustOutcome {
	t.Helper()
	if key == "" {
		key = f.one(t, newKey)
	}
	result, err := f.service.Adjust(t.Context(), f.fresh[actor], AdjustmentInput{
		EmployeeID: f.employees[name], IdempotencyKey: key, Minutes: minutes, EffectiveOn: effectiveOn, Reference: reference,
	})
	return adjustOutcome{result, err}
}

func (f *leaveFixture) closeMonth(t *testing.T, month string) {
	t.Helper()
	f.exec(t, `INSERT INTO attendance_period(month,state,version,snapshot,snapshot_hash)
      VALUES(CAST($1 AS date),'closed',2,'{}'::jsonb,repeat('a',64))
      ON CONFLICT (month) DO UPDATE SET state='closed',version=2,snapshot='{}'::jsonb,snapshot_hash=repeat('a',64)`, month)
}

type ledgerRow struct{ id, kind, minutes, reference, date string }

func (f *leaveFixture) adjustments(t *testing.T, name string) []ledgerRow {
	t.Helper()
	rows, err := f.conn.Query(t.Context(), `SELECT id::text, entry_kind, minutes::text, reference, to_char(effective_on,'YYYY-MM-DD')
      FROM leave_ledger WHERE employee_id=$1 AND entry_kind='adjustment' ORDER BY created_at, id`, f.employees[name])
	mustDB(t, err)
	defer rows.Close()
	var found []ledgerRow
	for rows.Next() {
		var r ledgerRow
		mustDB(t, rows.Scan(&r.id, &r.kind, &r.minutes, &r.reference, &r.date))
		found = append(found, r)
	}
	mustDB(t, rows.Err())
	return found
}

func rejectedWith(err error, code apperror.Code) bool {
	rejection, ok := errors.AsType[apperror.Rejection](err)
	return ok && rejection.Code == code
}

func TestHRAdjustsWithAReferenceInOneAuditedEntry(t *testing.T) {
	f := newLeaveFixture(t)
	before := f.entitled(t, "E", "2026-03-31")
	reference := "Q" + string(rune(0x0110)) + "-2026/03"
	first := f.adjust(t, "H", "E", "", 480, "2026-03-10", reference)
	mustDB(t, first.err)
	if rows := f.adjustments(t, "E"); len(rows) != 1 || rows[0] != (ledgerRow{first.result.ID, "adjustment", "480", reference, "2026-03-10"}) {
		t.Fatalf("ledger %+v", rows)
	}
	if got := f.entitled(t, "E", "2026-03-31"); got != before+480 {
		t.Errorf("entitled %d, want %d", got, before+480)
	}
	if f.audits(t, "hr.leave.adjust") != 1 || f.one(t, `SELECT revision::text FROM leave_bucket WHERE employee_id=$1 AND year=2026`, f.employees["E"]) != "2" {
		t.Error("one audit and one bucket revision after the first entry")
	}
	mustDB(t, f.adjust(t, "H", "E", "", -240, "2026-03-10", "S"+string(rune(0x1eed))+"a s"+string(rune(0x1ed1))+" c"+string(rune(0x169))).err)
	if got := f.entitled(t, "E", "2026-03-31"); got != before+240 || len(f.adjustments(t, "E")) != 2 {
		t.Errorf("entitled %d after the negative entry", got)
	}
	if f.one(t, `SELECT revision::text FROM leave_bucket WHERE employee_id=$1 AND year=2026`, f.employees["E"]) != "3" {
		t.Error("the second entry did not bump the bucket")
	}
	mustDB(t, f.adjust(t, "R", "E", "", 60, "2026-03-11", "root").err)
	if f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND convert_from(event_kind,'UTF8')='hr.leave.adjust'`, f.accounts["R"]) != "1" {
		t.Error("Root adjustment not audited")
	}
}

func TestOnlyFreshHRAdjustsAndEveryoneElseWritesNothing(t *testing.T) {
	f := newLeaveFixture(t)
	before := f.one(t, adjustState)
	input := AdjustmentInput{EmployeeID: f.employees["E"], IdempotencyKey: f.one(t, newKey), Minutes: 480, EffectiveOn: "2026-03-10", Reference: "x"}
	if _, err := f.service.Adjust(t.Context(), f.stale["H"], input); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("stale HR: %v", err)
	}
	for _, actor := range []string{"E", "L", "C", "O", "N"} {
		if got := f.adjust(t, actor, "E", "", 480, "2026-03-10", "x"); !errors.Is(got.err, apperror.ErrNotFound) {
			t.Errorf("%s: %+v", actor, got)
		}
	}
	input.EmployeeID = "00000000-0000-4000-8000-000000000000"
	if _, err := f.service.Adjust(t.Context(), f.fresh["H"], input); !errors.Is(err, apperror.ErrNotFound) {
		t.Errorf("absent employee: %v", err)
	}
	if after := f.one(t, adjustState); after != before {
		t.Errorf("refusals wrote %s -> %s", before, after)
	}
}

func TestARetryReplaysAndAnotherPayloadReusesTheKey(t *testing.T) {
	f := newLeaveFixture(t)
	key := f.one(t, newKey)
	first := f.adjust(t, "H", "E", key, 480, "2026-03-10", "QD")
	mustDB(t, first.err)
	state := f.one(t, adjustState)
	if again := f.adjust(t, "H", "E", key, 480, "2026-03-10", "QD"); again.err != nil || again.result != first.result {
		t.Fatalf("replay %+v, first %+v", again, first)
	}
	for name, other := range map[string]adjustOutcome{
		"minutes":   f.adjust(t, "H", "E", key, 960, "2026-03-10", "QD"),
		"date":      f.adjust(t, "H", "E", key, 480, "2026-03-11", "QD"),
		"reference": f.adjust(t, "H", "E", key, 480, "2026-03-10", "QE"),
		"employee":  f.adjust(t, "H", "O", key, 480, "2026-03-10", "QD"),
	} {
		if !rejectedWith(other.err, "error.idempotencyKeyReused") {
			t.Errorf("%s: %+v", name, other)
		}
		if status, _, _ := apperror.Response(other.err); status != 422 {
			t.Errorf("%s answers %d", name, status)
		}
	}
	if after := f.one(t, adjustState); after != state {
		t.Errorf("replay or reuse wrote %s -> %s", state, after)
	}
	if other := f.adjust(t, "C", "E", key, 480, "2026-03-10", "QD"); !errors.Is(other.err, apperror.ErrNotFound) {
		t.Errorf("another actor's key space: %+v", other)
	}
	mustDB(t, f.adjust(t, "H", "E", "", 480, "2026-03-10", "QD").err)
	if len(f.adjustments(t, "E")) != 2 {
		t.Error("a new key is a new adjustment")
	}
}

const replayState = `SELECT concat_ws('|',
 (SELECT count(*) FROM leave_ledger),
 (SELECT count(*)||':'||coalesce(sum(revision),0) FROM leave_bucket),
 (SELECT count(*) FROM hr_idempotency WHERE operation='leave.adjust'))`

// rootReplayAudits counts Root's access rows of the adjustment that name the employee as their target.
const rootReplayAudits = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1
  AND event_kind=convert_to('access.employee.adjustLeaveBalance','UTF8') AND object_id IS NULL
  AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok'
  AND safe_metadata->>'resource'='employee' AND safe_metadata->>'keyKind'='uuid' AND safe_metadata->>'key'=$2`

// A replay writes nothing; Root's replay commits exactly one audit, the access of the employee it names, and
// is refused when that audit cannot be written. An IAM replay is never audited.
func TestARootReplayIsAuditedOnItsEmployeeAndAnIAMReplayIsNot(t *testing.T) {
	f := newLeaveFixture(t)
	for _, run := range []struct {
		actor  string
		audits int
	}{{"R", 1}, {"H", 0}} {
		key := f.one(t, newKey)
		first := f.adjust(t, run.actor, "E", key, 480, "2026-03-10", "QD")
		mustDB(t, first.err)
		state := f.one(t, replayState)
		audits := f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`, f.accounts[run.actor])
		f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
		refused := f.adjust(t, run.actor, "E", key, 480, "2026-03-10", "QD")
		f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
		if pg, ok := errors.AsType[*pgconn.PgError](refused.err); run.audits == 1 && (!ok || pg.Code != "42501" || refused.result != AdjustmentResult{}) {
			t.Errorf("%s replay released without its audit: %+v", run.actor, refused)
		}
		if run.audits == 0 && (refused.err != nil || refused.result != first.result) {
			t.Errorf("%s replay needs no audit: %+v", run.actor, refused)
		}
		again := f.adjust(t, run.actor, "E", key, 480, "2026-03-10", "QD")
		if again.err != nil || again.result != first.result {
			t.Errorf("%s replay %+v, first %+v", run.actor, again, first)
		}
		after := f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`, f.accounts[run.actor])
		if want := strconv.Itoa(mustAtoi(t, audits) + run.audits); after != want {
			t.Errorf("%s replays left %s audit rows, want %s", run.actor, after, want)
		}
		if got := f.one(t, rootReplayAudits, f.accounts[run.actor], f.employees["E"]); got != strconv.Itoa(run.audits) {
			t.Errorf("%s replay audits of the employee: %s", run.actor, got)
		}
		if after := f.one(t, replayState); after != state {
			t.Errorf("%s replay wrote %s -> %s", run.actor, state, after)
		}
	}
}

func mustAtoi(t *testing.T, s string) int {
	t.Helper()
	n, err := strconv.Atoi(s)
	mustDB(t, err)
	return n
}

func TestAClosedMonthRefusesTheAdjustmentBeforeAnyEffect(t *testing.T) {
	f := newLeaveFixture(t)
	f.closeMonth(t, "2026-04-01")
	before := f.one(t, adjustState)
	refused := f.adjust(t, "H", "E", "", 480, "2026-04-15", "x")
	if !rejectedWith(refused.err, "error.periodClosed") {
		t.Fatalf("closed month: %+v", refused)
	}
	if status, _, _ := apperror.Response(refused.err); status != 409 {
		t.Errorf("closed month answers %d", status)
	}
	if after := f.one(t, adjustState); after != before {
		t.Errorf("a refused adjustment wrote %s -> %s", before, after)
	}
	mustDB(t, f.adjust(t, "H", "E", "", 480, "2026-05-04", "x").err)
	f.exec(t, `UPDATE attendance_period SET state='open',version=3,snapshot=NULL,snapshot_hash=NULL WHERE month=DATE '2026-04-01'`)
	mustDB(t, f.adjust(t, "H", "E", "", 480, "2026-04-15", "x").err)
	if len(f.adjustments(t, "E")) != 2 {
		t.Error("open months accept the entry")
	}
}

func TestAnAdjustmentBeforeTheHireDateIsRefused(t *testing.T) {
	f := newLeaveFixture(t)
	f.hire(t, "Y5", "2026-02-02", 5760, false)
	before := f.one(t, adjustState)
	if got := f.adjust(t, "H", "Y5", "", 480, "2026-01-15", "x"); !errors.Is(got.err, apperror.ErrCommandRejected) {
		t.Fatalf("before hire: %+v", got)
	}
	if after := f.one(t, adjustState); after != before {
		t.Errorf("wrote %s -> %s", before, after)
	}
	mustDB(t, f.adjust(t, "H", "Y5", "", 480, "2026-02-02", "x").err)
}

func TestAnAuditFailureRollsBackTheEntryTheClaimAndTheBucket(t *testing.T) {
	f := newLeaveFixture(t)
	before := f.one(t, adjustState)
	key := f.one(t, newKey)
	f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
	failed := f.adjust(t, "H", "E", key, 480, "2026-03-10", "x")
	f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
	if pg, ok := errors.AsType[*pgconn.PgError](failed.err); !ok || pg.Code != "42501" {
		t.Fatalf("audit failure: %+v", failed)
	}
	if after := f.one(t, adjustState); after != before {
		t.Errorf("a failed audit kept %s -> %s", before, after)
	}
	mustDB(t, f.adjust(t, "H", "E", key, 480, "2026-03-10", "x").err)
	if len(f.adjustments(t, "E")) != 1 {
		t.Error("the same key did not succeed once")
	}
}

// race holds a row lock in a superuser transaction while the adjustments start, and releases it once all
// of them wait; it returns every outcome.
func (f *leaveFixture) race(t *testing.T, lock string, args []any, attempts ...func() adjustOutcome) []adjustOutcome {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), lock, args...)
	mustDB(t, err)
	done := make(chan adjustOutcome, len(attempts))
	for _, attempt := range attempts {
		go func() { done <- attempt() }()
	}
	f.waitBlocked(t, len(attempts))
	mustDB(t, tx.Commit(t.Context()))
	outcomes := make([]adjustOutcome, 0, len(attempts))
	for range attempts {
		outcomes = append(outcomes, <-done)
	}
	return outcomes
}

func (f *leaveFixture) attempt(actor, name, key string) func() adjustOutcome {
	return func() adjustOutcome {
		result, err := f.service.Adjust(context.Background(), f.fresh[actor], AdjustmentInput{
			EmployeeID: f.employees[name], IdempotencyKey: key, Minutes: 480, EffectiveOn: "2026-03-10", Reference: "race",
		})
		return adjustOutcome{result, err}
	}
}

func TestTwoRequestsWithOneKeyWriteOneEntryAndBothGetItsID(t *testing.T) {
	f := newLeaveFixture(t)
	key := f.one(t, newKey)
	outcomes := f.race(t, `SELECT 1 FROM employee WHERE id=$1 FOR UPDATE`, []any{f.employees["E"]}, f.attempt("H", "E", key), f.attempt("H", "E", key))
	for _, o := range outcomes {
		mustDB(t, o.err)
	}
	if outcomes[0].result != outcomes[1].result || len(f.adjustments(t, "E")) != 1 {
		t.Fatalf("%+v, %d entries", outcomes, len(f.adjustments(t, "E")))
	}
}

// One key for two employees is not serialized by an employee lock: both pass the idempotency read before
// they wait on the period (race waits for both), so the later claim, not the read, finds the key taken
// and rolls back its entry.
func TestOneKeyForTwoEmployeesRacingClaimsOnce(t *testing.T) {
	f := newLeaveFixture(t)
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (DATE '2026-03-01') ON CONFLICT DO NOTHING`)
	before := f.one(t, `SELECT count(*)::text FROM leave_ledger`)
	key := f.one(t, newKey)
	outcomes := f.race(t, `SELECT 1 FROM attendance_period WHERE month=DATE '2026-03-01' FOR UPDATE`, nil, f.attempt("H", "E", key), f.attempt("H", "O", key))
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
	after := f.one(t, `SELECT count(*)::text FROM leave_ledger`)
	if won != 1 || reused != 1 || after != "1" || before != "0" {
		t.Fatalf("won %d, reused %d, ledger %s -> %s", won, reused, before, after)
	}
}

// lockOrder holds second, starts an adjustment of E, then tries first with a short lock timeout: a
// timeout proves the adjustment took first before it waited on second.
func (f *leaveFixture) lockOrder(t *testing.T, second, first string) {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), second, f.employees["E"])
	mustDB(t, err)
	done := make(chan adjustOutcome, 1)
	attempt := f.attempt("H", "E", f.one(t, newKey))
	go func() { done <- attempt() }()
	f.waitBlocked(t, 1)
	_, err = tx.Exec(t.Context(), `SET LOCAL lock_timeout = '50ms'`)
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), first, f.employees["E"])
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "55P03" {
		t.Errorf("%s was free while the adjustment waited on %s: %v", first, second, err)
	}
	mustDB(t, tx.Rollback(t.Context()))
	mustDB(t, (<-done).err)
}

func TestTheAdjustmentLocksEmployeeThenBucketThenPeriod(t *testing.T) {
	f := newLeaveFixture(t)
	f.exec(t, `INSERT INTO leave_bucket(employee_id,year) VALUES($1,2026)`, f.employees["E"])
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (DATE '2026-03-01') ON CONFLICT DO NOTHING`)
	f.lockOrder(t, `SELECT 1 FROM leave_bucket WHERE employee_id=$1 AND year=2026 FOR UPDATE`, `SELECT 1 FROM employee WHERE id=$1 FOR UPDATE`)
	f.lockOrder(t, `SELECT 1 FROM attendance_period WHERE month=DATE '2026-03-01' AND $1::uuid IS NOT NULL FOR UPDATE`, `SELECT 1 FROM leave_bucket WHERE employee_id=$1 AND year=2026 FOR UPDATE`)
	if len(f.adjustments(t, "E")) != 2 {
		t.Error("both adjustments committed after the holder let go")
	}
}

func TestANegativeAdjustmentMakesPendingLeaveExceedTheAccrual(t *testing.T) {
	f := newLeaveFixture(t)
	request := f.pending(t, "E", "2026-03-09", "2026-03-10")
	if len(excessOf(f.reconciliation(t, "H", 2026, 100, 0), f.employees["E"])) != 0 {
		t.Fatal("listed before the adjustment")
	}
	mustDB(t, f.adjust(t, "H", "E", "", -960, "2026-03-01", "Gi"+string(rune(0x1ea3))+"m").err)
	mine := excessOf(f.reconciliation(t, "H", 2026, 100, 0), f.employees["E"])
	if len(mine) == 0 || mine[0].Month != 3 || mine[0].AccruedMinutes != 480 || mine[0].PendingMinutes != 960 || mine[0].ExcessMinutes != 480 || len(mine[0].RequestIDs) != 1 || mine[0].RequestIDs[0] != request {
		t.Fatalf("%+v", mine)
	}
	if own := f.reconciliation(t, "E", 2026, 100, 0); len(own.Items) == 0 || len(own.Items) != len(excessOf(own, f.employees["E"])) {
		t.Errorf("the employee reads someone else's months: %+v", own)
	}
	if outsider := f.reconciliation(t, "N", 2026, 100, 0); len(outsider.Items) != 0 {
		t.Errorf("an outsider reads %+v", outsider)
	}
}
