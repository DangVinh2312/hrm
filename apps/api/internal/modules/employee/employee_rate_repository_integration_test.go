//go:build integration

package employee

import (
	"errors"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/settingcore"
	testdb "hrm/api/test"
	"hrm/api/test/fixture"
)

const upsertDefaultRate = `INSERT INTO system_setting(key,value,version,updated_by) VALUES($1,CAST($2 AS jsonb),1,$3)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`

type rateRow struct {
	from    string
	minutes int
}

func ratesOf(t *testing.T, s *testdb.Stack, employeeID string) []rateRow {
	t.Helper()
	conn := superuser(t, s)
	rows, err := conn.Query(t.Context(), "SELECT to_char(effective_from,'YYYY-MM-DD'), annual_minutes FROM leave_rate WHERE employee_id=$1 ORDER BY effective_from", employeeID)
	mustDB(t, err)
	defer rows.Close()
	var found []rateRow
	for rows.Next() {
		var row rateRow
		mustDB(t, rows.Scan(&row.from, &row.minutes))
		found = append(found, row)
	}
	mustDB(t, rows.Err())
	return found
}

func defaultRate(t *testing.T, s *testdb.Stack, employeeID, from string) (*authority.AuditTarget, error) {
	t.Helper()
	return inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (*authority.AuditTarget, error) {
		return defaultRateAt(tx, employeeID, from)
	})
}

func TestDefaultRateAtWritesTheSettingInForceOnlyWhenNoEarlierRateExists(t *testing.T) {
	s := testdb.NewDatabase(t)
	conn := superuser(t, s)
	actor := fixture.Account(t, s, fixture.AccountSpec{})
	employee := fixture.Employee(t, s, fixture.EmployeeSpec{})

	target, err := defaultRate(t, s, employee.ID, "2026-03-01")
	mustDB(t, err)
	if target == nil || target.Resource != "leaveRate" || target.Key == "" || target.ObjectID == "" {
		t.Fatalf("target = %+v", target)
	}
	if got := ratesOf(t, s, employee.ID); len(got) != 1 || got[0] != (rateRow{"2026-03-01", 5760}) {
		t.Fatalf("registry default: %+v", got)
	}
	if kind := scalar[string](t, conn, "SELECT convert_from(type_key,'UTF8') FROM object_ref WHERE object_id=$1", target.ObjectID); kind != "leaveRate" {
		t.Fatalf("object registered as %q", kind)
	}

	_, err = conn.Exec(t.Context(), upsertDefaultRate, string(settingcore.KeyAnnualLeaveDefaultMinutes), "7200", actor.ID)
	mustDB(t, err)
	for _, from := range []string{"2026-03-01", "2026-03-02", "2027-01-01"} {
		if target, err := defaultRate(t, s, employee.ID, from); err != nil || target != nil {
			t.Fatalf("an earlier rate exists, from %s: %+v %v", from, target, testdb.Redact(err))
		}
	}
	target, err = defaultRate(t, s, employee.ID, "2026-02-01")
	mustDB(t, err)
	if target == nil {
		t.Fatal("a rate dated after `from` must not stop the default")
	}
	got := ratesOf(t, s, employee.ID)
	if len(got) != 2 || got[0] != (rateRow{"2026-02-01", 7200}) || got[1] != (rateRow{"2026-03-01", 5760}) {
		t.Fatalf("setting in force, old row untouched: %+v", got)
	}
}

func TestInsertForUsesGivenOrDefaultMinutesAndRefusesADuplicateDate(t *testing.T) {
	s := testdb.NewDatabase(t)
	conn := superuser(t, s)
	actor := fixture.Account(t, s, fixture.AccountSpec{})
	employee := fixture.Employee(t, s, fixture.EmployeeSpec{})
	insert := func(from string, minutes LeaveMinutes) error {
		_, err := inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (authority.AuditTarget, error) {
			return insertFor(tx, employee.ID, from, minutes)
		})
		return err
	}
	mustDB(t, insert("2026-01-05", LeaveMinutes{Minutes: 6000}))
	mustDB(t, insert("2026-02-01", LeaveMinutes{Default: true}))
	_, err := conn.Exec(t.Context(), upsertDefaultRate, string(settingcore.KeyAnnualLeaveDefaultMinutes), "9000", actor.ID)
	mustDB(t, err)
	mustDB(t, insert("2026-03-01", LeaveMinutes{Default: true}))
	want := []rateRow{{"2026-01-05", 6000}, {"2026-02-01", 5760}, {"2026-03-01", 9000}}
	got := ratesOf(t, s, employee.ID)
	if len(got) != len(want) {
		t.Fatalf("rates: %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("rate %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if err := insert("2026-01-05", LeaveMinutes{Minutes: 7000}); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("duplicate effective date: %v", err)
	}
	if err := insert("2026-04-01", LeaveMinutes{Minutes: 5759}); err == nil || errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("a rate outside the table CHECK must fail as a fault, not as a conflict: %v", err)
	}
	if count := scalar[int](t, conn, "SELECT count(*)::int FROM leave_rate WHERE employee_id=$1", employee.ID); count != 3 {
		t.Fatalf("%d rate rows", count)
	}
}
