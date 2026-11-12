//go:build integration

package team

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/database"
	"hrm/api/test/fixture"
)

func TestCreateRenameUniqueAndAuthorization(t *testing.T) {
	f := newTeamFixture(t)
	created, err := f.service.Create(t.Context(), f.hr, CreateInput{Name: "K\u1ebf to\u00e1n"})
	mustDB(t, err)
	_, err = f.service.Create(t.Context(), f.hr, CreateInput{Name: "K\u1ebe TO\u00c1N"})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("case insensitive duplicate accepted")
	}
	_, err = f.service.Create(t.Context(), f.member, CreateInput{Name: "Other"})
	if !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("employee created a team")
	}
	view := f.detail(t, created.ID)
	if view.Name != "K\u1ebf to\u00e1n" || len(view.Members) != 0 || view.Lead != nil || view.Version != "1" {
		t.Fatalf("unexpected empty team: %+v", view)
	}
	renamed, err := f.service.Rename(t.Context(), f.hr, RenameInput{TeamID: created.ID, ExpectedVersion: "1", Name: "K\u1ebf to\u00e1n t\u1ed5ng h\u1ee3p"})
	mustDB(t, err)
	if renamed.Version != "2" {
		t.Fatal("version did not increment")
	}
	_, err = f.service.Rename(t.Context(), f.hr, RenameInput{TeamID: created.ID, ExpectedVersion: "1", Name: "stale"})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("stale rename accepted")
	}
	other := f.create(t, "Other")
	_, err = f.service.Rename(t.Context(), f.hr, RenameInput{TeamID: other, ExpectedVersion: "1", Name: "K\u1ebe TO\u00c1N T\u1ed4NG H\u1ee2P"})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("duplicate rename accepted")
	}
	for _, id := range []string{created.ID, testID} {
		_, err = f.service.Rename(t.Context(), f.member, RenameInput{TeamID: id, ExpectedVersion: "2", Name: "hidden"})
		if !errors.Is(err, apperror.ErrNotFound) {
			t.Fatal("hidden/absent update distinguished")
		}
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM audit_outbox WHERE event_kind IN (convert_to('hr.team.create','UTF8'),convert_to('hr.team.update','UTF8'))"); got != "3" {
		t.Fatalf("audit count %s", got)
	}
}

func TestAssignmentRequiresBoundaryAndFresh(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Boundary")
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	before := f.revision(t)
	for _, secret := range []string{f.hr, fixture.Session(t, f.s, f.hrID, fixture.SessionSpec{})} {
		_, err := f.service.AddMember(t.Context(), secret, MemberInput{TeamID: team, EmployeeID: employee.ID})
		if !errors.Is(err, apperror.ErrAccessDenied) {
			t.Fatal("missing boundary accepted")
		}
	}
	if f.revision(t) != before || len(f.detail(t, team).Members) != 0 {
		t.Fatal("denial changed state")
	}
	staleRoot := fixture.Session(t, f.s, f.rootID, fixture.SessionSpec{})
	_, err := f.service.AddMember(t.Context(), staleRoot, MemberInput{TeamID: team, EmployeeID: employee.ID})
	if !errors.Is(err, apperror.ErrAccessDenied) && !errors.Is(err, apperror.ErrStepUpRequired) {
		t.Fatal("Root bypassed fresh")
	}
}

func TestMembershipPrimaryAndHistory(t *testing.T) {
	f := newTeamFixture(t)
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	a, b, c := f.create(t, "M1"), f.create(t, "M2"), f.create(t, "M3")
	f.add(t, a, employee.ID, false)
	f.add(t, b, employee.ID, false)
	if got := f.scalar(t, "SELECT team_id::text FROM team_membership WHERE employee_id=$1 AND ends_at IS NULL AND is_primary", employee.ID); got != a {
		t.Fatal("first membership not primary")
	}
	_, err := f.service.AddMember(t.Context(), f.root, MemberInput{TeamID: b, EmployeeID: employee.ID, Primary: true})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("duplicate membership accepted")
	}
	f.add(t, c, employee.ID, true)
	_, err = f.service.SetPrimary(t.Context(), f.root, MembershipRef{TeamID: b, EmployeeID: employee.ID})
	mustDB(t, err)
	_, err = f.service.SetPrimary(t.Context(), f.root, MembershipRef{TeamID: b, EmployeeID: employee.ID})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("unchanged primary accepted")
	}
	_, err = f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: b, EmployeeID: employee.ID})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("ended primary with other memberships")
	}
	for _, id := range []string{a, c, b} {
		_, err = f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: id, EmployeeID: employee.ID})
		mustDB(t, err)
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM team_membership WHERE employee_id=$1 AND ends_at IS NULL", employee.ID); got != "0" {
		t.Fatal("open membership remains")
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM team_membership WHERE employee_id=$1 AND ends_at IS NOT NULL", employee.ID); got != "6" {
		t.Fatalf("history lost: %s", got)
	}
}

