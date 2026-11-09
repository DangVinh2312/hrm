//go:build integration

package workrequest

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/test/fixture"
)

// cancelState is every row a cancellation writes but the audit, plus the request's state and version.
const cancelState = `SELECT concat_ws('|', (SELECT state||version FROM work_request WHERE id=$1), (SELECT count(*) FROM request_decision),
  (SELECT count(*) FROM hr_idempotency), (SELECT count(*) FROM leave_ledger), (SELECT coalesce(sum(approved_count),0) FROM wfh_month_counter),
  (SELECT count(*) FROM leave_bucket), (SELECT coalesce(sum(revision),0) FROM leave_bucket), (SELECT count(*) FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'hr.%'))`

// withdrawal is a cancellation of r at its version under a new key, with the HR reason.
func (f *requestFixture) withdrawal(t *testing.T, r SubmitResult) CancelInput {
	t.Helper()
	reason := "HR " + text(0x111, 0x1ea3, 'o')
	return CancelInput{RequestID: r.ID, IdempotencyKey: f.one(t, newKey), ExpectedVersion: r.Version, Reason: &reason}
}

func (f *requestFixture) cancel(t *testing.T, actor string, input CancelInput) (SubmitResult, bool, error) {
	t.Helper()
	return f.service.Cancel(t.Context(), f.sessions[actor], input)
}

// approved is r approved by the lead, then by the COO when the chain needs it.
func (f *requestFixture) approved(t *testing.T, input SubmitInput) SubmitResult {
	t.Helper()
	r := f.mustDecide(t, "L", f.mustSubmit(t, "E", input), decisionApprove)
	if r.State == statePendingFinal {
		r = f.mustDecide(t, "C", r, decisionApprove)
	}
	if r.State != stateApproved {
		t.Fatalf("not approved: %+v", r)
	}
	return r
}

// unchanged wants call to leave every row of request id as it was.
func (f *requestFixture) unchanged(t *testing.T, name, id string, call func()) {
	t.Helper()
	before := f.one(t, cancelState, id)
	call()
	if after := f.one(t, cancelState, id); after != before {
		t.Errorf("%s wrote %s -> %s", name, before, after)
	}
}

func conflict(err error) bool { return errors.Is(err, apperror.ErrCommandRejected) }

func TestTheOwnerCancelsAPendingRequestAndNobodyElseDoes(t *testing.T) {
	f := newRequestFixture(t)
	waiting := f.mustSubmit(t, "E", f.wfh(t, 0))
	f.unchanged(t, "others", waiting.ID, func() {
		for _, actor := range []string{"L", "H", "C", "O", "N"} {
			if _, found, err := f.cancel(t, actor, CancelInput{RequestID: waiting.ID, IdempotencyKey: f.one(t, newKey), ExpectedVersion: "1"}); found || err != nil {
				t.Errorf("%s cancelled a pending request: %v %v", actor, found, err)
			}
		}
	})
	input := CancelInput{RequestID: waiting.ID, IdempotencyKey: f.one(t, newKey), ExpectedVersion: "1"}
	done, found, err := f.cancel(t, "E", input)
	if err != nil || !found || done != (SubmitResult{ID: waiting.ID, State: stateCancelled, Version: "2"}) {
		t.Fatalf("owner cancel %+v %v %v", done, found, err)
	}
	if got := f.one(t, `SELECT concat_ws('|',stage,decision,actor_kind,actor_account_id,coalesce(reason,'null')) FROM request_decision WHERE request_id=$1`, waiting.ID); got != "cancel|cancel|user|"+f.accounts["E"]+"|null" {
		t.Errorf("decision %s", got)
	}
	if f.audits(t, "hr.request.cancel") != 1 || f.count(t, `SELECT count(*)::text FROM hr_idempotency WHERE operation='workRequest.cancel'`) != 1 {
		t.Error("one audit and one claim")
	}
	f.unchanged(t, "replay and terminal", waiting.ID, func() {
		if again, _, err := f.cancel(t, "E", input); err != nil || again != done {
			t.Errorf("replay %+v %v", again, err)
		}
		other := input
		reason := "x"
		other.Reason = &reason
		if _, _, err := f.cancel(t, "E", other); !rejectedWith(err, "error.idempotencyKeyReused") {
			t.Errorf("another payload under the key: %v", err)
		}
		for _, version := range []string{"1", "2"} {
			if _, _, err := f.cancel(t, "E", CancelInput{RequestID: waiting.ID, IdempotencyKey: f.one(t, newKey), ExpectedVersion: version}); !conflict(err) {
				t.Errorf("cancelled again at %s: %v", version, err)
			}
		}
		if _, _, err := f.decide(t, "L", f.verdict(t, done, decisionApprove)); !conflict(err) {
			t.Errorf("a cancelled request decided: %v", err)
		}
	})
}

