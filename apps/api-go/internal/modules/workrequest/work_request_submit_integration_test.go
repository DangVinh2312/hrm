//go:build integration

package workrequest

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/test/fixture"
)

const calendarLock = `SELECT 1 FROM work_calendar WHERE id = '` + permission.WorkCalendarID + `' AND $1::uuid IS NOT NULL FOR UPDATE`

func TestAMemberSubmitsAndReadsOwnRequests(t *testing.T) {
	f := newRequestFixture(t)
	result := f.mustSubmit(t, "E", f.late(t, 0, 600))
	if result.State != statePendingLead || result.Version != "1" || result.WfhLimitExceeded != nil {
		t.Fatalf("result %+v", result)
	}
	row := f.one(t, `SELECT concat_ws('|', employee_id, owner_account_id, team_id, kind, state, reason, version) FROM work_request WHERE id=$1`, result.ID)
	if want := f.employees["E"] + "|" + f.accounts["E"] + "|" + f.team + "|late-arrival|pending_lead|x|1"; row != want {
		t.Errorf("row %s", row)
	}
	if f.audits(t, "hr.request.submit") != 1 || f.count(t, `SELECT count(*)::text FROM request_decision`) != 0 {
		t.Error("one audit, no decision")
	}
	if f.one(t, `SELECT target_id::text FROM hr_idempotency WHERE actor_id=$1 AND operation='workRequest.submit'`, f.accounts["E"]) != result.ID {
		t.Error("claim target")
	}
	list, err := f.service.List(t.Context(), f.sessions["E"], ListQuery{Limit: 20})
	mustDB(t, err)
	day := f.day(t, 0)
	if list.Total != "1" || len(list.Items) != 1 || list.Items[0].ID != result.ID || list.Items[0].StartDate != day || list.Items[0].EndDate != day || list.Items[0].Minutes != 60 || list.Items[0].TeamID != f.team {
		t.Errorf("list %+v", list)
	}
	view, found, err := f.service.Detail(t.Context(), f.sessions["E"], result.ID)
	mustDB(t, err)
	if !found || view.EmployeeID != f.employees["E"] || !reflect.DeepEqual(view.Segments, []Segment{{day, 540, 600, 60}}) || view.Decisions == nil || len(view.Decisions) != 0 {
		t.Errorf("detail %v %+v", found, view)
	}
	for _, reader := range []string{"O", "N"} {
		if _, found, err := f.service.Detail(t.Context(), f.sessions[reader], result.ID); err != nil || found {
			t.Errorf("%s reads E's request: %v %v", reader, found, err)
		}
		other, err := f.service.List(t.Context(), f.sessions[reader], ListQuery{Limit: 20})
		if err != nil || other.Total != "0" || other.Items == nil || len(other.Items) != 0 {
			t.Errorf("%s lists %+v %v", reader, other, err)
		}
	}
	if _, found, err := f.service.Detail(t.Context(), f.sessions["E"], f.one(t, newKey)); err != nil || found {
		t.Errorf("absent found %v %v", found, err)
	}
}

func TestTheLeadOfTheTeamSkipsTheLeadStep(t *testing.T) {
	f := newRequestFixture(t)
	result := f.mustSubmit(t, "L", f.leave(t, hrbase.RequestUnpaidLeave, 1, 540, 780))
	if result.State != statePendingFinal {
		t.Fatalf("result %+v", result)
	}
	view, _, err := f.service.Detail(t.Context(), f.sessions["L"], result.ID)
	mustDB(t, err)
	if len(view.Decisions) != 1 || view.Decisions[0].Stage != "lead" || view.Decisions[0].Decision != "skip" || view.Decisions[0].ActorKind != "system" || view.Decisions[0].SystemReason == nil || *view.Decisions[0].SystemReason != systemLeadSkipped || view.Decisions[0].Reason != nil {
		t.Errorf("decisions %+v", view.Decisions)
	}
}

