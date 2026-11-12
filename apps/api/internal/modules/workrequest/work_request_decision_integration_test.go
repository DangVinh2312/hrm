//go:build integration

package workrequest

import (
	"context"
	"encoding/json/v2"
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/hrbase"
)

// verdict is a decision on r at its version under a new key; a reject carries a reason.
func (f *requestFixture) verdict(t *testing.T, r SubmitResult, decision string) DecisionInput {
	t.Helper()
	input := DecisionInput{RequestID: r.ID, IdempotencyKey: f.one(t, newKey), ExpectedVersion: r.Version, Decision: decision}
	if decision == decisionReject {
		reason := "x"
		input.Reason = &reason
	}
	return input
}

func (f *requestFixture) decide(t *testing.T, actor string, input DecisionInput) (SubmitResult, bool, error) {
	t.Helper()
	return f.service.Decide(t.Context(), f.sessions[actor], input)
}

func (f *requestFixture) mustDecide(t *testing.T, actor string, r SubmitResult, decision string) SubmitResult {
	t.Helper()
	result, found, err := f.decide(t, actor, f.verdict(t, r, decision))
	mustDB(t, err)
	if !found {
		t.Fatalf("%s %s %s: not found", actor, decision, r.ID)
	}
	return result
}

func (f *requestFixture) queue(t *testing.T, actor string, s stage) ApprovalView {
	t.Helper()
	read := f.service.LeadQueue
	if s == stageFinal {
		read = f.service.FinalQueue
	}
	view, err := read(t.Context(), f.sessions[actor], ListQuery{Limit: 100})
	mustDB(t, err)
	return view
}

func queued(view ApprovalView, id string) bool {
	return slices.ContainsFunc(view.Items, func(item ApprovalItem) bool { return item.ID == id })
}

func (f *requestFixture) role(t *testing.T, actor, role string, grant bool) {
	t.Helper()
	if grant {
		f.exec(t, `INSERT INTO user_role(user_id,role_key) VALUES($1,convert_to($2,'UTF8'))`, f.accounts[actor], role)
		return
	}
	f.exec(t, `DELETE FROM user_role WHERE user_id=$1 AND role_key=convert_to($2,'UTF8')`, f.accounts[actor], role)
}

