//go:build integration

package employee

import (
	"errors"
	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/database"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
	"testing"
)

func createInput(code string, status Status) CreateInput {
	input := CreateInput{Code: code, FullName: "Fixture " + code, HiredOn: "2026-01-05", Status: status}
	if status == StatusOfficial {
		input.AnnualLeave = &LeaveMinutes{Default: true}
	}
	return input
}

func TestEmployeeCreateUpdateAndAuditRollback(t *testing.T) {
	s := testdb.NewDatabase(t)
	service, _ := readService(t, s)
	conn := superuser(t, s)
	a := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.admin"}})
	plain := fixture.Session(t, s, a.ID, fixture.SessionSpec{})
	fresh := fixture.Session(t, s, a.ID, fixture.SessionSpec{Fresh: true})
	input := createInput("WRITE-1", StatusOfficial)
	number := "ABC1234567"
	kind := DocumentCCCD
	input.Identity = Identity{DocumentKind: &kind, DocumentNumber: &number}
	if _, err := service.Create(t.Context(), plain, input); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatalf("create needs fresh: %v", err)
	}
	created, err := service.Create(t.Context(), fresh, input)
	mustDB(t, err)
	if created.ID == "" {
		t.Fatal("created id missing")
	}
	view, err := service.Detail(t.Context(), plain, created.ID)
	mustDB(t, err)
	if len(view.Periods) != 1 || view.Periods[0].Status != StatusOfficial || view.Version != "1" {
		t.Fatalf("create: %+v", view)
	}
	rates, err := service.LeaveRates(t.Context(), plain, created.ID)
	mustDB(t, err)
	if len(rates.Items) != 1 || rates.Items[0].AnnualMinutes != 5760 {
		t.Fatalf("initial rate: %+v", rates)
	}
	before := scalar[int](t, conn, "SELECT count(*)::int FROM audit_outbox")
	if _, err := service.Create(t.Context(), fresh, input); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("duplicate: %v", err)
	}
	if count := scalar[int](t, conn, "SELECT count(*)::int FROM audit_outbox"); count != before {
		t.Fatal("duplicate left audit")
	}
	input.Code = "WRITE-2"
	if _, err := service.Create(t.Context(), fresh, input); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("duplicate identity: %v", err)
	}
	if count := scalar[int](t, conn, "SELECT count(*)::int FROM employee"); count != 1 {
		t.Fatal("partial create persisted")
	}
	u := UpdateInput{EmployeeID: created.ID, ExpectedVersion: "1", Code: "WRITE-3", FullName: "Updated"}
	updated, err := service.Update(t.Context(), plain, u)
	mustDB(t, err)
	if updated.Version != "2" {
		t.Fatal("version not bumped")
	}
	if _, err := service.Update(t.Context(), plain, u); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("stale update accepted")
	}
	if _, err := service.UpdateIdentity(t.Context(), plain, IdentityUpdateInput{EmployeeID: created.ID, ExpectedVersion: "1"}); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatalf("identity needs fresh: %v", err)
	}
	_, err = service.UpdateIdentity(t.Context(), fresh, IdentityUpdateInput{EmployeeID: created.ID, ExpectedVersion: "1", Identity: input.Identity})
	mustDB(t, err)
	if _, err := service.UpdateIdentity(t.Context(), fresh, IdentityUpdateInput{EmployeeID: created.ID, ExpectedVersion: "1", Identity: input.Identity}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("stale identity accepted")
	}
	if _, err := service.AdjustLeaveRate(t.Context(), plain, LeaveRateInput{EmployeeID: created.ID, EffectiveFrom: "2026-02-01", AnnualMinutes: 6000}); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("rate needs fresh")
	}
	_, err = service.AdjustLeaveRate(t.Context(), fresh, LeaveRateInput{EmployeeID: created.ID, EffectiveFrom: "2026-02-01", AnnualMinutes: 6000})
	mustDB(t, err)
	if _, err := service.AdjustLeaveRate(t.Context(), fresh, LeaveRateInput{EmployeeID: created.ID, EffectiveFrom: "2026-02-01", AnnualMinutes: 7000}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("duplicate rate date accepted")
	}
	if leaked := scalar[int](t, conn, "SELECT count(*)::int FROM audit_outbox WHERE safe_metadata::text LIKE '%ABC1234567%'"); leaked != 0 {
		t.Fatal("PII leaked into audit")
	}
	_, err = conn.Exec(t.Context(), `CREATE FUNCTION public.fail_employee_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture audit unavailable''; END'; CREATE TRIGGER fail_employee_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION public.fail_employee_audit()`)
	mustDB(t, err)
	u.ExpectedVersion = "2"
	u.FullName = "Must rollback"
	if _, err := service.Update(t.Context(), plain, u); err == nil {
		t.Fatal("audit failure accepted")
	}
	if name := scalar[string](t, conn, "SELECT full_name FROM employee WHERE id=$1", created.ID); name != "Updated" {
		t.Fatal("audit failure committed mutation")
	}
}