func TestTheCooApprovesOwnRequestsWithTheirEffects(t *testing.T) {
	f := newRequestFixture(t)
	late := f.mustSubmit(t, "C", f.late(t, 0, 600))
	leave := f.mustSubmit(t, "C", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780))
	wfh := f.mustSubmit(t, "C", f.wfh(t, 2))
	for _, r := range []SubmitResult{late, leave, wfh} {
		if r.State != stateApproved || f.one(t, `SELECT state FROM work_request WHERE id=$1`, r.ID) != stateApproved {
			t.Errorf("%+v", r)
		}
		if f.one(t, `SELECT concat_ws('|',stage,decision,actor_kind,system_reason) FROM request_decision WHERE request_id=$1`, r.ID) != "final|approve|system|coo_self_approved" {
			t.Errorf("decision of %s", r.ID)
		}
	}
	if wfh.WfhLimitExceeded == nil || *wfh.WfhLimitExceeded {
		t.Errorf("wfh warning %+v", wfh.WfhLimitExceeded)
	}
	if f.audits(t, "hr.request.submit") != 3 || f.audits(t, "hr.request.self-approve") != 3 {
		t.Error("audits")
	}
	if f.count(t, `SELECT count(*)::text FROM leave_ledger WHERE source_request_id=$1 AND entry_kind='debit' AND minutes=240`, leave.ID) != 1 {
		t.Error("leave debit")
	}
	if f.count(t, `SELECT coalesce(sum(approved_count),0)::text FROM wfh_month_counter WHERE employee_id=$1`, f.employees["C"]) != 1 {
		t.Error("wfh counter")
	}
}

func TestAWfhRequestWarnsPastTheMonthLimit(t *testing.T) {
	f := newRequestFixture(t)
	f.setting(t, "hr.wfhMonthLimit", 1)
	pair := []int{0, 1}
	if f.day(t, 0)[:7] != f.day(t, 1)[:7] {
		pair = []int{3, 4}
	}
	result := f.mustSubmit(t, "E", f.wfh(t, pair...))
	if result.WfhLimitExceeded == nil || !*result.WfhLimitExceeded || result.State != statePendingLead {
		t.Errorf("%+v", result)
	}
}

func TestARetryReplaysAndAnotherPayloadReusesTheKey(t *testing.T) {
	f := newRequestFixture(t)
	input := f.late(t, 0, 600)
	input.IdempotencyKey = f.one(t, newKey)
	first := f.mustSubmit(t, "E", input)
	before := f.one(t, requestState)
	if again := f.mustSubmit(t, "E", input); again != first {
		t.Errorf("replay %+v, want %+v", again, first)
	}
	other := input
	other.ExpectedMinute = 660
	if _, err := f.submit(t, "E", other); !rejectedWith(err, "error.idempotencyKeyReused") {
		t.Errorf("another payload: %v", err)
	}
	if after := f.one(t, requestState); after != before {
		t.Errorf("a retry wrote %s -> %s", before, after)
	}
	mustDB(t, func() error { _, err := f.submit(t, "L", input); return err }())
}

// The stored WFH warning is replayed as stored, not recomputed.
func TestAReplayAnswersTheStoredWarning(t *testing.T) {
	f := newRequestFixture(t)
	input := f.wfh(t, 0)
	input.IdempotencyKey = f.one(t, newKey)
	first := f.mustSubmit(t, "E", input)
	f.setting(t, "hr.wfhMonthLimit", 0)
	if again := f.mustSubmit(t, "E", input); !reflect.DeepEqual(again, first) || again.WfhLimitExceeded == nil || *again.WfhLimitExceeded {
		t.Errorf("replay %+v", again)
	}
}

// Root has no profile, so it submits for nobody: 404 and its access audited, nothing else written.
func TestRootWithoutAProfileIsNotFoundAndAudited(t *testing.T) {
	f := newRequestFixture(t)
	before := f.one(t, requestState)
	accessBefore := f.audits(t, "access.employee.submitRequest")
	for _, actor := range []string{"R", "N"} {
		if _, err := f.submit(t, actor, f.late(t, 0, 600)); !errors.Is(err, apperror.ErrNotFound) {
			t.Errorf("%s: %v", actor, err)
		}
	}
	if f.audits(t, "access.employee.submitRequest") != accessBefore+1 {
		t.Error("root access")
	}
	f.exec(t, `DELETE FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='access.employee.submitRequest'`)
	if after := f.one(t, requestState); after != before {
		t.Errorf("wrote %s -> %s", before, after)
	}
}

// submitAccess counts the access rows of employee.submitRequest by actor: the submitter query's, without a
// target, or a replay's, which names the employee.
const submitAccess = `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1
  AND event_kind=convert_to('access.employee.submitRequest','UTF8') AND object_id IS NULL
  AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok'
  AND CASE WHEN $2='' THEN safe_metadata->>'key' IS NULL
      ELSE safe_metadata->>'resource'='employee' AND safe_metadata->>'keyKind'='uuid' AND safe_metadata->>'key'=$2 END`