// lead makes name the only current lead of the fixture's team.
func (f *requestFixture) lead(t *testing.T, name string) {
	t.Helper()
	f.exec(t, `UPDATE team_lead_assignment SET ends_at=statement_timestamp() WHERE team_id=$1 AND ends_at IS NULL`, f.team)
	f.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp())`, f.team, f.employees[name])
}

func TestTheLeadThenTheCooApproveWithTheEffects(t *testing.T) {
	f := newRequestFixture(t)
	wfh := f.mustSubmit(t, "E", f.wfh(t, 0))
	if view := f.queue(t, "L", stageLead); !queued(view, wfh.ID) || view.Items[0].EmployeeID != f.employees["E"] {
		t.Fatalf("lead queue %+v", view)
	}
	input := f.verdict(t, wfh, decisionApprove)
	reason := text(0x110, 0x1ed3, 'n', 'g', ' ', 0xfd)
	input.Reason = &reason
	before := f.one(t, requestState)
	moved, found, err := f.decide(t, "L", input)
	if err != nil || !found || moved != (SubmitResult{ID: wfh.ID, State: statePendingFinal, Version: "2"}) {
		t.Fatalf("lead approval %+v %v %v", moved, found, err)
	}
	if got := f.one(t, `SELECT concat_ws('|',stage,decision,actor_kind,actor_account_id,reason) FROM request_decision WHERE request_id=$1`, wfh.ID); got != "lead|approve|user|"+f.accounts["L"]+"|"+reason {
		t.Errorf("decision %s", got)
	}
	if f.audits(t, "hr.request.decide-lead") != 1 || f.count(t, `SELECT count(*)::text FROM hr_idempotency WHERE operation='workRequest.decide'`) != 1 || f.one(t, requestState) == before {
		t.Error("one audit and one claim")
	}
	if payload := f.one(t, `SELECT string_agg(row_to_json(a)::text,'') FROM audit_outbox a WHERE convert_from(event_kind,'UTF8')='hr.request.decide-lead'`); !strings.Contains(payload, wfh.ID) || strings.Contains(payload, reason) {
		t.Errorf("audit payload %s", payload)
	}
	if queued(f.queue(t, "L", stageLead), wfh.ID) || !queued(f.queue(t, "C", stageFinal), wfh.ID) {
		t.Error("the request did not move from the lead's queue to the COO's")
	}
	view, _, err := f.service.Detail(t.Context(), f.sessions["E"], wfh.ID)
	mustDB(t, err)
	if len(view.Decisions) != 1 || view.Decisions[0].Reason == nil || *view.Decisions[0].Reason != reason {
		t.Errorf("owner's history %+v", view.Decisions)
	}
	if done := f.mustDecide(t, "C", moved, decisionApprove); done.State != stateApproved || done.Version != "3" {
		t.Errorf("final %+v", done)
	}
	if f.count(t, `SELECT coalesce(sum(approved_count),0)::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["E"]) != 1 || f.audits(t, "hr.request.decide-final") != 1 {
		t.Error("wfh counter and final audit")
	}
	leave := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780)), decisionApprove)
	f.mustDecide(t, "C", leave, decisionApprove)
	if f.count(t, `SELECT count(*)::text FROM leave_ledger WHERE source_request_id=$1 AND entry_kind='debit' AND minutes=240`, leave.ID) != 1 {
		t.Error("leave debit")
	}
	// Late and early only need the lead: the lead's approval is final.
	if late := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.late(t, 2, 600)), decisionApprove); late.State != stateApproved {
		t.Errorf("late %+v", late)
	}
}

func TestOnlyTheCurrentApproverDecidesAndRootNeverSkipsTheLead(t *testing.T) {
	f := newRequestFixture(t)
	request := f.mustSubmit(t, "E", f.wfh(t, 0))
	// Root's read of the request is audited; nothing else is written.
	before := f.one(t, decisionState)
	for _, actor := range []string{"C", "O", "N", "H"} {
		for _, decision := range []string{decisionApprove, decisionReject} {
			if _, found, err := f.decide(t, actor, f.verdict(t, request, decision)); found || err != nil {
				t.Errorf("%s %s: %v %v", actor, decision, found, err)
			}
		}
	}
	if _, _, err := f.decide(t, "R", f.verdict(t, request, decisionApprove)); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("Root skipped the lead: %v", err)
	}
	stale := f.verdict(t, request, decisionApprove)
	stale.ExpectedVersion = "2"
	if _, _, err := f.decide(t, "L", stale); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("stale version: %v", err)
	}
	if after := f.one(t, decisionState); after != before {
		t.Errorf("refusals wrote %s -> %s", before, after)
	}
	moved := f.mustDecide(t, "L", request, decisionApprove)
	if _, found, err := f.decide(t, "L", f.verdict(t, moved, decisionApprove)); found || err != nil {
		t.Errorf("the lead decided the final stage: %v %v", found, err)
	}
	if done := f.mustDecide(t, "R", moved, decisionReject); done.State != stateRejected {
		t.Errorf("Root final reject %+v", done)
	}
	other := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, 1)), decisionReject)
	for _, decision := range []string{decisionApprove, decisionReject} {
		if _, _, err := f.decide(t, "L", f.verdict(t, other, decision)); !errors.Is(err, apperror.ErrCommandRejected) {
			t.Errorf("rejected is terminal: %v", err)
		}
	}
	if _, found, err := f.decide(t, "C", f.verdict(t, other, decisionApprove)); found || err != nil {
		t.Errorf("the COO decided a request it never read: %v %v", found, err)
	}
}

