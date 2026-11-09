//go:build integration

package employee

import (
	"encoding/json/v2"
	"errors"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

func readService(t *testing.T, s *testdb.Stack) (*Service, *authority.Authorization) {
	t.Helper()
	c, err := declarations.NewCore()
	mustDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	mustDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	mustDB(t, err)
	ops := NewOperations()
	a, err := authority.New(s.Runner, bindings, authority.DefaultCapabilities(), nil, ops.All()...)
	mustDB(t, err)
	return ops.Bind(a), a
}

func TestEmployeeReadScopesProjectionAndLiteralSearch(t *testing.T) {
	s := testdb.NewDatabase(t)
	service, auth := readService(t, s)
	conn := superuser(t, s)
	hr := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.admin"}})
	person := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	other := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	nobody := fixture.Account(t, s, fixture.AccountSpec{})
	h := fixture.Session(t, s, hr.ID, fixture.SessionSpec{})
	p := fixture.Session(t, s, person.ID, fixture.SessionSpec{})
	n := fixture.Session(t, s, nobody.ID, fixture.SessionSpec{})
	name := "Nguye" + string(rune(0x302)) + string(rune(0x303)) + "n " + string(rune(0x1f600))
	e := fixture.Employee(t, s, fixture.EmployeeSpec{Code: "E-01", FullName: name, AccountID: person.ID})
	x := fixture.Employee(t, s, fixture.EmployeeSpec{Code: "E-02", AccountID: other.ID})
	for _, id := range []string{e.ID, x.ID} {
		_, err := conn.Exec(t.Context(), "INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official','2026-01-05')", id)
		mustDB(t, err)
		if id == e.ID {
			_, err = conn.Exec(t.Context(), "INSERT INTO employee_identity(employee_id,object_id,document_kind,document_number,tax_code) VALUES($1,public.hr_register_object('employeeIdentity',$1),'cccd','ABC1234567','0123456789')", id)
			mustDB(t, err)
		}
	}
	page, err := service.List(t.Context(), h, ListQuery{Limit: 1})
	mustDB(t, err)
	if page.Total != "2" || len(page.Items) != 1 || page.Items[0].ID != e.ID || page.Items[0].FullName != name {
		t.Fatalf("page: %+v", page)
	}
	page, err = service.List(t.Context(), p, ListQuery{Limit: 20})
	mustDB(t, err)
	if page.Total != "1" || len(page.Items) != 1 || page.Items[0].ID != e.ID {
		t.Fatalf("self page: %+v", page)
	}
	for _, secret := range []string{p, n} {
		for _, id := range []string{x.ID, testID} {
			if _, err := service.Detail(t.Context(), secret, id); !errors.Is(err, apperror.ErrNotFound) {
				t.Fatalf("hidden/absent: %v", err)
			}
		}
	}
	for _, secret := range []string{h, p} {
		view, err := service.Detail(t.Context(), secret, e.ID)
		mustDB(t, err)
		body, err := json.Marshal(view)
		mustDB(t, err)
		if view.FullName != name || strings.Contains(string(body), "documentNumber") || strings.Contains(string(body), "ABC1234567") {
			t.Fatal("F1 projection leaked or corrupted text")
		}
		identity, err := service.Identity(t.Context(), secret, e.ID)
		mustDB(t, err)
		if identity.DocumentNumber == nil || *identity.DocumentNumber != "ABC1234567" {
			t.Fatal("identity missing")
		}
	}
	if _, err := service.Identity(t.Context(), n, e.ID); !errors.Is(err, apperror.ErrNotFound) {
		t.Fatalf("identity without grant: %v", err)
	}
	for _, search := range []string{"%", "_", "\\", "E-02"} {
		page, err := service.List(t.Context(), p, ListQuery{Limit: 20, Search: search})
		mustDB(t, err)
		if page.Total != "0" || len(page.Items) != 0 {
			t.Fatalf("search escaped scope or wildcard: %q", search)
		}
	}
	row, err := auth.Detail(t.Context(), h, "employee", "read", e.ID)
	mustDB(t, err)
	if len(row) != 3 {
		t.Fatalf("gateway projection: %v", row)
	}
	profile, err := service.Profile(t.Context(), p)
	mustDB(t, err)
	if profile.Employee == nil || profile.Employee.ID != e.ID || profile.CompanyScope {
		t.Fatalf("profile: %+v", profile)
	}
}