// A replay writes nothing. Root's replay commits one access audit of its own profile, the command's target,
// besides the untargeted access of the submitter query that every submit of Root commits first; it is
// refused when that targeted audit cannot be written. An IAM replay is never audited.
func TestARootReplayIsAuditedOnItsProfileAndAnIAMReplayIsNot(t *testing.T) {
	f := newRequestFixture(t)
	root := fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: f.accounts["R"], HiredOn: "2020-01-06"}).ID
	f.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official',DATE '2020-01-06')`, root)
	f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, root)
	f.exec(t, `CREATE FUNCTION public.reject_replay_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault'; END $$`)
	reject := `CREATE TRIGGER reject_replay_audit BEFORE INSERT ON audit_outbox FOR EACH ROW
      WHEN (NEW.event_kind=convert_to('access.employee.submitRequest','UTF8') AND NEW.safe_metadata->>'key' IS NOT NULL)
      EXECUTE FUNCTION public.reject_replay_audit()`
	for _, run := range []struct {
		actor, profile string
		audits         int
	}{{"R", root, 1}, {"E", f.employees["E"], 0}} {
		input := f.late(t, 0, 600)
		input.IdempotencyKey = f.one(t, newKey)
		first := f.mustSubmit(t, run.actor, input)
		f.exec(t, `DELETE FROM audit_outbox`)
		before := f.one(t, requestState)
		f.exec(t, reject)
		refused, err := f.submit(t, run.actor, input)
		f.exec(t, `DROP TRIGGER reject_replay_audit ON audit_outbox`)
		if pg, ok := errors.AsType[*pgconn.PgError](err); run.audits == 1 && (!ok || pg.Code != "P0001" || refused != SubmitResult{}) {
			t.Errorf("%s replay released without its audit: %+v %v", run.actor, refused, err)
		}
		if run.audits == 0 && (err != nil || refused != first) {
			t.Errorf("%s replay needs no audit: %+v %v", run.actor, refused, err)
		}
		f.exec(t, `DELETE FROM audit_outbox`)
		if again := f.mustSubmit(t, run.actor, input); again != first {
			t.Errorf("%s replay %+v, want %+v", run.actor, again, first)
		}
		targeted := f.count(t, submitAccess, f.accounts[run.actor], run.profile)
		query := f.count(t, submitAccess, f.accounts[run.actor], "")
		if all := f.count(t, `SELECT count(*)::text FROM audit_outbox`); targeted != run.audits || query != run.audits || all != 2*run.audits {
			t.Errorf("%s replay audited %d rows: %d of the profile, %d of the query; want %d each", run.actor, all, targeted, query, run.audits)
		}
		f.exec(t, `DELETE FROM audit_outbox`)
		if after := f.one(t, requestState); after != before {
			t.Errorf("%s replay wrote %s -> %s", run.actor, before, after)
		}
	}
	if f.one(t, `SELECT state FROM work_request r JOIN employee e ON e.id=r.employee_id WHERE e.account_id=$1`, f.accounts["R"]) != stateApproved {
		t.Error("Root's first submit is its own final approval")
	}
}