func TestOnlyAFreshHRCancelsAnApprovedRequestWithAReason(t *testing.T) {
	f := newRequestFixture(t)
	approved := f.approved(t, f.wfh(t, 0))
	stale := fixture.Session(t, f.s, f.accounts["H"], fixture.SessionSpec{})
	noReason := f.withdrawal(t, approved)
	noReason.Reason = nil
	old := f.withdrawal(t, approved)
	old.ExpectedVersion = "1"
	f.unchanged(t, "refusals", approved.ID, func() {
		if _, _, err := f.cancel(t, "E", f.withdrawal(t, approved)); !conflict(err) {
			t.Errorf("the owner cancelled an approved request: %v", err)
		}
		for _, actor := range []string{"L", "C", "O", "N"} {
			if _, found, err := f.cancel(t, actor, f.withdrawal(t, approved)); found || err != nil {
				t.Errorf("%s: %v %v", actor, found, err)
			}
		}
		if _, _, err := f.service.Cancel(t.Context(), stale, f.withdrawal(t, approved)); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("a stale session: %v", err)
		}
		if _, _, err := f.cancel(t, "H", noReason); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("no reason: %v", err)
		}
		if _, _, err := f.cancel(t, "H", old); !conflict(err) {
			t.Errorf("stale version: %v", err)
		}
	})
	input := f.withdrawal(t, approved)
	done, found, err := f.cancel(t, "H", input)
	if err != nil || !found || done != (SubmitResult{ID: approved.ID, State: stateCancelled, Version: "4"}) {
		t.Fatalf("HR cancel %+v %v %v", done, found, err)
	}
	if got := f.one(t, `SELECT actor_account_id||'|'||reason FROM request_decision WHERE request_id=$1 AND stage='cancel'`, approved.ID); got != f.accounts["H"]+"|"+*input.Reason {
		t.Errorf("decision %s", got)
	}
	if f.audits(t, "hr.request.cancel-approved") != 1 {
		t.Error("one cancel-approved audit")
	}
}

