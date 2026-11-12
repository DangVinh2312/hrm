//go:build integration

package workrequest

import (
	"context"
	"errors"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/hrbase"
	"hrm/api/internal/modules/leavecore"
	"hrm/api/test/fixture"
)

func TestPendingLeaveReservesAnExactBalanceAndRejectingItFreesTheSameKey(t *testing.T) {
	f := newRequestFixture(t)
	f.entitled(t, f.day(t, 0), 480)
	input := f.leave(t, hrbase.RequestAnnualLeave, 0, 540, 1080)
	input.IdempotencyKey = f.one(t, newKey)
	first := f.mustSubmit(t, "E", input)
	if f.count(t, `SELECT count(*)::text FROM leave_ledger WHERE entry_kind='debit'`) != 0 {
		t.Fatal("pending leave already debited")
	}
	next := f.leave(t, hrbase.RequestAnnualLeave, 1, 540, 660)
	next.IdempotencyKey = f.one(t, newKey)
	before := f.one(t, requestState)
	if _, err := f.submit(t, "E", next); !rejectedWith(err, "error.insufficientLeave") {
		t.Errorf("pending reservation did not fill the balance: %v", err)
	}
	if again := f.mustSubmit(t, "E", input); again != first || f.one(t, requestState) != before {
		t.Errorf("depleted balance changed replay: %+v", again)
	}
	unpaid := f.mustSubmit(t, "E", f.leave(t, hrbase.RequestUnpaidLeave, 2, 540, 1080))
	before = f.one(t, requestState)
	_, err := database.Run(t.Context(), f.s.Runner, database.ModeWrite, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		return struct{}{}, leavecore.ApplyApproved(tx, unpaid.ID)
	}, database.RunOptions{})
	if !errors.Is(err, leavecore.ErrNotAnnualLeave) || f.one(t, requestState) != before {
		t.Errorf("unpaid leave reached the debit effect: %v", err)
	}
	f.mustDecide(t, "L", first, decisionReject)
	approved := f.mustDecide(t, "C", f.mustDecide(t, "L", f.mustSubmit(t, "E", next), decisionApprove), decisionApprove)
	if approved.State != stateApproved {
		t.Fatal("rejected minutes were not available to the same key")
	}
	f.mustSubmit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 3, 540, 900))
	before = f.one(t, requestState)
	if _, err := f.submit(t, "E", f.leave(t, hrbase.RequestAnnualLeave, 4, 540, 660)); !rejectedWith(err, "error.insufficientLeave") || f.one(t, requestState) != before {
		t.Errorf("approved debit and pending leave failed to share the balance: %v", err)
	}
}

func TestSelfApprovalFollowsRuntimePermissionsAndTheirRevocation(t *testing.T) {
	f := newRequestFixture(t)
	role := "custom.approver"
	f.exec(t, `INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to($1,'UTF8'),'runtime','Approver')`, role)
	f.role(t, "E", role, true)
	if r := f.mustSubmit(t, "E", f.late(t, 0, 600)); r.State != statePendingLead {
		t.Fatalf("a role with no grants: %+v", r)
	}
	grant := `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to($1,'UTF8'),convert_to($2,'UTF8'),'allow',convert_to($3,'UTF8'),1,'{}','runtime')`
	f.exec(t, grant, "workRequest.decideFinal", role, "allRequests")
	f.exec(t, grant, "hrCompany.approvals", role, "company")
	r := f.mustSubmit(t, "E", f.late(t, 1, 600))
	if r.State != stateApproved || f.one(t, `SELECT decision||'|'||system_reason FROM request_decision WHERE request_id=$1`, r.ID) != "approve|coo_self_approved" {
		t.Fatalf("runtime permissions did not self approve: %+v", r)
	}
	f.exec(t, `DELETE FROM policy_rule WHERE role_key=convert_to($1,'UTF8') AND permission_key=convert_to('hrCompany.approvals','UTF8')`, role)
	if r := f.mustSubmit(t, "E", f.late(t, 2, 600)); r.State != statePendingLead {
		t.Errorf("revoked company permission: %+v", r)
	}
	f.exec(t, `DELETE FROM policy_rule WHERE role_key=convert_to($1,'UTF8')`, role)
	f.exec(t, grant, "hrCompany.approvals", role, "company")
	before := f.one(t, requestState)
	if _, err := f.submit(t, "E", f.late(t, 3, 600)); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("company permission without final decision: %v", err)
	}
	if f.one(t, requestState) != before {
		t.Error("unavailable self approval wrote state")
	}
}

