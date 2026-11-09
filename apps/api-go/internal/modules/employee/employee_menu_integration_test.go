//go:build integration

package employee

import (
	"hrm/api-go/internal/authorization/keys"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
	"slices"
	"testing"
)

func TestEmployeeMenusRootEmptyDirectoryAndPermissionRevocation(t *testing.T) {
	s := testdb.NewDatabase(t)
	service, auth := readService(t, s)
	conn := superuser(t, s)
	root := fixture.Root(t, s)
	r := fixture.Session(t, s, root.ID, fixture.SessionSpec{})
	menus, err := service.Menus(t.Context(), r)
	mustDB(t, err)
	want := []keys.MeMenu{"approvals", "employees", "teams", "calendar", "reports", "accounts", "settings", "roles"}
	if !slices.Equal(menus, want) {
		t.Fatalf("Root empty directory menus: %v", menus)
	}
	allowed, err := auth.Permits(t.Context(), r, "account", "read")
	mustDB(t, err)
	if allowed {
		t.Fatal("single permit reached an empty IAM directory")
	}
	for _, roles := range [][]string{nil, {"hr.employee"}, {"hr.employee", "hr.admin"}, {"hr.employee", "hr.coo"}} {
		account := fixture.Account(t, s, fixture.AccountSpec{Roles: roles})
		secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
		menus, err := service.Menus(t.Context(), secret)
		mustDB(t, err)
		if got := slices.Contains(menus, keys.MeMenuSettings); got != (len(roles) == 2) {
			t.Fatalf("settings with roles %v: %v", roles, menus)
		}
		if len(roles) == 0 && len(menus) != 0 {
			t.Fatalf("roleless: %v", menus)
		}
	}
	account := fixture.Account(t, s, fixture.AccountSpec{})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	_, err = conn.Exec(t.Context(), `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
 VALUES(gen_random_uuid(),convert_to('setting.read','UTF8'),$1,'allow',convert_to('setting','UTF8'),1,'{}','runtime')`, account.ID)
	mustDB(t, err)
	menus, err = service.Menus(t.Context(), secret)
	mustDB(t, err)
	if !slices.Equal(menus, []keys.MeMenu{"settings"}) {
		t.Fatalf("runtime grant: %v", menus)
	}
	_, err = conn.Exec(t.Context(), "DELETE FROM policy_rule WHERE user_id=$1", account.ID)
	mustDB(t, err)
	menus, err = service.Menus(t.Context(), secret)
	mustDB(t, err)
	if len(menus) != 0 {
		t.Fatalf("revoked menus cached: %v", menus)
	}
}

func TestLinkedEmployeeMenuFitsSeventeenProbes(t *testing.T) {
	s := testdb.NewDatabase(t)
	service, _ := readService(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.admin"}})
	secret := fixture.Session(t, s, account.ID, fixture.SessionSpec{})
	e := fixture.Employee(t, s, fixture.EmployeeSpec{AccountID: account.ID})
	conn := superuser(t, s)
	_, err := conn.Exec(t.Context(), "INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official','2026-01-05')", e.ID)
	mustDB(t, err)
	menus, err := service.Menus(t.Context(), secret)
	mustDB(t, err)
	want := []keys.MeMenu{"requests", "employees", "teams", "calendar", "leave", "attendance", "reports", "settings", "roles"}
	if !slices.Equal(menus, want) {
		t.Fatalf("linked admin: %v", menus)
	}
}