func TestCancellingApprovedLeaveReversesEveryDebitOnce(t *testing.T) {
	f := newRequestFixture(t)
	input := f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080)
	input.Segments = append(input.Segments, Slot{f.day(t, 2), 540, 780})
	approved := f.approved(t, input)
	ledger := `SELECT count(*) FILTER (WHERE entry_kind='debit')||'|'||count(*) FILTER (WHERE entry_kind='reversal')||'|'||coalesce(sum(minutes) FILTER (WHERE entry_kind='debit'),0)||'|'||coalesce(sum(minutes) FILTER (WHERE entry_kind='reversal'),0)
      FROM leave_ledger WHERE source_request_id=$1 OR reverses_entry_id IN (SELECT id FROM leave_ledger WHERE source_request_id=$1)`
	cancel := f.withdrawal(t, approved)
	done, _, err := f.cancel(t, "H", cancel)
	mustDB(t, err)
	if done.State != stateCancelled || f.one(t, ledger, approved.ID) != "2|2|720|720" {
		t.Errorf("reversal %+v %s", done, f.one(t, ledger, approved.ID))
	}
	if f.count(t, `SELECT count(*)::text FROM leave_ledger r JOIN leave_ledger d ON d.id=r.reverses_entry_id
      WHERE d.source_request_id=$1 AND (r.minutes<>d.minutes OR r.effective_on<>d.effective_on)`, approved.ID) != 0 {
		t.Error("a reversal differs from its debit")
	}
	f.unchanged(t, "replay", approved.ID, func() {
		if again, _, err := f.cancel(t, "H", cancel); err != nil || again != done {
			t.Errorf("replay %+v %v", again, err)
		}
	})
	if again := f.approved(t, f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080)); again.State != stateApproved {
		t.Error("the same day booked again")
	}
	_, err = f.conn.Exec(t.Context(), `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,reverses_entry_id)
      SELECT gen_random_uuid(),employee_id,'reversal',effective_on,minutes,id FROM leave_ledger WHERE source_request_id=$1 AND entry_kind='debit' LIMIT 1`, approved.ID)
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "23505" {
		t.Errorf("a second reversal of one debit: %v", err)
	}
}

func TestCancellingApprovedWfhLowersTheCounterOnceAndOtherKindsJustLeave(t *testing.T) {
	f := newRequestFixture(t)
	days := []int{0, 1, 2}
	if f.day(t, 0)[:7] != f.day(t, 2)[:7] {
		days = []int{7, 8, 9}
	}
	month := f.day(t, days[0])[:7] + "-01"
	counter := `SELECT coalesce((SELECT approved_count::text FROM wfh_month_counter WHERE employee_id=$1 AND month=CAST($2 AS date)),'none')`
	approved := f.approved(t, f.wfh(t, days[0], days[1]))
	other := f.approved(t, f.wfh(t, days[2]))
	if got := f.one(t, counter, f.employees["E"], month); got != "3" {
		t.Fatalf("counter %s", got)
	}
	input := f.withdrawal(t, approved)
	done, _, err := f.cancel(t, "H", input)
	mustDB(t, err)
	if again, _, err := f.cancel(t, "H", input); err != nil || again != done {
		t.Errorf("replay %+v %v", again, err)
	}
	if got := f.one(t, counter, f.employees["E"], month); got != "1" || f.one(t, `SELECT state FROM work_request WHERE id=$1`, other.ID) != stateApproved {
		t.Errorf("counter %s after one cancel and a replay", got)
	}
	for _, input := range []SubmitInput{f.leave(t, hrbase.RequestUnpaidLeave, 3, 540, 780), f.late(t, 4, 600), f.early(t, 10, 960)} {
		r := f.approved(t, input)
		if done, _, err := f.cancel(t, "H", f.withdrawal(t, r)); err != nil || done.State != stateCancelled {
			t.Errorf("%s: %+v %v", input.Kind, done, err)
		}
	}
}

// approvedWfhOn is an approved WFH request of E on fixed dates with its counters, written in SQL.
func (f *requestFixture) approvedWfhOn(t *testing.T, dates ...string) SubmitResult {
	t.Helper()
	id := f.one(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,version,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'wfh','approved',3,'x' FROM gen_random_uuid() g RETURNING id::text`,
		f.employees["E"], f.accounts["E"], f.team)
	for _, d := range dates {
		f.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes) VALUES($1,'wfh',CAST($2 AS date),540,1080,480)`, id, d)
		f.exec(t, `INSERT INTO wfh_month_counter(employee_id,month,approved_count) VALUES($1,date_trunc('month',CAST($2 AS date))::date,1)
        ON CONFLICT (employee_id,month) DO UPDATE SET approved_count=wfh_month_counter.approved_count+1`, f.employees["E"], d)
	}
	return SubmitResult{ID: id, State: stateApproved, Version: "3"}
}