func TestAssignmentsRevokeScopeNextTransaction(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Scope")
	lead := fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: f.memberID})
	otherAccount := fixture.Account(t, f.s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	next := fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: otherAccount.ID})
	nextSecret := fixture.Session(t, f.s, otherAccount.ID, fixture.SessionSpec{})
	person := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	for _, id := range []string{lead.ID, next.ID, person.ID} {
		f.add(t, team, id, false)
	}
	visible := func(secret string) []string {
		t.Helper()
		r, err := authority.Read(t.Context(), f.auth, secret, f.employees, ListQuery{})
		mustDB(t, err)
		return r.Value
	}
	f.lead(t, team, &lead.ID)
	if !slices.Contains(visible(f.member), person.ID) {
		t.Fatal("lead did not gain employee scope")
	}
	_, err := f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: person.ID})
	mustDB(t, err)
	if slices.Contains(visible(f.member), person.ID) {
		t.Fatal("ended membership retained scope")
	}
	f.lead(t, team, &next.ID)
	_, err = f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: lead.ID})
	mustDB(t, err)
	if !reflect.DeepEqual(visible(f.member), []string{lead.ID}) {
		t.Fatal("former lead retained employee scope")
	}
	_, err = f.service.Detail(t.Context(), f.member, team)
	if !errors.Is(err, apperror.ErrNotFound) {
		t.Fatal("former member retained team scope")
	}
	history := f.detail(t, team).LeadHistory
	if len(history) != 2 || history[0].EmployeeID != next.ID || history[0].EndsAt != nil || history[1].EndsAt == nil {
		t.Fatal("lead history incorrect")
	}
	f.lead(t, team, nil)
	if !reflect.DeepEqual(visible(nextSecret), []string{next.ID}) {
		t.Fatal("cleared lead retained employee scope")
	}
}

func TestConcurrentAssignmentsSerialize(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Concurrent")
	a := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	b := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	outcomes := make(chan error, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := f.service.AddMember(t.Context(), f.root, MemberInput{TeamID: team, EmployeeID: a.ID})
			outcomes <- err
		}()
	}
	close(start)
	wg.Wait()
	close(outcomes)
	successes, rejections := 0, 0
	for err := range outcomes {
		if err == nil {
			successes++
		} else if errors.Is(err, apperror.ErrCommandRejected) {
			rejections++
		} else {
			mustDB(t, err)
		}
	}
	if successes != 1 || rejections != 1 {
		t.Fatal("duplicate membership did not serialize")
	}
	f.add(t, team, b.ID, false)
	leads := make(chan error, 2)
	start = make(chan struct{})
	for _, employee := range []string{a.ID, b.ID} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := f.service.AssignLead(t.Context(), f.root, LeadInput{TeamID: team, EmployeeID: &employee})
			leads <- err
		}()
	}
	close(start)
	wg.Wait()
	close(leads)
	for err := range leads {
		mustDB(t, err)
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM team_lead_assignment WHERE team_id=$1 AND ends_at IS NULL", team); got != "1" {
		t.Fatal("multiple current leads")
	}
	if got := f.scalar(t, "SELECT count(*)::text FROM team_lead_assignment WHERE team_id=$1 AND ends_at IS NOT NULL", team); got != "1" {
		t.Fatal("lead handover history missing")
	}
}

