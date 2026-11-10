package administration

import (
	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/database"
)

// MaxBoundaryPackage is the most permissions one bound package may hold: a larger catalog entry is refused,
// never written in part.
const MaxBoundaryPackage = 64

// boundaryPackage is, for each permission of an active boundary, whether the catalog marks it required. At most
// MaxBoundaryPackage+1 rows; empty for a boundary that is unknown, not active or without entries.
func boundaryPackage(tx *database.Tx, ref BoundaryRef) ([]bool, error) {
	rows, err := tx.Query(`SELECT c.boundary_requirement = 'required' AS required
         FROM permission_boundary d
         JOIN permission_boundary_entry e ON e.boundary_key = d.boundary_key AND e.boundary_version = d.boundary_version
         JOIN permission_catalog c ON c.permission_key = e.permission_key
        WHERE d.boundary_key = $1 AND d.boundary_version = $2 AND d.lifecycle = 'active'
        ORDER BY e.permission_key LIMIT CAST($3 AS int)`, []byte(ref.Key), ref.Version, MaxBoundaryPackage+1)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[bool])
}

// boundaryBindings is, in one statement, how many permissions of ref the actor is bound to and how many
// permissions of the package the target is bound to under any boundary (one binding per user and permission).
func boundaryBindings(tx *database.Tx, actor, target string, ref BoundaryRef) (int, int, error) {
	rows, err := tx.Query(`SELECT (SELECT count(*)::int FROM user_boundary
                WHERE user_id = $1 AND boundary_key = $3 AND boundary_version = $4) AS actor_held,
              (SELECT count(*)::int FROM user_boundary b
                WHERE b.user_id = $2 AND b.permission_key IN (
                  SELECT permission_key FROM permission_boundary_entry
                   WHERE boundary_key = $3 AND boundary_version = $4)) AS target_bound`, actor, target, []byte(ref.Key), ref.Version)
	if err != nil {
		return 0, 0, err
	}
	type bindings struct{ Held, Bound int }
	row, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[bindings])
	return row.Held, row.Bound, err
}

// insertBoundary writes the whole package as runtime rows (seed_owner stays NULL) and returns how many; a row
// that exists already is a conflict (the primary key decides, whatever was read before).
func insertBoundary(tx *database.Tx, target string, ref BoundaryRef) (int, error) {
	rows, err := tx.Query(`INSERT INTO user_boundary(user_id, permission_key, boundary_key, boundary_version)
         SELECT $1, e.permission_key, e.boundary_key, e.boundary_version
           FROM permission_boundary_entry e WHERE e.boundary_key = $2 AND e.boundary_version = $3
         RETURNING 1`, target, []byte(ref.Key), ref.Version)
	if err == nil {
		var inserted []int
		inserted, err = pgx.CollectRows(rows, pgx.RowTo[int])
		if err == nil {
			return len(inserted), nil
		}
	}
	if database.IsUniqueViolation(err) {
		return 0, apperror.ErrCommandRejected
	}
	return 0, err
}

// deleteRuntimeBoundary deletes the runtime rows of the package; rows with a seed_owner are never named.
func deleteRuntimeBoundary(tx *database.Tx, target string, ref BoundaryRef) (int, error) {
	rows, err := tx.Query(`WITH gone AS (DELETE FROM user_boundary
                      WHERE user_id = $1 AND boundary_key = $2 AND boundary_version = $3 AND seed_owner IS NULL
                  RETURNING 1)
       SELECT count(*)::int AS gone FROM gone`, target, []byte(ref.Key), ref.Version)
	if err != nil {
		return 0, err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowTo[int])
}