func (f *requestFixture) reopenMonth(t *testing.T, date string) {
	t.Helper()
	f.exec(t, `UPDATE attendance_period SET state='open',version=3,snapshot=NULL,snapshot_hash=NULL WHERE month=date_trunc('month',CAST($1 AS date))::date`, date)
}

// A closed month refuses the cancellation as a whole (409 error.periodClosed) with nothing written; reopened,
// it goes through.
func TestAClosedMonthRefusesTheCancellation(t *testing.T) {
	f := newRequestFixture(t)
	leave := f.approved(t, f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080))
	f.closeMonth(t, f.day(t, 1))
	f.unchanged(t, "closed month", leave.ID, func() {
		if _, _, err := f.cancel(t, "H", f.withdrawal(t, leave)); !rejectedWith(err, "error.periodClosed") {
			t.Errorf("closed month: %v", err)
		}
	})
	f.reopenMonth(t, f.day(t, 1))
	if done, _, err := f.cancel(t, "H", f.withdrawal(t, leave)); err != nil || done.State != stateCancelled {
		t.Errorf("reopened %+v %v", done, err)
	}
	if f.count(t, `SELECT count(*)::text FROM leave_ledger WHERE source_request_id=$1 OR reverses_entry_id IS NOT NULL`, leave.ID) != 2 {
		t.Error("one debit, one reversal")
	}

	spanning := f.approvedWfhOn(t, "2026-03-31", "2026-04-01")
	f.closeMonth(t, "2026-03-31")
	f.unchanged(t, "spanning", spanning.ID, func() {
		if _, _, err := f.cancel(t, "H", f.withdrawal(t, spanning)); !rejectedWith(err, "error.periodClosed") {
			t.Errorf("a closed and an open month: %v", err)
		}
	})
	f.reopenMonth(t, "2026-03-31")
	mustDB(t, func() error { _, _, err := f.cancel(t, "H", f.withdrawal(t, spanning)); return err }())
	if got := f.one(t, `SELECT string_agg(approved_count::text,',' ORDER BY month) FROM wfh_month_counter WHERE employee_id=$1 AND month IN (DATE '2026-03-01',DATE '2026-04-01')`, f.employees["E"]); got != "0,0" {
		t.Errorf("counters %s", got)
	}
}