func TestNobodyDecidesTheirOwnRequest(t *testing.T) {
	f := newRequestFixture(t)
	request := f.mustSubmit(t, "E", f.wfh(t, 0))
	f.lead(t, "E")
	before := f.one(t, requestState)
	for _, decision := range []string{decisionApprove, decisionReject} {
		if _, _, err := f.decide(t, "E", f.verdict(t, request, decision)); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("own %s: %v", decision, err)
		}
	}
	if _, found, err := f.decide(t, "L", f.verdict(t, request, decisionApprove)); found || err != nil {
		t.Errorf("the former lead kept the step: %v %v", found, err)
	}
	if queued(f.queue(t, "E", stageLead), request.ID) || f.one(t, requestState) != before {
		t.Error("own request queued or written")
	}
	f.lead(t, "L")
	own := f.mustSubmit(t, "L", f.wfh(t, 1))
	f.role(t, "L", "hr.coo", true)
	if _, _, err := f.decide(t, "L", f.verdict(t, own, decisionReject)); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("a lead turned COO decided its own: %v", err)
	}
	if queued(f.queue(t, "L", stageFinal), own.ID) || !queued(f.queue(t, "C", stageFinal), own.ID) {
		t.Error("the final queue holds the caller's own request")
	}
}

// A decision without its acknowledgement and the same one with it hash differently; the replay rechecks a
// current read of the request; another payload or request under the key is refused.
func TestADecisionReplaysItsKeyAndRefusesAnotherPayload(t *testing.T) {
	f := newRequestFixture(t)
	request := f.mustSubmit(t, "E", f.wfh(t, 0))
	input := f.verdict(t, request, decisionApprove)
	first, _, err := f.decide(t, "L", input)
	mustDB(t, err)
	before := f.one(t, requestState)
	if again, found, err := f.decide(t, "L", input); err != nil || !found || again != first {
		t.Errorf("replay %+v %v %v", again, found, err)
	}
	reason := text('K', 'h', 0xe1, 'c')
	for name, edit := range map[string]func(*DecisionInput){
		"reason": func(d *DecisionInput) { d.Reason = &reason },
		"reject": func(d *DecisionInput) { d.Decision, d.Reason = decisionReject, &reason },
		"ack":    func(d *DecisionInput) { d.AcknowledgeWfhLimit = true },
	} {
		other := input
		edit(&other)
		if _, _, err := f.decide(t, "L", other); !rejectedWith(err, "error.idempotencyKeyReused") {
			t.Errorf("%s under the key: %v", name, err)
		}
	}
	second := f.mustSubmit(t, "E", f.wfh(t, 1))
	reused := f.verdict(t, second, decisionApprove)
	reused.IdempotencyKey = input.IdempotencyKey
	if _, _, err := f.decide(t, "L", reused); !rejectedWith(err, "error.idempotencyKeyReused") {
		t.Errorf("another request under the key: %v", err)
	}
	f.mustDecide(t, "L", second, decisionApprove)
	f.role(t, "L", "hr.employee", false)
	if _, found, err := f.decide(t, "L", input); found || err != nil {
		t.Errorf("a revoked approver replayed: %v %v", found, err)
	}
	f.role(t, "L", "hr.employee", true)
	if again, _, err := f.decide(t, "L", input); err != nil || again != first {
		t.Errorf("replay after the grant came back %+v %v", again, err)
	}
	if f.count(t, `SELECT count(*)::text FROM request_decision WHERE request_id=$1`, request.ID) != 1 || f.one(t, `SELECT state||version FROM work_request WHERE id=$1`, request.ID) != "pending_final2" {
		t.Errorf("replays moved the request: %s", before)
	}
}

const (
	// decisionState is every row a decision writes but the audit.
	decisionState = `SELECT concat_ws('|', (SELECT coalesce(sum(version),0) FROM work_request), (SELECT count(*) FROM request_decision),
      (SELECT count(*) FROM hr_idempotency), (SELECT count(*) FROM leave_ledger), (SELECT coalesce(sum(approved_count),0) FROM wfh_month_counter))`
	rootRows     = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1`
	rootTargeted = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND object_id IS NULL
      AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok' AND safe_metadata->>'key'=$2`
)

