package workschedule

import (
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/schedulecore"
)

// Schedule writes touch only days after today (the DB business date), so a day already worked, and every
// closed month, keeps its hours. Company versions are written under the calendar row (locked by Execute,
// held FOR SHARE by every submit); employee frames under the employee row (locked by Execute, the lock of
// every submit of that employee). The current month can be closed before it ends, so the month of the
// first day changed must be open (409 error.periodClosed, held FOR SHARE after the row lock, as calendar
// changes and submits do); a later month cannot be closed yet.

var (
	errUnchanged = fmt.Errorf("schedule unchanged: %w", apperror.ErrCommandRejected)
	errNoVersion = fmt.Errorf("no schedule version: %w", apperror.ErrCommandRejected)
)

const (
	selectCompanyVersion = `SELECT CAST($1 AS date) > ` + hrbase.BusinessToday + ` AS future,
                (SELECT COALESCE(json_agg(json_build_array(s.weekday, s.start_minute, s.end_minute)
                          ORDER BY s.weekday, s.position), '[]'::json)
                   FROM work_schedule w LEFT JOIN work_schedule_shift s ON s.schedule_id = w.id
                  WHERE w.effective_from = CAST($1 AS date)
                  GROUP BY w.id)::text AS current`
	selectFutureVersion = `SELECT effective_from > ` + hrbase.BusinessToday + ` AS future FROM work_schedule
          WHERE effective_from = CAST($1 AS date)`
	deleteCompanyVersion = `DELETE FROM work_schedule WHERE effective_from = CAST($1 AS date)`
	insertCompanyVersion = `INSERT INTO work_schedule(id, effective_from) VALUES ($1, CAST($2 AS date))`
)

type companyVersionRow struct {
	Future  bool
	Current *string
}

func scheduleTarget(c authority.CommandContext) authority.AuditTarget {
	return authority.AuditTarget{Resource: string(keys.WorkCalendarResourceWorkCalendar), Key: c.Target.Key, ObjectID: c.Target.ObjectID}
}

// runPutCompanySchedule is workCalendar.manageSchedule: creates or replaces the version starting
// EffectiveFrom.
func runPutCompanySchedule(c authority.CommandContext, input CompanyScheduleInput) (EffectiveResult, error) {
	if err := checkWeek(c.Tx, input.Days); err != nil {
		return EffectiveResult{}, err
	}
	rows, err := c.Tx.Query(selectCompanyVersion, input.EffectiveFrom)
	if err != nil {
		return EffectiveResult{}, err
	}
	row, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[companyVersionRow])
	if err != nil {
		return EffectiveResult{}, err
	}
	if !row.Future {
		return EffectiveResult{}, apperror.ErrInvalidRequest
	}
	if row.Current != nil {
		current, err := schedulecore.DecodeStored[[]schedulecore.StoredShift]([]byte(*row.Current))
		if err != nil {
			return EffectiveResult{}, err
		}
		if slices.Equal(current, schedulecore.StoredShifts(input.Days)) {
			return EffectiveResult{}, errUnchanged
		}
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, []string{input.EffectiveFrom}); err != nil {
		return EffectiveResult{}, err
	}
	id := newUUID()
	if _, err := c.Tx.Exec(deleteCompanyVersion, input.EffectiveFrom); err != nil {
		return EffectiveResult{}, err
	}
	if _, err := c.Tx.Exec(insertCompanyVersion, id, input.EffectiveFrom); err != nil {
		return EffectiveResult{}, err
	}
	if err := insertShifts(c.Tx, insertCompanyShifts, id, input.Days); err != nil {
		return EffectiveResult{}, err
	}
	if err := checkMakeupDays(c.Tx, input.EffectiveFrom); err != nil {
		return EffectiveResult{}, err
	}
	if err := c.Audit(audit.KindHRWorkScheduleUpdate, scheduleTarget(c), nil); err != nil {
		return EffectiveResult{}, err
	}
	return EffectiveResult{EffectiveFrom: input.EffectiveFrom}, nil
}

// runDeleteCompanySchedule is workCalendar.manageSchedule: removes a version not in force yet.
func runDeleteCompanySchedule(c authority.CommandContext, effectiveFrom string) (EffectiveResult, error) {
	rows, err := c.Tx.Query(selectFutureVersion, effectiveFrom)
	if err != nil {
		return EffectiveResult{}, err
	}
	future, err := pgx.CollectRows(rows, pgx.RowTo[bool])
	if err != nil {
		return EffectiveResult{}, err
	}
	if len(future) == 0 {
		return EffectiveResult{}, errNoVersion
	}
	if !future[0] {
		return EffectiveResult{}, apperror.ErrInvalidRequest
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, []string{effectiveFrom}); err != nil {
		return EffectiveResult{}, err
	}
	if _, err := c.Tx.Exec(deleteCompanyVersion, effectiveFrom); err != nil {
		return EffectiveResult{}, err
	}
	if err := checkMakeupDays(c.Tx, effectiveFrom); err != nil {
		return EffectiveResult{}, err
	}
	if err := c.Audit(audit.KindHRWorkScheduleUpdate, scheduleTarget(c), nil); err != nil {
		return EffectiveResult{}, err
	}
	return EffectiveResult{EffectiveFrom: effectiveFrom}, nil
}