func TestEveryRefusedSubmitWritesNothing(t *testing.T) {
	f := newRequestFixture(t)
	f.mustSubmit(t, "E", f.late(t, 0, 600))
	p := fixture.Account(t, f.s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	f.accounts["P"] = p
	f.sessions["P"] = fixture.Session(t, f.s, p, fixture.SessionSpec{Fresh: true})
	probation := fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: p, HiredOn: "2020-01-06"}).ID
	f.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'probation',DATE '2020-01-06')`, probation)
	f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, probation)
	past := f.late(t, 0, 600)
	past.Date = f.one(t, `SELECT to_char(`+hrbase.BusinessToday+` - 8,'YYYY-MM-DD')`)
	foreign := f.late(t, 2, 600)
	team := f.one(t, newKey)
	foreign.TeamID = &team
	f.closeMonth(t, f.day(t, 30))
	closed := f.late(t, 30, 600)
	if f.day(t, 30)[:7] == f.day(t, 0)[:7] {
		t.Fatal("day 30 shares the month of day 0")
	}
	cases := []struct {
		name, actor string
		input       SubmitInput
		want        func(error) bool
	}{
		{"overlap", "E", f.leave(t, hrbase.RequestUnpaidLeave, 0, 540, 660), func(err error) bool { return rejectedWith(err, "error.overlappingRequest") }},
		{"second late the same day", "E", f.late(t, 0, 900), func(err error) bool { return rejectedWith(err, "error.overlappingRequest") }},
		{"closed month", "E", closed, func(err error) bool { return rejectedWith(err, "error.periodClosed") }},
		{"no team", "O", f.late(t, 1, 600), func(err error) bool { return rejectedWith(err, "error.teamNotMember") }},
		{"not a team of the caller", "E", foreign, func(err error) bool { return rejectedWith(err, "error.teamNotMember") }},
		{"probation", "P", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780), func(err error) bool { return rejectedWith(err, "error.kindNotAllowedInProbation") }},
		{"past the window", "E", past, func(err error) bool { return rejectedWith(err, "error.dateOutOfRange") }},
		{"beyond the window", "E", f.late(t, 100, 600), func(err error) bool { return rejectedWith(err, "error.dateOutOfRange") }},
		{"saturday", "E", f.wfh(t, 5), func(err error) bool { return rejectedWith(err, "error.nonWorkingDay") }},
		{"outside a shift", "E", f.late(t, 1, 1440), func(err error) bool { return errors.Is(err, apperror.ErrInvalidRequest) }},
		{"no role", "N", f.late(t, 1, 600), func(err error) bool { return errors.Is(err, apperror.ErrNotFound) }},
	}
	before := f.one(t, requestState)
	for _, tc := range cases {
		if _, err := f.submit(t, tc.actor, tc.input); !tc.want(err) {
			t.Errorf("%s: %v", tc.name, err)
		}
	}
	f.setting(t, "hr.requestMaxDays", 1)
	if _, err := f.submit(t, "E", f.wfh(t, 1, 2)); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("max days: %v", err)
	}
	f.exec(t, `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,reference) VALUES(gen_random_uuid(),$1,'adjustment',CAST($2 AS date),-175680,'x')`, f.employees["E"], f.day(t, 0))
	if _, err := f.submit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 780)); !rejectedWith(err, "error.insufficientLeave") {
		t.Errorf("insufficient leave: %v", err)
	}
	f.exec(t, `DELETE FROM system_setting`)
	f.exec(t, `DELETE FROM leave_ledger WHERE entry_kind='adjustment'`)
	f.exec(t, `DELETE FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'access.%'`)
	if after := f.one(t, requestState); after != before {
		t.Errorf("a refusal wrote %s -> %s", before, after)
	}
}

func TestAKindWithoutItsEffectHandlerIsNeverSelfApproved(t *testing.T) {
	f := newRequestFixtureWith(t, approvedEffects{effectWfh: productionEffects()[effectWfh]})
	before := f.one(t, requestState)
	for _, input := range []SubmitInput{f.late(t, 0, 600), f.wfh(t, 1)} {
		if _, err := f.submit(t, "C", input); !errors.Is(err, apperror.ErrCommandRejected) {
			t.Errorf("%s: %v", input.Kind, err)
		}
	}
	if after := f.one(t, requestState); after != before {
		t.Errorf("wrote %s -> %s", before, after)
	}
	if r := f.mustSubmit(t, "E", f.late(t, 0, 600)); r.State != statePendingLead {
		t.Errorf("member %+v", r)
	}
}

func TestAnAuditFailureRollsBackTheRequestAndTheClaim(t *testing.T) {
	f := newRequestFixture(t)
	before := f.one(t, requestState)
	input := f.late(t, 0, 600)
	input.IdempotencyKey = f.one(t, newKey)
	f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
	_, err := f.submit(t, "E", input)
	f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "42501" {
		t.Fatalf("audit failure: %v", err)
	}
	if after := f.one(t, requestState); after != before {
		t.Errorf("a failed audit kept %s -> %s", before, after)
	}
	if r := f.mustSubmit(t, "E", input); r.State != statePendingLead {
		t.Errorf("same key after the failure %+v", r)
	}
}

// Lock order: employee → periods FOR SHARE → work_calendar FOR SHARE.
func TestTheSubmitLocksEmployeeThenPeriodThenCalendar(t *testing.T) {
	f := newRequestFixture(t)
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (date_trunc('month',CAST($1 AS date))::date) ON CONFLICT DO NOTHING`, f.day(t, 0))
	period := `SELECT 1 FROM attendance_period WHERE month = date_trunc('month',DATE '` + f.day(t, 0) + `')::date AND $1::uuid IS NOT NULL FOR UPDATE`
	f.lockOrder(t, f.late(t, 0, 600), period, `SELECT 1 FROM employee WHERE id=$1 FOR UPDATE`)
	f.lockOrder(t, f.late(t, 1, 600), calendarLock, period)
	if f.count(t, `SELECT count(*)::text FROM work_request`) != 2 {
		t.Error("both submits committed after the holder let go")
	}
}