// Root's replay adds exactly one row, an access naming the request; an IAM replay adds none.
func TestARootReplayIsAuditedOnTheRequestAndAnIAMReplayIsNot(t *testing.T) {
	f := newRequestFixture(t)
	request := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, 0)), decisionApprove)
	input := f.verdict(t, request, decisionReject)
	first, _, err := f.decide(t, "R", input)
	mustDB(t, err)
	rows, targeted := f.count(t, rootRows, f.accounts["R"]), f.count(t, rootTargeted, f.accounts["R"], request.ID)
	state := f.one(t, decisionState)
	if again, _, err := f.decide(t, "R", input); err != nil || again != first {
		t.Fatalf("Root replay %+v %v", again, err)
	}
	if f.count(t, rootRows, f.accounts["R"]) != rows+1 || f.count(t, rootTargeted, f.accounts["R"], request.ID) != targeted+1 {
		t.Errorf("Root replay audits %d/%d -> %s/%s", rows, targeted, f.one(t, rootRows, f.accounts["R"]), f.one(t, rootTargeted, f.accounts["R"], request.ID))
	}
	if f.count(t, `SELECT count(*)::text FROM work_request WHERE id=$1 AND state='rejected' AND version=3`, request.ID) != 1 {
		t.Error("Root's decision")
	}
	if after := f.one(t, decisionState); after != state {
		t.Errorf("Root replay wrote %s -> %s", state, after)
	}
	iam := f.verdict(t, f.mustSubmit(t, "E", f.wfh(t, 1)), decisionApprove)
	mustDB(t, func() error { _, _, err := f.decide(t, "L", iam); return err }())
	state = f.one(t, requestState)
	if _, _, err := f.decide(t, "L", iam); err != nil || f.one(t, requestState) != state {
		t.Errorf("an IAM replay wrote: %v", err)
	}
}

// refusedFinal wants the COO's approval of r refused with nothing written.
func (f *requestFixture) refusedFinal(t *testing.T, name string, r SubmitResult, input DecisionInput, refused func(error) bool) {
	t.Helper()
	before := f.one(t, requestState)
	if _, _, err := f.decide(t, "C", input); !refused(err) {
		t.Errorf("%s: %v", name, err)
	}
	if after := f.one(t, requestState); after != before {
		t.Errorf("%s wrote %s -> %s", name, before, after)
	}
	if f.one(t, `SELECT state||version FROM work_request WHERE id=$1`, r.ID) != statePendingFinal+r.Version {
		t.Errorf("%s moved the request", name)
	}
}