func TestEmployeeStatusChainRateAndClosedMonth(t *testing.T) {
	s := testdb.NewDatabase(t)
	service, _ := readService(t, s)
	conn := superuser(t, s)
	a := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.admin"}})
	plain := fixture.Session(t, s, a.ID, fixture.SessionSpec{})
	fresh := fixture.Session(t, s, a.ID, fixture.SessionSpec{Fresh: true})
	e, err := service.Create(t.Context(), fresh, createInput("STATUS", StatusProbation))
	mustDB(t, err)
	if rates := ratesOf(t, s, e.ID); len(rates) != 0 {
		t.Fatal("probation rate")
	}
	if _, err := service.AdjustLeaveRate(t.Context(), fresh, LeaveRateInput{EmployeeID: e.ID, EffectiveFrom: "2026-01-04", AnnualMinutes: 6000}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("before hire accepted")
	}
	_, err = conn.Exec(t.Context(), closeMonth, "2026-03-01")
	mustDB(t, err)
	if _, err := service.Official(t.Context(), plain, OfficialInput{EmployeeID: e.ID, EffectiveOn: "2026-02-01"}); !errors.Is(err, errPeriodClosed) {
		t.Fatalf("closed month: %v", err)
	}
	_, err = conn.Exec(t.Context(), "DELETE FROM attendance_period")
	mustDB(t, err)
	if _, err := service.Official(t.Context(), plain, OfficialInput{EmployeeID: e.ID, EffectiveOn: "2026-01-05"}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("zero probation accepted")
	}
	version, err := service.Official(t.Context(), plain, OfficialInput{EmployeeID: e.ID, EffectiveOn: "2026-02-01"})
	mustDB(t, err)
	if version.Version != "2" {
		t.Fatal("official version")
	}
	view, err := service.Detail(t.Context(), plain, e.ID)
	mustDB(t, err)
	if len(view.Periods) != 2 || view.Periods[0].EndsOn == nil || *view.Periods[0].EndsOn != "2026-02-01" {
		t.Fatal("period chain broken")
	}
	if rates := ratesOf(t, s, e.ID); len(rates) != 1 || rates[0] != (rateRow{"2026-02-01", 5760}) {
		t.Fatalf("default rate: %v", rates)
	}
	_, err = service.Terminate(t.Context(), plain, TerminationInput{EmployeeID: e.ID, TerminatedOn: "2026-03-15"})
	mustDB(t, err)
	view, err = service.Detail(t.Context(), plain, e.ID)
	mustDB(t, err)
	if view.TerminatedOn == nil || *view.TerminatedOn != "2026-03-15" || view.Periods[1].EndsOn == nil || *view.Periods[1].EndsOn != "2026-03-16" {
		t.Fatal("termination not inclusive")
	}
	if _, err := service.Terminate(t.Context(), plain, TerminationInput{EmployeeID: e.ID, TerminatedOn: "2026-03-16"}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("second termination accepted")
	}
	if _, err := service.Official(t.Context(), plain, OfficialInput{EmployeeID: e.ID, EffectiveOn: "2026-03-16"}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("terminated official accepted")
	}
	if count := scalar[int](t, conn, "SELECT count(*)::int FROM audit_outbox WHERE event_kind=convert_to('hr.leave-rate.adjust','UTF8')"); count != 1 {
		t.Fatal("default rate audit missing")
	}
}