func TestSelfAssignmentRefusedIncludingRoot(t *testing.T) {
	f := newTeamFixture(t)
	for _, account := range []string{f.hrID, f.rootID} {
		team := f.create(t, "Self-"+account)
		employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: account})
		before := f.revision(t)
		if account == f.rootID {
			_, err := f.service.AddMember(t.Context(), f.root, MemberInput{TeamID: team, EmployeeID: employee.ID})
			if !errors.Is(err, apperror.ErrCommandRejected) {
				t.Fatal("Root self membership accepted")
			}
		}
		for _, kind := range []string{"iam", "root"} {
			_, err := database.Run(t.Context(), f.s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (Status, error) {
				ctx := authority.CommandContext{Tx: tx, Actor: authority.Actor{ID: account, Kind: kind}, Target: authority.Target{Key: team}}
				return runAddMember(ctx, MemberInput{TeamID: team, EmployeeID: employee.ID})
			}, database.RunOptions{})
			if !errors.Is(err, apperror.ErrCommandRejected) {
				t.Fatal("self membership accepted")
			}
		}
		if f.revision(t) != before || len(f.detail(t, team).Members) != 0 {
			t.Fatal("self refusal changed state")
		}
		f.mutate(t, func(tx *database.Tx) error { return addMembershipRow(tx, team, employee.ID, true) })
		before = f.revision(t)
		for _, kind := range []string{"iam", "root"} {
			for _, run := range []func(authority.CommandContext) (Status, error){
				func(ctx authority.CommandContext) (Status, error) {
					return runAssignLead(ctx, LeadInput{TeamID: team, EmployeeID: &employee.ID})
				},
				func(ctx authority.CommandContext) (Status, error) {
					return runEndMembership(ctx, MembershipRef{TeamID: team, EmployeeID: employee.ID})
				},
			} {
				_, err := database.Run(t.Context(), f.s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (Status, error) {
					return run(authority.CommandContext{Tx: tx, Actor: authority.Actor{ID: account, Kind: kind}, Target: authority.Target{Key: team}})
				}, database.RunOptions{})
				if !errors.Is(err, apperror.ErrCommandRejected) {
					t.Fatal("self lead/removal accepted")
				}
			}
		}
		if f.revision(t) != before || len(f.detail(t, team).Members) != 1 || f.detail(t, team).Lead != nil {
			t.Fatal("self member change modified state")
		}
	}
}

func TestLeadMustBeOpenMemberRefusalAtomic(t *testing.T) {
	f := newTeamFixture(t)
	team, other := f.create(t, "Lead"), f.create(t, "Other")
	a, b := fixture.Employee(t, f.s, fixture.EmployeeSpec{}), fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	refuse := func(id string) {
		t.Helper()
		before := f.revision(t)
		view := f.detail(t, team)
		_, err := f.service.AssignLead(t.Context(), f.root, LeadInput{TeamID: team, EmployeeID: &id})
		if !errors.Is(err, apperror.ErrCommandRejected) {
			t.Fatal("nonmember lead accepted")
		}
		if f.revision(t) != before || !reflect.DeepEqual(f.detail(t, team), view) {
			t.Fatal("refusal changed team")
		}
	}
	refuse(a.ID)
	f.add(t, other, a.ID, false)
	refuse(a.ID)
	f.add(t, team, b.ID, false)
	_, err := f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: b.ID})
	mustDB(t, err)
	refuse(b.ID)
	f.add(t, team, b.ID, false)
	f.lead(t, team, &b.ID)
	refuse(a.ID)
}

func TestCurrentLeadCannotLeaveBeforeHandover(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Handover")
	a, b := fixture.Employee(t, f.s, fixture.EmployeeSpec{}), fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	f.add(t, team, a.ID, false)
	f.add(t, team, b.ID, false)
	f.lead(t, team, &a.ID)
	before := f.revision(t)
	_, err := f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: a.ID})
	if !errors.Is(err, apperror.ErrCommandRejected) || f.revision(t) != before {
		t.Fatal("current lead left")
	}
	_, err = f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: b.ID})
	mustDB(t, err)
	f.add(t, team, b.ID, false)
	f.lead(t, team, &b.ID)
	_, err = f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: a.ID})
	mustDB(t, err)
	f.lead(t, team, nil)
	_, err = f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: b.ID})
	mustDB(t, err)
	if len(f.detail(t, team).Members) != 0 {
		t.Fatal("members remain")
	}
}