func TestTwoSubmitsWithOneKeyWriteOneRequestAndBothGetItsID(t *testing.T) {
	f := newRequestFixture(t)
	input := f.late(t, 0, 600)
	input.IdempotencyKey = f.one(t, newKey)
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), calendarLock, f.employees["E"])
	mustDB(t, err)
	done := make(chan outcome, 2)
	for range 2 {
		go func() {
			result, err := f.service.Submit(context.Background(), f.sessions["E"], input)
			done <- outcome{result, err}
		}()
	}
	f.waitBlocked(t, 2)
	mustDB(t, tx.Commit(t.Context()))
	first, second := <-done, <-done
	mustDB(t, first.err)
	mustDB(t, second.err)
	if first.result != second.result || f.count(t, `SELECT count(*)::text FROM work_request`) != 1 {
		t.Errorf("%+v %+v", first.result, second.result)
	}
}

func TestTwoOverlappingSubmitsInFlightCommitOne(t *testing.T) {
	f := newRequestFixture(t)
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), calendarLock, f.employees["E"])
	mustDB(t, err)
	done := make(chan outcome, 2)
	for _, input := range []SubmitInput{f.late(t, 0, 600), f.leave(t, hrbase.RequestUnpaidLeave, 0, 540, 660)} {
		input.IdempotencyKey = f.one(t, newKey)
		go func() {
			result, err := f.service.Submit(context.Background(), f.sessions["E"], input)
			done <- outcome{result, err}
		}()
	}
	f.waitBlocked(t, 2)
	mustDB(t, tx.Commit(t.Context()))
	refused := 0
	for range 2 {
		if o := <-done; rejectedWith(o.err, "error.overlappingRequest") {
			refused++
		} else {
			mustDB(t, o.err)
		}
	}
	if refused != 1 || f.count(t, `SELECT count(*)::text FROM work_request`) != 1 {
		t.Errorf("refused %d", refused)
	}
}

func TestADenyOnDecideFinalRefusesTheSelfApproval(t *testing.T) {
	f := newRequestFixture(t)
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to('workRequest.decideFinal','UTF8'),$1,'deny',convert_to('allRequests','UTF8'),1,'{}','runtime')`, f.accounts["C"])
	before := f.one(t, requestState)
	if _, err := f.submit(t, "C", f.late(t, 0, 600)); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("denied self-approval: %v", err)
	}
	if after := f.one(t, requestState); after != before {
		t.Errorf("wrote %s -> %s", before, after)
	}
	f.exec(t, `DELETE FROM policy_rule WHERE user_id=$1`, f.accounts["C"])
	if r := f.mustSubmit(t, "C", f.late(t, 0, 600)); r.State != stateApproved {
		t.Errorf("lifted %+v", r)
	}
}

// Probation refuses annual leave and WFH per day; late, early and unpaid leave stay open. A late arrival
// on a WFH day does not overlap it.
func TestProbationAndAWfhDayLeaveTheTimedKindsOpen(t *testing.T) {
	f := newRequestFixture(t)
	f.exec(t, `UPDATE employment_status_period SET status='probation' WHERE employee_id=$1`, f.employees["E"])
	if _, err := f.submit(t, "E", f.wfh(t, 0)); !rejectedWith(err, "error.kindNotAllowedInProbation") {
		t.Errorf("wfh in probation: %v", err)
	}
	for _, input := range []SubmitInput{f.late(t, 0, 600), f.leave(t, hrbase.RequestUnpaidLeave, 1, 540, 660)} {
		f.mustSubmit(t, "E", input)
	}
	f.mustSubmit(t, "L", f.wfh(t, 2))
	f.mustSubmit(t, "L", f.late(t, 2, 600))
}

func TestARevokedCooRoleSubmitsAnOrdinaryRequest(t *testing.T) {
	f := newRequestFixture(t)
	f.exec(t, `DELETE FROM user_role WHERE user_id=$1 AND role_key=convert_to('hr.coo','UTF8')`, f.accounts["C"])
	if r := f.mustSubmit(t, "C", f.wfh(t, 0)); r.State != statePendingLead {
		t.Errorf("%+v", r)
	}
}

// A retry after the submitter lost its profile reaches nothing: 404, not the stored result.
func TestARevokedSubmitterReplaysNothing(t *testing.T) {
	f := newRequestFixture(t)
	input := f.late(t, 0, 600)
	input.IdempotencyKey = f.one(t, newKey)
	f.mustSubmit(t, "E", input)
	f.exec(t, `UPDATE employee SET account_id=NULL WHERE id=$1`, f.employees["E"])
	if _, err := f.submit(t, "E", input); !errors.Is(err, apperror.ErrNotFound) {
		t.Errorf("revoked retry: %v", err)
	}
}
