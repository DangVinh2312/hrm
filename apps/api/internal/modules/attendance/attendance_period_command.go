package attendance

import (
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/hrbase"
	"hrm/api/internal/modules/permission"
)

var errMissingRow = errors.New("attendance period or calendar row is missing")

type lockedPeriod struct {
	State   string
	Version string
}

// lockPeriodForUpdate is the row of the month FOR UPDATE, created when missing: HR close and reopen only.
// It waits for every writer holding the month FOR SHARE, and nothing new takes it until this commits.
func lockPeriodForUpdate(tx *database.Tx, month string) (lockedPeriod, error) {
	if _, err := tx.Exec(`INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING`, month+"-01"); err != nil {
		return lockedPeriod{}, err
	}
	rows, err := tx.Query(`SELECT state, version::text AS version FROM attendance_period
      WHERE month = CAST($1 AS date) FOR UPDATE`, month+"-01")
	if err != nil {
		return lockedPeriod{}, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[lockedPeriod])
	if err != nil {
		return lockedPeriod{}, err
	}
	if len(found) != 1 {
		return lockedPeriod{}, errMissingRow
	}
	return found[0], nil
}

func one[T any](tx *database.Tx, sql string, args ...any) (T, error) {
	var zero T
	rows, err := tx.Query(sql, args...)
	if err != nil {
		return zero, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[T])
	if err != nil {
		return zero, err
	}
	if len(found) != 1 {
		return zero, errMissingRow
	}
	return found[0], nil
}

func companyTarget(c authority.CommandContext) authority.AuditTarget {
	return authority.AuditTarget{Resource: string(keys.CompanyResourceCompany), Key: c.Target.Key, ObjectID: c.Target.ObjectID}
}

// snapshotOf is the close document of every employee employed in month, from one read of the facts, and the
// calendar version read beside it. Nothing here takes a lock: the calendar is taken by a submit after the
// period, so a close holding the month must not wait for it.
func snapshotOf(tx *database.Tx, month string) (attendancecore.Snapshot, error) {
	rows, err := attendancecore.LoadAllFacts(tx, month)
	if err != nil {
		return attendancecore.Snapshot{}, err
	}
	calendar, err := one[string](tx, `SELECT version::text AS version FROM work_calendar WHERE id = CAST($1 AS uuid)`, permission.WorkCalendarID)
	if err != nil {
		return attendancecore.Snapshot{}, err
	}
	employees := make([]attendancecore.SnapshotEmployee, len(rows))
	for i, row := range rows {
		totals, err := attendancecore.TotalsOf(month, row)
		if err != nil {
			return attendancecore.Snapshot{}, err
		}
		employees[i] = attendancecore.SnapshotEmployee{EmployeeID: row.ID, Totals: totals}
	}
	return attendancecore.BuildSnapshot(month, calendar, employees), nil
}

// runClose is hrCompany.managePeriod, close (D07). Lock order: fence → company (held by Execute; a hire or a
// termination takes it too, so employment does not move under the snapshot) → month FOR UPDATE → facts and
// calendar read without a lock. Refused (409) when the month is already closed or after the current
// business month. The stored document is the canonical bytes its hash covers, so a reader re-verifies it
// and unchanged inputs hash identically after a reopen.
func runClose(c authority.CommandContext, month string) (PeriodResult, error) {
	current, err := lockPeriodForUpdate(c.Tx, month)
	if err != nil {
		return PeriodResult{}, err
	}
	if attendancecore.PeriodState(current.State) != attendancecore.PeriodOpen {
		return PeriodResult{}, apperror.ErrCommandRejected
	}
	future, err := one[bool](c.Tx, `SELECT CAST($1 || '-01' AS date) > make_date(EXTRACT(year FROM `+hrbase.BusinessToday+`)::int,
                EXTRACT(month FROM `+hrbase.BusinessToday+`)::int, 1) AS future`, month)
	if err != nil {
		return PeriodResult{}, err
	}
	if future {
		return PeriodResult{}, apperror.ErrCommandRejected
	}
	snapshot, err := snapshotOf(c.Tx, month)
	if err != nil {
		return PeriodResult{}, err
	}
	canonical, err := attendancecore.CanonicalSnapshot(snapshot)
	if err != nil {
		return PeriodResult{}, err
	}
	hash, err := attendancecore.SnapshotHash(snapshot)
	if err != nil {
		return PeriodResult{}, err
	}
	version, err := one[string](c.Tx, `WITH updated AS (UPDATE attendance_period SET state = 'closed', version = version + 1,
              snapshot = CAST($2 AS jsonb), snapshot_hash = $3
        WHERE month = CAST($1 AS date) RETURNING version::text AS version)
       SELECT version FROM updated`, month+"-01", string(canonical), hash)
	if err != nil {
		return PeriodResult{}, err
	}
	if _, err := c.Tx.Exec(`INSERT INTO attendance_period_event(id, month, version, event, snapshot_hash, actor_account_id)
       VALUES (gen_random_uuid(), CAST($1 AS date), CAST($2 AS int8), 'close', $3, $4)`, month+"-01", version, hash, c.Actor.ID); err != nil {
		return PeriodResult{}, err
	}
	if err := c.Audit(audit.KindHRAttendancePeriodClose, companyTarget(c), nil); err != nil {
		return PeriodResult{}, err
	}
	return PeriodResult{Month: month, State: attendancecore.PeriodClosed, Version: version}, nil
}

// runReopen is hrCompany.managePeriod, reopen with a reason (D07): the snapshot goes, the history stays.
// Same lock order as the close; refused (409) unless the month is closed.
func runReopen(c authority.CommandContext, input ReopenInput) (PeriodResult, error) {
	current, err := lockPeriodForUpdate(c.Tx, input.Month)
	if err != nil {
		return PeriodResult{}, err
	}
	if attendancecore.PeriodState(current.State) != attendancecore.PeriodClosed {
		return PeriodResult{}, apperror.ErrCommandRejected
	}
	version, err := one[string](c.Tx, `WITH updated AS (UPDATE attendance_period SET state = 'open', version = version + 1,
              snapshot = NULL, snapshot_hash = NULL
        WHERE month = CAST($1 AS date) RETURNING version::text AS version)
       SELECT version FROM updated`, input.Month+"-01")
	if err != nil {
		return PeriodResult{}, err
	}
	if _, err := c.Tx.Exec(`INSERT INTO attendance_period_event(id, month, version, event, reason, actor_account_id)
       VALUES (gen_random_uuid(), CAST($1 AS date), CAST($2 AS int8), 'reopen', $3, $4)`, input.Month+"-01", version, input.Reason, c.Actor.ID); err != nil {
		return PeriodResult{}, err
	}
	if err := c.Audit(audit.KindHRAttendancePeriodReopen, companyTarget(c), nil); err != nil {
		return PeriodResult{}, err
	}
	return PeriodResult{Month: input.Month, State: attendancecore.PeriodOpen, Version: version}, nil
}