func TestTerminatedLeadKeepsRowsCanBeClearedAndRemoved(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Terminated")
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	f.add(t, team, employee.ID, false)
	f.lead(t, team, &employee.ID)
	f.exec(t, "UPDATE employee SET terminated_on=(statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date-1 WHERE id=$1", employee.ID)
	view := f.detail(t, team)
	if view.Lead == nil || view.Lead.EmployeeID != employee.ID || len(view.Members) != 1 {
		t.Fatal("termination ended team facts")
	}
	_, err := f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: employee.ID})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("terminated lead left without clearing")
	}
	f.lead(t, team, nil)
	_, err = f.service.EndMembership(t.Context(), f.root, MembershipRef{TeamID: team, EmployeeID: employee.ID})
	mustDB(t, err)
	_, err = f.service.AddMember(t.Context(), f.root, MemberInput{TeamID: team, EmployeeID: employee.ID})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("terminated employee added")
	}
}

func TestLegacyLeadRepairedByAddingMembership(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Legacy")
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	f.exec(t, "INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp())", team, employee.ID)
	orphanSQL := `SELECT count(*)::text FROM team_lead_assignment l JOIN team t ON t.id=l.team_id JOIN employee e ON e.id=l.lead_employee_id WHERE l.ends_at IS NULL AND NOT EXISTS(SELECT 1 FROM team_membership m WHERE m.team_id=l.team_id AND m.employee_id=l.lead_employee_id AND m.ends_at IS NULL)`
	if f.scalar(t, orphanSQL) != "1" {
		t.Fatal("orphan not found")
	}
	f.add(t, team, employee.ID, false)
	if f.scalar(t, orphanSQL) != "0" || f.detail(t, team).Lead.EmployeeID != employee.ID {
		t.Fatal("legacy lead repair failed")
	}
}

func TestScopedTeamReadCountAndPagination(t *testing.T) {
	f := newTeamFixture(t)
	a, b := f.create(t, "A"), f.create(t, "B")
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: f.memberID})
	f.add(t, a, employee.ID, false)
	page, err := f.service.List(t.Context(), f.member, ListQuery{Limit: 1})
	mustDB(t, err)
	if page.Total != "1" || len(page.Items) != 1 || page.Items[0].ID != a || page.Items[0].MemberCount != 1 {
		t.Fatalf("bad scoped list: %+v", page)
	}
	for _, id := range []string{b, testID} {
		_, err := f.service.Detail(t.Context(), f.member, id)
		if !errors.Is(err, apperror.ErrNotFound) {
			t.Fatal("hidden/absent detail distinguished")
		}
	}
	page, err = f.service.List(t.Context(), f.hr, ListQuery{Limit: 1, Offset: 1})
	mustDB(t, err)
	if page.Total != "2" || len(page.Items) != 1 || page.Items[0].ID != b {
		t.Fatal("count or pagination wrong")
	}
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('team.read','UTF8'),$1,'deny',convert_to('allTeams','UTF8'),1,'{}','runtime')`, f.memberID)
	page, err = f.service.List(t.Context(), f.member, ListQuery{Limit: 100})
	mustDB(t, err)
	if page.Total != "0" || len(page.Items) != 0 {
		t.Fatal("deny did not win")
	}
}

func TestAuditFailureRollsBackTeamMutation(t *testing.T) {
	f := newTeamFixture(t)
	team := f.create(t, "Atomic")
	employee := fixture.Employee(t, f.s, fixture.EmployeeSpec{})
	before := f.revision(t)
	sentinel := errors.New("audit unavailable")
	_, err := database.Run(t.Context(), f.s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (Status, error) {
		return runAddMember(authority.CommandContext{Tx: tx, Actor: authority.Actor{ID: f.rootID, Kind: "root"}, Target: authority.Target{Key: team}, Audit: func(audit.Kind, authority.AuditTarget, *authority.PermissionAuditDetail) error { return sentinel }}, MemberInput{TeamID: team, EmployeeID: employee.ID})
	}, database.RunOptions{})
	if !errors.Is(err, sentinel) || f.revision(t) != before || len(f.detail(t, team).Members) != 0 || f.detail(t, team).Version != "1" {
		t.Fatal("audit failure committed mutation")
	}
}
