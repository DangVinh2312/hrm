//go:build integration

package workrequest

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/hrbase"
)

type call = func(context.Context) (SubmitResult, bool, error)

// race holds the rows of hold in a superuser transaction, starts every call and waits until each waits on a
// lock (in order: the n-th call starts once n-1 wait), then commits the holder and returns the outcomes in
// call order.
func (f *requestFixture) race(t *testing.T, hold func(pgx.Tx) error, calls ...call) []decided {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	mustDB(t, hold(tx))
	done := make([]chan decided, len(calls))
	for i, c := range calls {
		done[i] = make(chan decided, 1)
		go func() {
			result, found, err := c(context.Background())
			done[i] <- decided{result, found, err}
		}()
		f.waitBlocked(t, i+1)
	}
	mustDB(t, tx.Commit(t.Context()))
	results := make([]decided, len(calls))
	for i := range results {
		results[i] = <-done[i]
	}
	return results
}

func holding(sql string, args ...any) func(pgx.Tx) error {
	return func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), sql, args...)
		return err
	}
}

func lockRequest(id string) func(pgx.Tx) error {
	return holding(`SELECT 1 FROM work_request WHERE id = $1 FOR UPDATE`, id)
}

func (f *requestFixture) cancelling(actor string, input CancelInput) call {
	return func(ctx context.Context) (SubmitResult, bool, error) {
		return f.service.Cancel(ctx, f.sessions[actor], input)
	}
}

func (f *requestFixture) deciding(actor string, input DecisionInput) call {
	return func(ctx context.Context) (SubmitResult, bool, error) {
		return f.service.Decide(ctx, f.sessions[actor], input)
	}
}

func (f *requestFixture) ledgerOf(t *testing.T, id string) int {
	t.Helper()
	return f.count(t, `SELECT count(*)::text FROM leave_ledger WHERE source_request_id=$1
      OR reverses_entry_id IN (SELECT id FROM leave_ledger WHERE source_request_id=$1)`, id)
}

