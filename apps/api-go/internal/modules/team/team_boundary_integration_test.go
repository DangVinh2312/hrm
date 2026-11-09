//go:build integration

package team

import (
	"errors"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/test/fixture"
)

func TestBoundIAMAssignmentAndDeny(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Bound IAM")
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	f.exec(t, `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('team.assign','UTF8'),convert_to('hrAdministration','UTF8'),1)`, f.hrID)
	before := f.revision(t)
	result, err := f.service.AddMember(t.Context(), f.hr, MemberInput{TeamID: team, EmployeeID: employee.ID})
	mustDB(t, err)
	if result.Status != "added" || f.revision(t) == before || len(f.detail(t, team).Members) != 1 {
		t.Fatal("bound IAM assignment failed")
	}
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('team.assign','UTF8'),$1,'deny',convert_to('allTeams','UTF8'),1,'{}','runtime')`, f.hrID)
	before = f.revision(t)
	_, err = f.service.AssignLead(t.Context(), f.hr, LeadInput{TeamID: team, EmployeeID: &employee.ID})
	if !errors.Is(err, apperror.ErrNotFound) || f.revision(t) != before || f.detail(t, team).Lead != nil {
		t.Fatal("deny did not beat assignment allow")
	}
}

func TestRootReadAuditsAndAbsent(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Root read")
	if _, err := f.service.Detail(t.Context(), f.root, team); err != nil {
		mustDB(t, err)
	}
	if _, err := f.service.Detail(t.Context(), f.root, testID); !errors.Is(err, apperror.ErrNotFound) {
		t.Fatal("absent Root detail returned a record")
	}
	if got := f.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.team.read','UTF8') AND safe_metadata->>'outcome'='absent' AND safe_metadata->>'key'=$2`, f.rootID, testID); got != "1" {
		t.Fatal("Root absent access not audited")
	}
	if got := f.scalar(t, `SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.team.read','UTF8') AND safe_metadata->>'outcome'='ok' AND safe_metadata->>'key'=$2`, f.rootID, team); got != "1" {
		t.Fatal("Root successful access not audited")
	}
}
