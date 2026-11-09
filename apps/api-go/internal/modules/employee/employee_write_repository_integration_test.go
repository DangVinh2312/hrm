//go:build integration

package employee

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/permission"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const closeMonth = `INSERT INTO attendance_period(month,state,version,snapshot,snapshot_hash)
  VALUES(CAST($1 AS date),'closed',2,'{}'::jsonb,repeat('a',64))
  ON CONFLICT (month) DO UPDATE SET state='closed',version=2,snapshot='{}'::jsonb,snapshot_hash=repeat('a',64)`

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func superuser(t *testing.T, s *testdb.Stack) *pgx.Conn {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, conn.Close(context.WithoutCancel(t.Context()))) })
	return conn
}

func inMode[T any](ctx context.Context, s *testdb.Stack, mode database.Mode, work func(tx *database.Tx) (T, error)) (T, error) {
	return database.Run(ctx, s.Runner, mode, func(_ context.Context, tx *database.Tx) (T, error) { return work(tx) }, database.RunOptions{})
}

func scalar[T any](t *testing.T, conn *pgx.Conn, sql string, args ...any) T {
	t.Helper()
	var value T
	mustDB(t, conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}

func sheetsOpen(ctx context.Context, s *testdb.Stack, from string, lockCompany bool) error {
	_, err := inMode(ctx, s, database.ModeWrite, func(tx *database.Tx) (struct{}, error) {
		return struct{}{}, assertSheetsOpenFrom(tx, from, lockCompany)
	})
	return err
}

func TestAssertSheetsOpenFromRefusesEveryClosedMonthFromTheDate(t *testing.T) {
	s := testdb.NewDatabase(t)
	conn := superuser(t, s)
	for _, from := range []string{"2026-03-15", "2026-04-01"} {
		mustDB(t, sheetsOpen(t.Context(), s, from, true))
	}
	if _, err := conn.Exec(t.Context(), closeMonth, "2026-03-01"); err != nil {
		t.Fatal(testdb.Redact(err))
	}
	for _, from := range []string{"2026-03-15", "2026-03-01", "2026-03-31", "2026-02-10", "2025-01-01"} {
		if err := sheetsOpen(t.Context(), s, from, true); !errors.Is(err, errPeriodClosed) {
			t.Errorf("from %s with March closed: %v", from, err)
		}
	}
	for _, from := range []string{"2026-04-01", "2026-04-30", "2027-01-01"} {
		if err := sheetsOpen(t.Context(), s, from, true); err != nil {
			t.Errorf("from %s after the closed month: %v", from, testdb.Redact(err))
		}
	}
	if status, code, known := apperror.Response(errPeriodClosed); status != 409 || code != "error.periodClosed" || !known {
		t.Errorf("period closed answers %d %s %v", status, code, known)
	}
	if _, err := conn.Exec(t.Context(), `UPDATE attendance_period SET state='open',snapshot=NULL,snapshot_hash=NULL WHERE month='2026-03-01'`); err != nil {
		t.Fatal(testdb.Redact(err))
	}
	mustDB(t, sheetsOpen(t.Context(), s, "2026-03-15", true))
}

func TestAssertSheetsOpenFromWaitsForTheCompanyRowOnlyWhenAskedTo(t *testing.T) {
	s := testdb.NewDatabase(t)
	conn := superuser(t, s)
	mustDB(t, func() error { _, err := conn.Exec(t.Context(), "BEGIN"); return err }())
	_, err := conn.Exec(t.Context(), "SELECT 1 FROM hr_company WHERE id = $1 FOR NO KEY UPDATE", permission.CompanyID)
	mustDB(t, err)
	mustDB(t, sheetsOpen(t.Context(), s, "2026-03-15", false))
	started := time.Now()
	err = sheetsOpen(t.Context(), s, "2026-03-15", true)
	var conflict *database.ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("a held company row did not stop the termination check: %v after %s", err, time.Since(started))
	}
	_, err = conn.Exec(t.Context(), "COMMIT")
	mustDB(t, err)
	mustDB(t, sheetsOpen(t.Context(), s, "2026-03-15", true))
}

func TestBumpEmployeeChecksTheVersion(t *testing.T) {
	s := testdb.NewDatabase(t)
	employee := fixture.Employee(t, s, fixture.EmployeeSpec{})
	conn := superuser(t, s)
	bump := func(expected *string) (string, error) {
		return inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (string, error) { return bumpEmployee(tx, employee.ID, expected) })
	}
	stale, current := "7", "1"
	if _, err := bump(&stale); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("stale version: %v", err)
	}
	if version := scalar[string](t, conn, "SELECT version::text FROM employee WHERE id=$1", employee.ID); version != "1" {
		t.Fatalf("a stale bump moved the version to %s", version)
	}
	if version, err := bump(&current); err != nil || version != "2" {
		t.Fatalf("expected 1: %q %v", version, testdb.Redact(err))
	}
	if _, err := bump(&current); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("the same version twice: %v", err)
	}
	if version, err := bump(nil); err != nil || version != "3" {
		t.Fatalf("no expected version: %q %v", version, testdb.Redact(err))
	}
	missing := "1"
	_, err := inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (string, error) {
		return bumpEmployee(tx, "10000000-0000-4000-8000-000000000001", &missing)
	})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("absent employee: %v", err)
	}
}

func TestAUniqueViolationOfEitherPathIsRejected(t *testing.T) {
	s := testdb.NewDatabase(t)
	first := fixture.Employee(t, s, fixture.EmployeeSpec{Code: "UQ-1"})
	second := fixture.Employee(t, s, fixture.EmployeeSpec{Code: "UQ-2"})
	_, err := inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (struct{}, error) {
		_, err := tx.Exec("UPDATE employee SET code=$2 WHERE id=$1", second.ID, first.Code)
		return struct{}{}, uniqueRejected(err)
	})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("Exec path: %v", err)
	}
	_, err = inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (struct{}, error) {
		rows, err := tx.Query("UPDATE employee SET code=$2 WHERE id=$1 RETURNING id::text", second.ID, first.Code)
		if err != nil {
			return struct{}{}, uniqueRejected(err)
		}
		_, err = pgx.CollectRows(rows, pgx.RowTo[string])
		return struct{}{}, uniqueRejected(err)
	})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Fatalf("Query or CollectRows path: %v", err)
	}
}