func TestTwoCancellationsOfOneRequestReverseItOnce(t *testing.T) {
	f := newRequestFixture(t)
	leave := f.approved(t, f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080))
	results := f.race(t, lockRequest(leave.ID), f.cancelling("H", f.withdrawal(t, leave)), f.cancelling("H", f.withdrawal(t, leave)))
	stale := 0
	for _, r := range results {
		if conflict(r.err) {
			stale++
		} else {
			mustDB(t, r.err)
		}
	}
	if stale != 1 || f.ledgerOf(t, leave.ID) != 2 || f.count(t, `SELECT count(*)::text FROM request_decision WHERE request_id=$1 AND stage='cancel'`, leave.ID) != 1 {
		t.Errorf("%d stale, %d ledger rows", stale, f.ledgerOf(t, leave.ID))
	}
	wfh := f.approved(t, f.wfh(t, 2))
	input := f.withdrawal(t, wfh)
	results = f.race(t, lockRequest(wfh.ID), f.cancelling("H", input), f.cancelling("H", input))
	if results[0].err != nil || results[1].err != nil || results[0].result != results[1].result || results[0].result.State != stateCancelled {
		t.Errorf("one key twice %+v", results)
	}
	if f.count(t, `SELECT coalesce(sum(approved_count),0)::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != 0 {
		t.Error("the counter went down twice or not at all")
	}
}

func TestARootCancellationRacingItsReplayAuditsTheLockedRequest(t *testing.T) {
	f := newRequestFixture(t)
	r := f.approved(t, f.wfh(t, 0))
	input := f.withdrawal(t, r)
	results := f.race(t, lockRequest(r.ID), f.cancelling("R", input), f.cancelling("R", input))
	for _, result := range results {
		mustDB(t, result.err)
		if !result.found || result.result != results[0].result || result.result.State != stateCancelled {
			t.Errorf("Root cancel replay: %+v", results)
		}
	}
	if f.count(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1
      AND event_kind=convert_to('access.workRequest.cancelApproved','UTF8')
      AND safe_metadata->>'key'=$2`, f.accounts["R"], r.ID) != 1 {
		t.Error("the replay in the command did not audit its target")
	}
	if f.count(t, `SELECT approved_count::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != 0 {
		t.Error("Root replay changed the counter")
	}
}

// Whoever takes the request lock first wins: the owner's cancel leaves the COO nothing readable (404), the
// COO's approval makes the cancel a stale version.
func TestAPendingCancelRacingTheFinalApproval(t *testing.T) {
	f := newRequestFixture(t)
	decisions := `SELECT count(*) FILTER (WHERE stage='final')||'|'||count(*) FILTER (WHERE stage='cancel') FROM request_decision WHERE request_id=$1`
	waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080)), decisionApprove)
	cancel := CancelInput{RequestID: waiting.ID, IdempotencyKey: f.one(t, newKey), ExpectedVersion: waiting.Version}
	results := f.race(t, lockRequest(waiting.ID), f.cancelling("E", cancel), f.deciding("C", f.verdict(t, waiting, decisionApprove)))
	if results[0].err != nil || results[0].result.State != stateCancelled || results[1].err != nil || results[1].found {
		t.Errorf("cancel first %+v", results)
	}
	if f.ledgerOf(t, waiting.ID) != 0 || f.one(t, decisions, waiting.ID) != "0|1" {
		t.Error("cancel first wrote a debit or a final decision")
	}
	waiting = f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 2, 540, 1080)), decisionApprove)
	cancel = CancelInput{RequestID: waiting.ID, IdempotencyKey: f.one(t, newKey), ExpectedVersion: waiting.Version}
	results = f.race(t, lockRequest(waiting.ID), f.deciding("C", f.verdict(t, waiting, decisionApprove)), f.cancelling("E", cancel))
	if results[0].err != nil || results[0].result.State != stateApproved || !conflict(results[1].err) {
		t.Errorf("approval first %+v", results)
	}
	if f.ledgerOf(t, waiting.ID) != 1 || f.one(t, decisions, waiting.ID) != "1|0" {
		t.Error("approval first: one debit, no cancel")
	}
}

// sameMonth is two fixture days of one month.
func (f *requestFixture) sameMonth(t *testing.T) []int {
	t.Helper()
	if f.day(t, 0)[:7] == f.day(t, 1)[:7] {
		return []int{0, 1}
	}
	return []int{3, 4}
}

// Two approvals for the last WFH day of the month: one is approved, the other needs the acknowledgement; and
// two first approvals of a month with no counter row yet make one row counting both.
func TestWfhApprovalsRacingForTheCounter(t *testing.T) {
	f := newRequestFixture(t)
	f.setting(t, "hr.wfhMonthLimit", 1)
	days := f.sameMonth(t)
	month := f.day(t, days[0])[:7] + "-01"
	one := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, days[0])), decisionApprove)
	two := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, days[1])), decisionApprove)
	f.exec(t, `INSERT INTO wfh_month_counter(employee_id,month) VALUES($1,CAST($2 AS date))`, f.employees["E"], month)
	results := f.race(t, holding(`SELECT 1 FROM wfh_month_counter WHERE employee_id=$1 FOR UPDATE`, f.employees["E"]),
		f.deciding("C", f.verdict(t, one, decisionApprove)), f.deciding("C", f.verdict(t, two, decisionApprove)))
	limited := 0
	for _, r := range results {
		if rejectedWith(r.err, "error.wfhLimitAckRequired") {
			limited++
		} else {
			mustDB(t, r.err)
		}
	}
	if limited != 1 || f.count(t, `SELECT approved_count::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != 1 {
		t.Errorf("%d asked to acknowledge", limited)
	}

	g := newRequestFixture(t)
	days = g.sameMonth(t)
	one = g.mustDecide(t, "L", g.mustSubmit(t, "E", g.wfh(t, days[0])), decisionApprove)
	two = g.mustDecide(t, "L", g.mustSubmit(t, "E", g.wfh(t, days[1])), decisionApprove)
	results = g.race(t, holding(`INSERT INTO wfh_month_counter(employee_id,month) VALUES($1,date_trunc('month',CAST($2 AS date))::date)`, g.employees["E"], g.day(t, days[0])),
		g.deciding("C", g.verdict(t, one, decisionApprove)), g.deciding("C", g.verdict(t, two, decisionApprove)))
	for _, r := range results {
		mustDB(t, r.err)
	}
	if g.one(t, `SELECT count(*)||'|'||sum(approved_count) FROM wfh_month_counter WHERE employee_id=$1`, g.employees["E"]) != "1|2" {
		t.Error("one counter row counting both")
	}
}