func TestEmployeeLinkAccountBoundarySelfAndEpoch(t *testing.T) {
	s := testdb.NewDatabase(t)
	service, _ := readService(t, s)
	conn := superuser(t, s)
	root := fixture.Root(t, s)
	r := fixture.Session(t, s, root.ID, fixture.SessionSpec{Fresh: true})
	hr := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.admin"}})
	h := fixture.Session(t, s, hr.ID, fixture.SessionSpec{Fresh: true})
	account := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	e := fixture.Employee(t, s, fixture.EmployeeSpec{})
	input := AccountLinkInput{EmployeeID: e.ID, ExpectedVersion: "1", AccountID: &account.ID}
	if _, err := service.LinkAccount(t.Context(), h, input); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatalf("unbound HR link: %v", err)
	}
	before := scalar[string](t, conn, "SELECT auth_epoch::text FROM app_user WHERE id=$1", account.ID)
	if _, err := service.LinkAccount(t.Context(), r, AccountLinkInput{EmployeeID: e.ID, ExpectedVersion: "1", AccountID: &root.ID}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("Root/self target accepted")
	}
	_, err := service.LinkAccount(t.Context(), r, input)
	mustDB(t, err)
	if epoch := scalar[string](t, conn, "SELECT auth_epoch::text FROM app_user WHERE id=$1", account.ID); epoch != before {
		t.Fatal("link changed auth_epoch")
	}
	if _, err := service.LinkAccount(t.Context(), r, input); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("stale link accepted")
	}
	input.ExpectedVersion = "2"
	if _, err := service.LinkAccount(t.Context(), r, input); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("unchanged link accepted")
	}
	selfEmployee := fixture.Employee(t, s, fixture.EmployeeSpec{AccountID: hr.ID})
	_, err = inMode(t.Context(), s, database.ModeAdmin, func(tx *database.Tx) (Versioned, error) {
		return runLinkAccount(authority.CommandContext{Tx: tx, Actor: authority.Actor{ID: hr.ID, Kind: "iam"}, Target: authority.Target{Key: selfEmployee.ID, ObjectID: selfEmployee.ObjectID}, Audit: func(audit.Kind, authority.AuditTarget, *authority.PermissionAuditDetail) error {
			return errors.New("guard reached effect")
		}}, AccountLinkInput{EmployeeID: selfEmployee.ID, ExpectedVersion: "1"})
	})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("unlink self accepted: %v", err)
	}
	other := fixture.Employee(t, s, fixture.EmployeeSpec{})
	if _, err := service.LinkAccount(t.Context(), r, AccountLinkInput{EmployeeID: other.ID, ExpectedVersion: "1", AccountID: &account.ID}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatal("duplicate account link accepted")
	}
	for _, accountID := range []string{testID, hr.ID} {
		if accountID == hr.ID {
			_, err := conn.Exec(t.Context(), "UPDATE app_user SET state='suspended' WHERE id=$1", hr.ID)
			mustDB(t, err)
		}
		if _, err := service.LinkAccount(t.Context(), r, AccountLinkInput{EmployeeID: other.ID, ExpectedVersion: "1", AccountID: &accountID}); !errors.Is(err, apperror.ErrCommandRejected) {
			t.Fatalf("unavailable account accepted: %v", err)
		}
	}
}