// The effects of an approval refuse it with nothing written: a closed month, a day off the official status
// or past the entitlement (409 error.conflict, no reason told, as in TypeScript), a WFH month past the limit
// without the approver's acknowledgement.
func TestAnApprovalIsRefusedByItsEffectsWithNothingWritten(t *testing.T) {
	f := newRequestFixture(t)
	conflict := func(err error) bool { return errors.Is(err, apperror.ErrCommandRejected) }
	closed := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, 0)), decisionApprove)
	leave := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780)), decisionApprove)
	f.exec(t, `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,reference)
      VALUES(gen_random_uuid(),$1,'adjustment',date_trunc('year',CAST($2 AS date))::date,-175680,'test')`, f.employees["E"], f.day(t, 1))
	f.refusedFinal(t, "past the entitlement", leave, f.verdict(t, leave, decisionApprove), conflict)
	f.exec(t, `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,reference)
      VALUES(gen_random_uuid(),$1,'adjustment',date_trunc('year',CAST($2 AS date))::date,175680,'test')`, f.employees["E"], f.day(t, 1))
	f.exec(t, `UPDATE employment_status_period SET status='probation' WHERE employee_id=$1`, f.employees["E"])
	f.refusedFinal(t, "not official", leave, f.verdict(t, leave, decisionApprove), conflict)
	f.exec(t, `UPDATE employment_status_period SET status='official' WHERE employee_id=$1`, f.employees["E"])
	if done := f.mustDecide(t, "C", leave, decisionApprove); done.State != stateApproved {
		t.Errorf("leave %+v", done)
	}
	f.closeMonth(t, f.day(t, 0))
	f.refusedFinal(t, "closed month", closed, f.verdict(t, closed, decisionApprove), func(err error) bool { return rejectedWith(err, "error.periodClosed") })

	g := newRequestFixture(t)
	g.setting(t, "hr.wfhMonthLimit", 1)
	pair := []int{0, 1}
	if g.day(t, 0)[:7] != g.day(t, 1)[:7] {
		pair = []int{3, 4}
	}
	wfh := g.mustDecide(t, "L", g.mustSubmit(t, "E", g.wfh(t, pair...)), decisionApprove)
	input := g.verdict(t, wfh, decisionApprove)
	g.refusedFinal(t, "past the WFH limit", wfh, input, func(err error) bool { return rejectedWith(err, "error.wfhLimitAckRequired") })
	acknowledged := input
	acknowledged.AcknowledgeWfhLimit = true
	if done, _, err := g.decide(t, "C", acknowledged); err != nil || done.State != stateApproved {
		t.Errorf("acknowledged %+v %v", done, err)
	}
	if _, _, err := g.decide(t, "C", input); !rejectedWith(err, "error.idempotencyKeyReused") {
		t.Errorf("the acknowledgement is not in the hash: %v", err)
	}
}

// A registry without the leave part keeps annual leave closed at the final approval; a reject and the
// other kinds still work.
func TestAKindWithoutItsEffectHandlerIsNeverApproved(t *testing.T) {
	f := newRequestFixtureWith(t, ApprovedEffects{Wfh: createApprovedEffects().Wfh, Attendance: createApprovedEffects().Attendance})
	leave := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780)), decisionApprove)
	f.refusedFinal(t, "no leave handler", leave, f.verdict(t, leave, decisionApprove), func(err error) bool { return errors.Is(err, apperror.ErrCommandRejected) })
	if done := f.mustDecide(t, "C", leave, decisionReject); done.State != stateRejected {
		t.Errorf("reject %+v", done)
	}
	if done := f.mustDecide(t, "C", f.mustDecide(t, "L", f.mustSubmit(t, "E", f.wfh(t, 2)), decisionApprove), decisionApprove); done.State != stateApproved {
		t.Errorf("wfh %+v", done)
	}
}