func TestFinalWfhDecisionsRacingLeaveOneDecisionAndItsCounter(t *testing.T) {
	f := newRequestFixture(t)
	for day, first := range []string{decisionApprove, decisionReject} {
		waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, day)), decisionApprove)
		before := f.count(t, `SELECT coalesce(sum(approved_count),0)::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"])
		results := f.race(t, lockRequest(waiting.ID),
			f.deciding("C", f.verdict(t, waiting, first)), f.deciding("C", f.verdict(t, waiting, decisionApprove)))
		stale := 0
		for _, result := range results {
			if conflict(result.err) {
				stale++
			} else {
				mustDB(t, result.err)
				if !result.found || (result.result.State != stateApproved && result.result.State != stateRejected) {
					t.Errorf("final decision: %+v", result)
				}
			}
		}
		if stale != 1 || f.count(t, `SELECT count(*)::text FROM request_decision WHERE request_id=$1 AND stage='final'`, waiting.ID) != 1 {
			t.Errorf("%s: %d stale decisions", first, stale)
		}
		state := f.one(t, `SELECT state FROM work_request WHERE id=$1`, waiting.ID)
		want := before
		if state == stateApproved {
			want++
		}
		if got := f.count(t, `SELECT coalesce(sum(approved_count),0)::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]); got != want {
			t.Errorf("%s: counter %d, want %d for %s", first, got, want, state)
		}
		if got := f.one(t, `SELECT decision FROM request_decision WHERE request_id=$1 AND stage='final'`, waiting.ID); (got == decisionApprove) != (state == stateApproved) {
			t.Errorf("final decision %s disagrees with state %s", got, state)
		}
	}
}

// Two approvals for the last minutes serialize on a bucket that does not exist yet: one debit, the other 409;
// a submit meeting a decision for the last minutes is refused before and after its commit.
func TestLeaveApprovalsRacingForTheLastMinutes(t *testing.T) {
	f := newRequestFixture(t)
	days := f.sameMonth(t)
	first := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, days[0], 540, 1080)), decisionApprove)
	second := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, days[1], 540, 1080)), decisionApprove)
	year := f.day(t, days[0])[:4]
	f.entitled(t, f.day(t, days[0]), 480)
	if f.count(t, `SELECT count(*)::text FROM leave_bucket WHERE employee_id=$1`, f.employees["E"]) != 0 {
		t.Fatal("the bucket exists before the race")
	}
	results := f.race(t, holding(`INSERT INTO leave_bucket(employee_id,year) VALUES($1,CAST($2 AS int))`, f.employees["E"], year),
		f.deciding("C", f.verdict(t, first, decisionApprove)), f.deciding("C", f.verdict(t, second, decisionApprove)))
	refused := 0
	for i, r := range results {
		if conflict(r.err) {
			refused++
			if result := f.mustDecide(t, "C", []SubmitResult{first, second}[i], decisionReject); result.State != stateRejected {
				t.Errorf("reject after insufficient leave: %+v", result)
			}
		} else {
			mustDB(t, r.err)
		}
	}
	if refused != 1 || f.count(t, `SELECT count(*)::text FROM leave_ledger WHERE employee_id=$1 AND entry_kind='debit'`, f.employees["E"]) != 1 {
		t.Errorf("%d refused", refused)
	}
}

// entitled sets E's entitlement at the end of date's month to minutes (official all year at 5760, 480 a
// month) with an adjustment dated January 2.
func (f *requestFixture) entitled(t *testing.T, date string, minutes int) {
	t.Helper()
	f.exec(t, `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,reference)
      VALUES(gen_random_uuid(),$1,'adjustment',make_date(extract(year FROM CAST($2 AS date))::int,1,2),
             $3 - 480*extract(month FROM CAST($2 AS date))::int,'test')`, f.employees["E"], date, minutes)
}

func TestASubmitMeetingADecisionNeverOversubscribes(t *testing.T) {
	f := newRequestFixture(t)
	days := f.sameMonth(t)
	waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, days[0], 540, 1080)), decisionApprove)
	f.entitled(t, f.day(t, days[0]), 480)
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	mustDB(t, lockRequest(waiting.ID)(tx))
	approve := f.verdict(t, waiting, decisionApprove)
	done := make(chan decided, 1)
	go func() {
		result, found, err := f.service.Decide(context.Background(), f.sessions["C"], approve)
		done <- decided{result, found, err}
	}()
	f.waitBlocked(t, 1)
	_, err = f.submit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, days[1], 540, 1080))
	mustDB(t, tx.Commit(t.Context()))
	if !rejectedWith(err, "error.insufficientLeave") {
		t.Errorf("a submit beside a pending decision: %v", err)
	}
	if r := <-done; r.err != nil || r.result.State != stateApproved {
		t.Errorf("decision %+v", r)
	}
	if _, err := f.submit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, days[1], 540, 1080)); !rejectedWith(err, "error.insufficientLeave") {
		t.Errorf("a submit after the decision: %v", err)
	}
}