func TestTheCurrentTeamAndLeadControlPendingRequests(t *testing.T) {
	f := newRequestFixture(t)
	f.exec(t, `UPDATE team_lead_assignment SET ends_at=statement_timestamp() WHERE team_id=$1`, f.team)
	r := f.mustSubmit(t, "E", f.wfh(t, 0))
	before := f.one(t, decisionState)
	for _, actor := range []string{"H", "C", "L", "O", "E"} {
		if _, found, err := f.decide(t, actor, f.verdict(t, r, decisionApprove)); found || err != nil {
			t.Errorf("%s decided without a lead: %v %v", actor, found, err)
		}
	}
	if _, _, err := f.decide(t, "R", f.verdict(t, r, decisionApprove)); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("Root fallback: %v", err)
	}
	if f.one(t, decisionState) != before {
		t.Error("a refusal changed the request")
	}
	f.lead(t, "L")
	f.lead(t, "C")
	if _, found, err := f.decide(t, "L", f.verdict(t, r, decisionApprove)); found || err != nil {
		t.Errorf("the former lead kept permission: %v %v", found, err)
	}
	if done := f.mustDecide(t, "C", r, decisionApprove); done.State != statePendingFinal {
		t.Errorf("new lead: %+v", done)
	}
	f.lead(t, "L")
	other := f.one(t, `INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Other' FROM gen_random_uuid() g RETURNING id::text`)
	f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,false,statement_timestamp()-interval '1 hour'),(gen_random_uuid(),$1,$3,false,statement_timestamp()-interval '1 hour')`, other, f.employees["E"], f.employees["C"])
	f.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, other, f.employees["C"])
	input := f.wfh(t, 1)
	input.TeamID = &other
	r = f.mustSubmit(t, "E", input)
	if _, found, err := f.decide(t, "L", f.verdict(t, r, decisionApprove)); found || err != nil {
		t.Errorf("primary lead decides another current team: %v %v", found, err)
	}
	f.exec(t, `UPDATE team_membership SET ends_at=statement_timestamp() WHERE team_id=$1 AND employee_id=$2`, other, f.employees["E"])
	if _, found, err := f.decide(t, "C", f.verdict(t, r, decisionApprove)); found || err != nil {
		t.Errorf("left team's lead kept the step: %v %v", found, err)
	}
	if done := f.mustDecide(t, "L", r, decisionApprove); done.State != statePendingFinal {
		t.Errorf("primary-team fallback: %+v", done)
	}
}

func TestTwoRolesStillRequireTwoDecisionsAndANewLinkedAccountCannotSelfDecide(t *testing.T) {
	f := newRequestFixture(t)
	f.role(t, "L", "hr.coo", true)
	r := f.mustSubmit(t, "E", f.wfh(t, 0))
	step := f.mustDecide(t, "L", r, decisionApprove)
	if step.State != statePendingFinal || f.count(t, `SELECT count(*)::text FROM request_decision WHERE request_id=$1`, r.ID) != 1 {
		t.Fatal("two roles skipped the final step")
	}
	if done := f.mustDecide(t, "L", step, decisionApprove); done.State != stateApproved || f.count(t, `SELECT count(DISTINCT stage)::text FROM request_decision WHERE request_id=$1 AND actor_account_id=$2`, r.ID, f.accounts["L"]) != 2 {
		t.Errorf("same actor's two stages: %+v", done)
	}
	r = f.mustSubmit(t, "E", f.wfh(t, 1))
	account := fixture.Account(t, f.s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	f.accounts["A"] = account
	f.sessions["A"] = fixture.Session(t, f.s, account, fixture.SessionSpec{Fresh: true})
	f.exec(t, `UPDATE employee SET account_id=$1 WHERE id=$2`, account, f.employees["E"])
	f.lead(t, "E")
	before := f.one(t, requestState)
	for _, decision := range []string{decisionApprove, decisionReject} {
		if _, _, err := f.decide(t, "A", f.verdict(t, r, decision)); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("new linked account's self decision: %v", err)
		}
	}
	if f.one(t, requestState) != before {
		t.Error("self decision wrote state")
	}
}

func TestCooOnlyReadsALeadOwnedRequestRejectedAtTheLeadStep(t *testing.T) {
	f := newRequestFixture(t)
	other := f.one(t, `INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Led elsewhere' FROM gen_random_uuid() g RETURNING id::text`)
	f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,false,statement_timestamp()-interval '1 hour')`, other, f.employees["E"])
	f.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, other, f.employees["E"])
	leadOwned := f.mustSubmit(t, "E", f.wfh(t, 0))
	if _, found, err := f.service.Detail(t.Context(), f.sessions["C"], leadOwned.ID); found || err != nil {
		t.Errorf("COO read pending lead: %v %v", found, err)
	}
	closed := f.mustDecide(t, "L", leadOwned, decisionReject)
	f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, f.employees["O"])
	ordinary := f.mustDecide(t, "L", f.mustSubmit(t, "O", f.wfh(t, 1)), decisionReject)
	if _, found, err := f.service.Detail(t.Context(), f.sessions["C"], ordinary.ID); found || err != nil {
		t.Errorf("COO read an ordinary owner's rejected request: %v %v", found, err)
	}
	if view, found, err := f.service.Detail(t.Context(), f.sessions["C"], closed.ID); !found || err != nil || view.State != stateRejected || len(view.Decisions) != 1 {
		t.Errorf("COO read lead rejection: %+v %v %v", view, found, err)
	}
	before := f.one(t, requestState)
	for _, decision := range []string{decisionApprove, decisionReject} {
		if _, found, err := f.decide(t, "C", f.verdict(t, closed, decision)); found || err != nil {
			t.Errorf("read-only rejection decided: %v %v", found, err)
		}
	}
	if queued(f.queue(t, "C", stageFinal), closed.ID) || f.one(t, requestState) != before {
		t.Error("read-only rejection queued or changed state")
	}
	f.exec(t, `UPDATE team_lead_assignment SET ends_at=statement_timestamp() WHERE team_id=$1`, other)
	if _, found, err := f.service.Detail(t.Context(), f.sessions["C"], closed.ID); found || err != nil {
		t.Errorf("former lead-owned record still visible: %v %v", found, err)
	}
}