// D-04, D-06, D-08: a submit and a rejection write no WFH counter; an approval counts every day of the request in
// the month of that day, so a request across a month edge is two counters of one, and three days of one month are
// three; two more pass the limit of 4 and wait for the acknowledgement.
func TestAnApprovalCountsEachWfhDayInTheMonthOfThatDay(t *testing.T) {
	f := newRequestFixture(t)
	counters := func(name string) string {
		return f.one(t, `SELECT coalesce(string_agg(to_char(month,'YYYY-MM')||'='||approved_count, ',' ORDER BY month), '')
      FROM wfh_month_counter WHERE employee_id=$1`, f.employees[name])
	}
	edge := strings.Split(f.one(t, `WITH b AS (SELECT CAST(date_trunc('month', `+hrbase.BusinessToday+`) + interval '1 month' AS date) AS first)
      SELECT concat_ws(',',
        (SELECT to_char(max(d),'YYYY-MM-DD') FROM generate_series(b.first - 7, b.first - 1, interval '1 day') d WHERE extract(isodow FROM d) < 6),
        (SELECT to_char(min(d),'YYYY-MM-DD') FROM generate_series(b.first, b.first + 6, interval '1 day') d WHERE extract(isodow FROM d) < 6)) FROM b`), ",")
	spanning := SubmitInput{Kind: hrbase.RequestWfh, Reason: "x", Dates: edge}
	if rejected := f.mustDecide(t, "C", f.mustDecide(t, "L", f.mustSubmit(t, "E", spanning), decisionApprove), decisionReject); rejected.State != stateRejected || counters("E") != "" {
		t.Fatalf("a rejected request %+v left counters %q", rejected, counters("E"))
	}
	waiting := f.mustSubmit(t, "E", spanning)
	if counters("E") != "" {
		t.Fatalf("a submit wrote counters %q", counters("E"))
	}
	approved := f.mustDecide(t, "C", f.mustDecide(t, "L", waiting, decisionApprove), decisionApprove)
	if want := edge[0][:7] + "=1," + edge[1][:7] + "=1"; approved.State != stateApproved || counters("E") != want {
		t.Fatalf("across %v: %+v, counters %q, want %q", edge, approved, counters("E"), want)
	}

	if f.day(t, 0)[:7] != f.day(t, 4)[:7] {
		f.monday = f.day(t, 7)
	}
	month := f.day(t, 0)[:7]
	if three := f.mustDecide(t, "C", f.mustSubmit(t, "L", f.wfh(t, 0, 1, 2)), decisionApprove); three.State != stateApproved || counters("L") != month+"=3" {
		t.Fatalf("three days of %s: %+v, counters %q", month, three, counters("L"))
	}
	input := f.verdict(t, f.mustSubmit(t, "L", f.wfh(t, 3, 4)), decisionApprove)
	if _, _, err := f.decide(t, "C", input); !rejectedWith(err, "error.wfhLimitAckRequired") || counters("L") != month+"=3" {
		t.Fatalf("two more days without the acknowledgement: %v, counters %q", err, counters("L"))
	}
	input.AcknowledgeWfhLimit = true
	if done, _, err := f.decide(t, "C", input); err != nil || done.State != stateApproved || counters("L") != month+"=5" {
		t.Fatalf("acknowledged: %+v %v, counters %q", done, err, counters("L"))
	}
}

func TestAnAuditFailureRollsBackTheDecision(t *testing.T) {
	f := newRequestFixture(t)
	request := f.mustSubmit(t, "E", f.wfh(t, 0))
	input := f.verdict(t, request, decisionApprove)
	before := f.one(t, requestState)
	f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
	_, _, err := f.decide(t, "L", input)
	f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "42501" {
		t.Fatalf("audit failure: %v", err)
	}
	if after := f.one(t, requestState); after != before {
		t.Errorf("a failed audit kept %s -> %s", before, after)
	}
	if done, _, err := f.decide(t, "L", input); err != nil || done.State != statePendingFinal {
		t.Errorf("same key after the failure %+v %v", done, err)
	}
}

type decided struct {
	result SubmitResult
	found  bool
	err    error
}

// holdRequests locks the requests FOR UPDATE until every decision waits, then lets them all go.
func (f *requestFixture) holdRequests(t *testing.T, ids []string, decisions map[string][]DecisionInput) []decided {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), `SELECT 1 FROM work_request WHERE id = ANY(CAST($1 AS uuid[])) FOR UPDATE`, ids)
	mustDB(t, err)
	done := make(chan decided, 4)
	n := 0
	for actor, inputs := range decisions {
		for _, input := range inputs {
			n++
			go func() {
				result, found, err := f.service.Decide(context.Background(), f.sessions[actor], input)
				done <- decided{result, found, err}
			}()
		}
	}
	f.waitBlocked(t, n)
	mustDB(t, tx.Commit(t.Context()))
	results := make([]decided, n)
	for i := range results {
		results[i] = <-done
	}
	return results
}