func TestTwoSubmitsRacingForTheLastMinutesReserveThemOnce(t *testing.T) {
	f := newRequestFixture(t)
	days := f.sameMonth(t)
	f.entitled(t, f.day(t, days[0]), 480)
	inputs := []SubmitInput{
		f.leave(t, hrbase.RequestAnnualLeave, days[0], 540, 1080),
		f.leave(t, hrbase.RequestAnnualLeave, days[1], 540, 1080),
	}
	calls := make([]call, len(inputs))
	for i, input := range inputs {
		input.IdempotencyKey = f.one(t, newKey)
		calls[i] = func(ctx context.Context) (SubmitResult, bool, error) {
			result, err := f.service.Submit(ctx, f.sessions["E"], input)
			return result, err == nil, err
		}
	}
	results := f.race(t, holding(`SELECT 1 FROM employee WHERE id=$1 FOR UPDATE`, f.employees["E"]), calls...)
	refused, submitted := 0, 0
	for _, result := range results {
		if rejectedWith(result.err, "error.insufficientLeave") {
			refused++
		} else {
			mustDB(t, result.err)
			if result.found && result.result.State == statePendingLead {
				submitted++
			}
		}
	}
	if refused != 1 || submitted != 1 || f.count(t, `SELECT count(*)::text FROM work_request WHERE employee_id=$1`, f.employees["E"]) != 1 {
		t.Errorf("%d refused, %d submitted: %+v", refused, submitted, results)
	}
}

// The leave part runs first, then the closed month refuses: the debit and the new bucket are undone.
func TestAClosedMonthAfterTheDebitUndoesTheDebitAndTheBucket(t *testing.T) {
	f := newRequestFixture(t)
	waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 1080)), decisionApprove)
	f.closeMonth(t, f.day(t, 1))
	f.unchanged(t, "closed month", waiting.ID, func() {
		if _, _, err := f.decide(t, "C", f.verdict(t, waiting, decisionApprove)); !rejectedWith(err, "error.periodClosed") {
			t.Errorf("closed month: %v", err)
		}
	})
	if f.count(t, `SELECT count(*)::text FROM leave_bucket WHERE employee_id=$1`, f.employees["E"]) != 0 {
		t.Error("the new bucket survived")
	}
	f.reopenMonth(t, f.day(t, 1))
	if done := f.mustDecide(t, "C", waiting, decisionApprove); done.State != stateApproved || f.ledgerOf(t, waiting.ID) != 1 {
		t.Errorf("reopened %+v", done)
	}
}

func TestAnAuditFailureAfterApprovalEffectsUndoesEverything(t *testing.T) {
	f := newRequestFixture(t)
	for _, input := range []SubmitInput{f.leave(t, hrbase.RequestAnnualLeave, 0, 540, 1080), f.wfh(t, 1)} {
		waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", input), decisionApprove)
		approve := f.verdict(t, waiting, decisionApprove)
		f.unchanged(t, string(input.Kind), waiting.ID, func() {
			f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
			_, _, err := f.decide(t, "C", approve)
			f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
			if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "42501" {
				t.Errorf("audit failure: %v", err)
			}
		})
		result := f.mustDecideInput(t, "C", approve)
		if result.State != stateApproved {
			t.Errorf("retry: %+v", result)
		}
		f.unchanged(t, "approval replay", waiting.ID, func() {
			if again := f.mustDecideInput(t, "C", approve); again != result {
				t.Errorf("replay: %+v", again)
			}
		})
	}
	if f.count(t, `SELECT count(*)::text FROM leave_ledger WHERE employee_id=$1 AND entry_kind='debit'`, f.employees["E"]) != 1 ||
		f.count(t, `SELECT approved_count::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != 1 {
		t.Error("one debit and one WFH day after retry and replay")
	}
}

func TestAnApprovalUsesTheYearAndTheStatusOfEachLeaveDate(t *testing.T) {
	f := newRequestFixture(t)
	requestOn := func(date string) SubmitResult {
		id := f.one(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
          SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'annual-leave','pending_lead','x'
            FROM gen_random_uuid() g RETURNING id::text`, f.employees["E"], f.accounts["E"], f.team)
		f.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
          VALUES($1,'annual-leave',CAST($2 AS date),540,1080,480)`, id, date)
		return f.mustDecide(t, "L", SubmitResult{ID: id, State: statePendingLead, Version: "1"}, decisionApprove)
	}
	waiting := requestOn("2027-01-12")
	if result := f.mustDecide(t, "C", waiting, decisionApprove); result.State != stateApproved {
		t.Errorf("January approval: %+v", result)
	}
	if got := f.one(t, `SELECT string_agg(year::text,',' ORDER BY year) FROM leave_bucket WHERE employee_id=$1`, f.employees["E"]); got != "2027" {
		t.Errorf("buckets: %s", got)
	}
	if got := f.one(t, `SELECT coalesce(sum(minutes) FILTER (WHERE effective_on < DATE '2027-01-01'),0)||'|'||sum(minutes) FILTER (WHERE effective_on >= DATE '2027-01-01')
      FROM leave_ledger WHERE employee_id=$1 AND entry_kind='debit'`, f.employees["E"]); got != "0|480" {
		t.Errorf("debits by year: %s", got)
	}
	f.exec(t, `UPDATE employment_status_period SET starts_on=DATE '2026-09-01' WHERE employee_id=$1`, f.employees["E"])
	f.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on,ends_on)
      VALUES(gen_random_uuid(),$1,'probation',DATE '2020-01-06',DATE '2026-09-01')`, f.employees["E"])
	waiting = requestOn("2026-08-05")
	f.unchanged(t, "probation date", waiting.ID, func() {
		if _, _, err := f.decide(t, "C", f.verdict(t, waiting, decisionApprove)); !conflict(err) {
			t.Errorf("probation date: %v", err)
		}
	})
}

