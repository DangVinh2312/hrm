package employee

import (
	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
)

var errPeriodClosed = apperror.Rejection{Code: "error.periodClosed"}

// uniqueRejected turns a UNIQUE violation into a 409 that names no other record. A statement with RETURNING
// can fail at Query or at CollectRows, so callers pass both errors through it.
func uniqueRejected(err error) error {
	if database.IsUniqueViolation(err) {
		return apperror.ErrCommandRejected
	}
	return err
}

func uniqueVersion(tx *database.Tx, sql string, args ...any) (Versioned, error) {
	rows, err := tx.Query(sql, args...)
	if err != nil {
		return Versioned{}, uniqueRejected(err)
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return Versioned{}, uniqueRejected(err)
	}
	if len(versions) != 1 {
		return Versioned{}, apperror.ErrCommandRejected
	}
	return Versioned{Version: versions[0]}, nil
}

// bumpEmployee advances the version of the locked employee if it still is expected (nil: no check), else 409.
func bumpEmployee(tx *database.Tx, employeeID string, expected *string) (string, error) {
	sql, args := `WITH updated AS (UPDATE employee SET version = version + 1
         WHERE id = $1 RETURNING version::text AS version) SELECT * FROM updated`, []any{employeeID}
	if expected != nil {
		sql, args = `WITH updated AS (UPDATE employee SET version = version + 1
         WHERE id = $1 AND version = CAST($2 AS int8) RETURNING version::text AS version) SELECT * FROM updated`, []any{employeeID, *expected}
	}
	rows, err := tx.Query(sql, args...)
	if err != nil {
		return "", uniqueRejected(err)
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", uniqueRejected(err)
	}
	if len(versions) != 1 {
		return "", apperror.ErrCommandRejected
	}
	return versions[0], nil
}

// assertSheetsOpenFrom is D07 for the two commands that move the employment dates of an employee: a hire
// date or a last working day makes the sheet of every month from that date on different, so none of those
// months may be closed (409 error.periodClosed). attendance_period has no row for a month nobody touched
// and a close may start at any time, so the check is only sound under the company row: createEmployee
// already holds it FOR NO KEY UPDATE (its target) and a termination takes it FOR SHARE here, after the
// employee lock. A close holds it FOR NO KEY UPDATE through its snapshot, so it waits for this
// transaction or this one sees its committed result. Lock order is employee then company; a close takes
// company then period and nobody takes the employee after the company, so there is no cycle.
func assertSheetsOpenFrom(tx *database.Tx, from string, lockCompany bool) error {
	if lockCompany {
		if _, err := tx.Exec("SELECT 1 FROM hr_company WHERE id = $1 FOR SHARE", permission.CompanyID); err != nil {
			return err
		}
	}
	rows, err := tx.Query(`SELECT EXISTS (SELECT 1 FROM attendance_period
               WHERE state = 'closed' AND month >= date_trunc('month', CAST($1 AS date))::date) AS closed`, from)
	if err != nil {
		return err
	}
	closed, err := pgx.CollectRows(rows, pgx.RowTo[bool])
	if err != nil {
		return err
	}
	if len(closed) != 1 || closed[0] {
		return errPeriodClosed
	}
	return nil
}