func TestDecisionsInFlightLeaveOneDecision(t *testing.T) {
	f := newRequestFixture(t)
	for day, second := range []string{decisionApprove, decisionReject} {
		request := f.mustSubmit(t, "E", f.wfh(t, day))
		results := f.holdRequests(t, []string{request.ID}, map[string][]DecisionInput{"L": {f.verdict(t, request, decisionApprove), f.verdict(t, request, second)}})
		stale := 0
		for _, r := range results {
			if errors.Is(r.err, apperror.ErrCommandRejected) {
				stale++
			} else {
				mustDB(t, r.err)
			}
		}
		if stale != 1 || f.count(t, `SELECT count(*)::text FROM request_decision WHERE request_id=$1`, request.ID) != 1 {
			t.Errorf("%s: %d stale", second, stale)
		}
	}
	request := f.mustSubmit(t, "E", f.wfh(t, 2))
	input := f.verdict(t, request, decisionApprove)
	results := f.holdRequests(t, []string{request.ID}, map[string][]DecisionInput{"L": {input, input}})
	if results[0].err != nil || results[1].err != nil || results[0].result != results[1].result {
		t.Errorf("one key twice %+v", results)
	}
	// Root's plan reaches the row after the first commit, so the replay runs inside the command.
	root := f.verdict(t, SubmitResult{ID: request.ID, Version: "2"}, decisionReject)
	results = f.holdRequests(t, []string{request.ID}, map[string][]DecisionInput{"R": {root, root}})
	if results[0].err != nil || results[1].err != nil || results[0].result != results[1].result {
		t.Errorf("Root one key twice %+v", results)
	}
	if f.count(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND convert_from(event_kind,'UTF8')='access.workRequest.decideFinal'
      AND safe_metadata->>'key'=$2`, f.accounts["R"], request.ID) != 1 {
		t.Error("Root's replay in the command is not audited on the request")
	}
	a, b := f.mustSubmit(t, "E", f.wfh(t, 3)), f.mustSubmit(t, "E", f.wfh(t, 4))
	first, second := f.verdict(t, a, decisionApprove), f.verdict(t, b, decisionApprove)
	second.IdempotencyKey = first.IdempotencyKey
	results = f.holdRequests(t, []string{a.ID, b.ID}, map[string][]DecisionInput{"L": {first, second}})
	reused := 0
	for _, r := range results {
		if rejectedWith(r.err, "error.idempotencyKeyReused") {
			reused++
		} else {
			mustDB(t, r.err)
		}
	}
	if reused != 1 || f.count(t, `SELECT count(*)::text FROM request_decision WHERE request_id IN ($1,$2)`, a.ID, b.ID) != 1 {
		t.Errorf("one key on two requests: %d reused", reused)
	}
}

// Lock order of an annual-leave approval: request (Execute) → bucket → period FOR SHARE. Holding the later
// lock, the earlier one must already be taken by the waiting decision (55P03 under a 50 ms lock_timeout).
func TestTheApprovalLocksRequestThenBucketThenPeriod(t *testing.T) {
	f := newRequestFixture(t)
	first := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780)), decisionApprove)
	second := f.mustDecide(t, "L", f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 2, 540, 780)), decisionApprove)
	f.exec(t, `INSERT INTO leave_bucket(employee_id,year) VALUES($1,CAST(substr($2,1,4) AS int)) ON CONFLICT DO NOTHING`, f.employees["E"], f.day(t, 1))
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (date_trunc('month',CAST($1 AS date))::date) ON CONFLICT DO NOTHING`, f.day(t, 1))
	bucket := `SELECT 1 FROM leave_bucket WHERE employee_id=$1 FOR UPDATE`
	period := `SELECT 1 FROM attendance_period WHERE month = date_trunc('month',DATE '` + f.day(t, 1) + `')::date AND $1::uuid IS NOT NULL FOR UPDATE`
	f.decisionLockOrder(t, first, bucket, `SELECT 1 FROM work_request WHERE id='`+first.ID+`' AND $1::uuid IS NOT NULL FOR UPDATE`)
	f.decisionLockOrder(t, second, period, bucket)
	if f.count(t, `SELECT count(*)::text FROM work_request WHERE id IN ($1,$2) AND state='approved'`, first.ID, second.ID) != 2 {
		t.Error("both approvals committed after the holder let go")
	}
}

