//go:build integration

package employee

import (
	"errors"
	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/database"
	testdb "hrm/api/test"
	"hrm/api/test/fixture"
	"slices"
	"testing"
)

func TestEmployeeLeadCooAndIdentityRateScopesDenyAndRootAudit(t *testing.T) {
	s := testdb.NewDatabase(t)
	service, auth := readService(t, s)
	conn := superuser(t, s)
	var ids, secrets, employees []string
	for i, roles := range [][]string{{"hr.employee"}, {"hr.employee"}, {"hr.employee", "hr.coo"}, {"hr.employee", "hr.admin"}} {
		a := fixture.Account(t, s, fixture.AccountSpec{Roles: roles})
		ids = append(ids, a.ID)
		secrets = append(secrets, fixture.Session(t, s, a.ID, fixture.SessionSpec{}))
		e := fixture.Employee(t, s, fixture.EmployeeSpec{AccountID: a.ID})
		employees = append(employees, e.ID)
		_, err := conn.Exec(t.Context(), "INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official','2026-01-05')", e.ID)
		mustDB(t, err)
		_, err = conn.Exec(t.Context(), "INSERT INTO employee_identity(employee_id,object_id) VALUES($1,public.hr_register_object('employeeIdentity',$1))", e.ID)
		mustDB(t, err)
		_, err = inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (authority.AuditTarget, error) {
			return insertRate(tx, e.ID, "2026-01-05", 5760+i)
		})
		mustDB(t, err)
	}
	team := newUUID()
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO team(id,object_id,name) VALUES($1,public.hr_register_object('team',$1),'Read scope')", []any{team}},
		{"INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour'),(gen_random_uuid(),$1,$3,true,statement_timestamp()-interval '1 hour')", []any{team, employees[0], employees[1]}},
		{"INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')", []any{team, employees[0]}},
	} {
		_, err := conn.Exec(t.Context(), step.sql, step.args...)
		mustDB(t, err)
	}
	for i, expected := range [][]string{{employees[0], employees[1]}, {employees[1]}, employees, employees} {
		page, err := service.List(t.Context(), secrets[i], ListQuery{Limit: 100})
		mustDB(t, err)
		var got []string
		for _, item := range page.Items {
			got = append(got, item.ID)
		}
		slices.Sort(got)
		want := slices.Clone(expected)
		slices.Sort(want)
		if !slices.Equal(got, want) || page.Total != []string{"2", "1", "4", "4"}[i] {
			t.Fatalf("role %d sees %v", i, got)
		}
		count, err := auth.Count(t.Context(), secrets[i], "employee", "read")
		mustDB(t, err)
		if count != page.Total {
			t.Fatal("count scope differs")
		}
		for _, id := range employees {
			_, err := service.Detail(t.Context(), secrets[i], id)
			if slices.Contains(expected, id) {
				mustDB(t, err)
			} else if !errors.Is(err, apperror.ErrNotFound) {
				t.Fatalf("detail scope: %v", err)
			}
		}
	}
	for _, index := range []int{0, 2} {
		if _, err := service.Identity(t.Context(), secrets[index], employees[1]); !errors.Is(err, apperror.ErrNotFound) {
			t.Fatalf("F2 outsider: %v", err)
		}
		rates, err := service.LeaveRates(t.Context(), secrets[index], employees[1])
		mustDB(t, err)
		if len(rates.Items) != 0 {
			t.Fatal("F3 outsider sees rates")
		}
	}
	for _, index := range []int{1, 3} {
		_, err := service.Identity(t.Context(), secrets[index], employees[1])
		mustDB(t, err)
		rates, err := service.LeaveRates(t.Context(), secrets[index], employees[1])
		mustDB(t, err)
		if len(rates.Items) != 1 {
			t.Fatal("F3 owner/HR missing rate")
		}
	}
	_, err := conn.Exec(t.Context(), `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
 VALUES(gen_random_uuid(),convert_to('employee.read','UTF8'),$1,'deny',convert_to('allEmployees','UTF8'),1,'{}','runtime')`, ids[0])
	mustDB(t, err)
	page, err := service.List(t.Context(), secrets[0], ListQuery{Limit: 100})
	mustDB(t, err)
	if page.Total != "0" || len(page.Items) != 0 {
		t.Fatal("deny did not win")
	}
	_, err = conn.Exec(t.Context(), "DELETE FROM policy_rule WHERE user_id=$1", ids[0])
	mustDB(t, err)
	page, err = service.List(t.Context(), secrets[0], ListQuery{Limit: 100})
	mustDB(t, err)
	if page.Total != "2" {
		t.Fatal("revoke not observed")
	}
	root := fixture.Root(t, s)
	secret := fixture.Session(t, s, root.ID, fixture.SessionSpec{})
	_, err = service.Detail(t.Context(), secret, employees[0])
	mustDB(t, err)
	if _, err := service.Detail(t.Context(), secret, testID); !errors.Is(err, apperror.ErrNotFound) {
		t.Fatal("Root absent")
	}
	if got := scalar[int](t, conn, "SELECT count(*)::int FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.employee.read','UTF8')", root.ID); got != 2 {
		t.Fatalf("Root audit: %d", got)
	}
}