// An approval racing the revocation of the approver's role: the effect exists exactly when the approval did.
func TestAnApprovalRacingTheRevocationOfItsRole(t *testing.T) {
	f := newRequestFixture(t)
	for _, n := range []int{0, 1} {
		if n > 0 {
			f.role(t, "C", "hr.coo", true)
		}
		waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, n)), decisionApprove)
		approve := f.verdict(t, waiting, decisionApprove)
		done := make(chan decided, 1)
		go func() {
			result, found, err := f.service.Decide(context.Background(), f.sessions["C"], approve)
			done <- decided{result, found, err}
		}()
		f.role(t, "C", "hr.coo", false)
		r := <-done
		if r.err != nil {
			t.Fatalf("a lost race is a 404, never an error: %v", r.err)
		}
		counted := f.count(t, `SELECT count(*)::text FROM wfh_month_counter c JOIN work_request_segment s ON c.month=date_trunc('month',s.work_date)
        WHERE s.request_id=$1 AND c.employee_id=$2 AND c.approved_count>0`, waiting.ID, f.employees["E"]) > 0
		if r.found != (r.result.State == stateApproved) || (r.found && !counted) || (!r.found && f.one(t, `SELECT state FROM work_request WHERE id=$1`, waiting.ID) != statePendingFinal) {
			t.Errorf("approval %+v, counted %v", r, counted)
		}
	}
}

// A first attempt that times out behind a lock leaves nothing; the retry with the key is a clean first
// attempt, and its replay adds nothing.
func TestARetryAfterALockTimeoutIsACleanFirstAttempt(t *testing.T) {
	f := newRequestFixture(t)
	waiting := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, 0)), decisionApprove)
	input := f.verdict(t, waiting, decisionApprove)
	f.unchanged(t, "timed out", waiting.ID, func() {
		holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
		mustDB(t, err)
		defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
		tx, err := holder.Begin(t.Context())
		mustDB(t, err)
		mustDB(t, holding(`INSERT INTO wfh_month_counter(employee_id,month) VALUES($1,date_trunc('month',CAST($2 AS date))::date)`, f.employees["E"], f.day(t, 0))(tx))
		_, _, err = f.decide(t, "C", input)
		mustDB(t, tx.Rollback(t.Context()))
		if err == nil || errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("the first attempt did not time out: %v", err)
		}
	})
	result := f.mustDecideInput(t, "C", input)
	if again := f.mustDecideInput(t, "C", input); again != result || f.count(t, `SELECT approved_count::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != 1 {
		t.Errorf("retry %+v, replay %+v", result, again)
	}
}

func (f *requestFixture) mustDecideInput(t *testing.T, actor string, input DecisionInput) SubmitResult {
	t.Helper()
	result, found, err := f.decide(t, actor, input)
	mustDB(t, err)
	if !found {
		t.Fatal("not found")
	}
	return result
}