func (f *requestFixture) decisionLockOrder(t *testing.T, r SubmitResult, second, first string) {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), second, f.employees["E"])
	mustDB(t, err)
	input := f.verdict(t, r, decisionApprove)
	done := make(chan decided, 1)
	go func() {
		result, found, err := f.service.Decide(context.Background(), f.sessions["C"], input)
		done <- decided{result, found, err}
	}()
	f.waitBlocked(t, 1)
	_, err = tx.Exec(t.Context(), `SET LOCAL lock_timeout = '50ms'`)
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), first, f.employees["E"])
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "55P03" {
		t.Errorf("%s was free while the approval waited on %s: %v", first, second, err)
	}
	mustDB(t, tx.Rollback(t.Context()))
	mustDB(t, (<-done).err)
}

// The queues and the history are scoped and paged before the count: the lead's own team, the COO's
// company, Root's everything; never the caller's own request, never a reason.
func TestTheQueuesAndTheHistoryAreScopedBeforeThePage(t *testing.T) {
	f := newRequestFixture(t)
	waiting := []SubmitResult{f.mustSubmit(t, "E", f.wfh(t, 0)), f.mustSubmit(t, "E", f.wfh(t, 1))}
	lead := f.queue(t, "L", stageLead)
	if lead.Total != "2" || len(lead.Items) != 2 || lead.Items[0].ID != waiting[0].ID || lead.Items[0].State != statePendingLead {
		t.Errorf("lead queue %+v", lead)
	}
	page, err := f.service.LeadQueue(t.Context(), f.sessions["L"], ListQuery{Limit: 1, Offset: 1})
	mustDB(t, err)
	if page.Total != "2" || len(page.Items) != 1 || page.Items[0] != lead.Items[1] {
		t.Errorf("page %+v", page)
	}
	reason := text('b', 0xed, ' ', 'm', 0x1ead, 't')
	rejected := f.verdict(t, waiting[1], decisionReject)
	rejected.Reason = &reason
	_, _, err = f.decide(t, "L", rejected)
	mustDB(t, err)
	forwarded := f.mustDecide(t, "L", waiting[0], decisionApprove)
	own := f.mustSubmit(t, "L", f.wfh(t, 2))
	for _, actor := range []string{"E", "O", "N", "H", "C", "R"} {
		if view := f.queue(t, actor, stageLead); view.Total != "0" || len(view.Items) != 0 {
			t.Errorf("%s lead queue %+v", actor, view)
		}
	}
	for actor, want := range map[string]string{"C": forwarded.ID + "|" + own.ID, "R": forwarded.ID + "|" + own.ID, "L": "", "E": "", "N": "", "H": ""} {
		view := f.queue(t, actor, stageFinal)
		ids := make([]string, len(view.Items))
		for i, item := range view.Items {
			ids[i] = item.ID
		}
		if strings.Join(ids, "|") != want || view.Total != strconv.Itoa(len(ids)) {
			t.Errorf("%s final queue %+v", actor, view)
		}
	}
	history, err := f.service.Decided(t.Context(), f.sessions["L"], ListQuery{Limit: 100})
	mustDB(t, err)
	name := f.one(t, `SELECT full_name FROM employee WHERE id=$1`, f.employees["E"])
	if history.Total != "2" || len(history.Items) != 2 || history.Items[0].ID != forwarded.ID || history.Items[0].EmployeeName != name ||
		history.Items[0].Decision.Stage != "lead" || history.Items[0].Decision.Decision != decisionApprove || history.Items[1].Decision.Decision != decisionReject {
		t.Errorf("history %+v", history)
	}
	if encoded, err := json.Marshal(history); err != nil || strings.Contains(string(encoded), reason) || strings.Contains(string(encoded), f.accounts["L"]) {
		t.Errorf("the history tells a reason or the decider: %s %v", encoded, err)
	}
	for actor, total := range map[string]string{"E": "0", "O": "0", "N": "0", "H": "0", "C": "2", "R": "2"} {
		view, err := f.service.Decided(t.Context(), f.sessions[actor], ListQuery{Limit: 1})
		mustDB(t, err)
		if view.Total != total || (total == "0") != (len(view.Items) == 0) {
			t.Errorf("%s history %+v", actor, view)
		}
	}
}