func TestAnAuditFailureRollsBackTheCancellation(t *testing.T) {
	f := newRequestFixture(t)
	key := f.one(t, newKey)
	for _, input := range []SubmitInput{f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080), f.wfh(t, 2)} {
		r := f.approved(t, input)
		cancel := f.withdrawal(t, r)
		cancel.IdempotencyKey = key
		f.unchanged(t, string(input.Kind), r.ID, func() {
			f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
			_, _, err := f.cancel(t, "H", cancel)
			f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
			if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "42501" {
				t.Errorf("audit failure: %v", err)
			}
		})
		if done, _, err := f.cancel(t, "H", f.withdrawal(t, r)); err != nil || done.State != stateCancelled {
			t.Errorf("after the failure %+v %v", done, err)
		}
	}
	if f.count(t, `SELECT coalesce(sum(approved_count),0)::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != 0 {
		t.Error("counter")
	}
}

func TestAnApprovalReplayedAfterTheCancellationChangesNothing(t *testing.T) {
	f := newRequestFixture(t)
	waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080)), decisionApprove)
	approve := f.verdict(t, waiting, decisionApprove)
	approved, _, err := f.decide(t, "C", approve)
	mustDB(t, err)
	mustDB(t, func() error { _, _, err := f.cancel(t, "H", f.withdrawal(t, approved)); return err }())
	f.unchanged(t, "approval replay", waiting.ID, func() {
		if again, _, err := f.decide(t, "C", approve); err != nil || again != approved {
			t.Errorf("replay %+v %v", again, err)
		}
	})
}

func TestAStrangerAndAnAbsentRequestAreTheSameNotFound(t *testing.T) {
	f := newRequestFixture(t)
	approved := f.approved(t, f.wfh(t, 0))
	for actor, input := range map[string]CancelInput{"O": f.withdrawal(t, approved), "H": f.withdrawal(t, SubmitResult{ID: f.one(t, newKey), Version: "1"})} {
		if _, found, err := f.cancel(t, actor, input); found || err != nil {
			t.Errorf("%s: %v %v", actor, found, err)
		}
	}
}

// Root's replay of a cancellation adds exactly one row naming the request; an IAM replay adds none.
func TestARootCancelReplayIsAuditedOnTheRequest(t *testing.T) {
	f := newRequestFixture(t)
	for actor, want := range map[string]int{"R": 1, "H": 0} {
		r := f.approved(t, f.wfh(t, map[string]int{"R": 0, "H": 1}[actor]))
		input := f.withdrawal(t, r)
		first, _, err := f.cancel(t, actor, input)
		mustDB(t, err)
		rows, targeted := f.count(t, rootRows, f.accounts[actor]), f.count(t, rootTargeted, f.accounts[actor], r.ID)
		f.unchanged(t, actor+" replay", r.ID, func() {
			if again, _, err := f.cancel(t, actor, input); err != nil || again != first {
				t.Errorf("%s replay %+v %v", actor, again, err)
			}
		})
		if f.count(t, rootRows, f.accounts[actor]) != rows+want || f.count(t, rootTargeted, f.accounts[actor], r.ID) != targeted+want {
			t.Errorf("%s replay audits", actor)
		}
	}
}

func (f *requestFixture) cancelLockOrder(t *testing.T, r SubmitResult, second, first string) {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), second, f.employees["E"])
	mustDB(t, err)
	input := f.withdrawal(t, r)
	done := make(chan decided, 1)
	go func() {
		result, found, err := f.service.Cancel(context.Background(), f.sessions["H"], input)
		done <- decided{result, found, err}
	}()
	f.waitBlocked(t, 1)
	_, err = tx.Exec(t.Context(), `SET LOCAL lock_timeout = '50ms'`)
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), first, f.employees["E"])
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "55P03" {
		t.Errorf("%s was free while the cancellation waited on %s: %v", first, second, err)
	}
	mustDB(t, tx.Rollback(t.Context()))
	mustDB(t, (<-done).err)
}

// Lock order of a cancellation: request (Execute) → bucket or WFH counter → period FOR SHARE. Holding the later
// lock, the earlier one must already be taken by the waiting cancellation.
func TestTheCancellationLocksRequestThenBucketOrCounterThenPeriod(t *testing.T) {
	f := newRequestFixture(t)
	period := func(n int) string {
		return `SELECT 1 FROM attendance_period WHERE month = date_trunc('month',DATE '` + f.day(t, n) + `')::date AND $1::uuid IS NOT NULL FOR UPDATE`
	}
	request := func(r SubmitResult) string {
		return `SELECT 1 FROM work_request WHERE id='` + r.ID + `' AND $1::uuid IS NOT NULL FOR UPDATE`
	}
	bucket := `SELECT 1 FROM leave_bucket WHERE employee_id=$1 FOR UPDATE`
	counter := `SELECT 1 FROM wfh_month_counter WHERE employee_id=$1 FOR UPDATE`
	first := f.approved(t, f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780))
	second := f.approved(t, f.leave(t, hrbase.RequestAnnualLeave, 2, 540, 780))
	f.cancelLockOrder(t, first, bucket, request(first))
	f.cancelLockOrder(t, second, period(2), bucket)
	wfh := f.approved(t, f.wfh(t, 3))
	other := f.approved(t, f.wfh(t, 4))
	f.cancelLockOrder(t, wfh, counter, request(wfh))
	f.cancelLockOrder(t, other, period(4), counter)
}

func (f *requestFixture) early(t *testing.T, n, minute int) SubmitInput {
	return SubmitInput{Kind: hrbase.RequestEarlyDeparture, Reason: "x", Date: f.day(t, n), ExpectedMinute: minute}
}
