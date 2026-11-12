package workschedule

import (
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/hrbase"
)

var (
	errOverlap = fmt.Errorf("employee frames overlap: %w", apperror.ErrCommandRejected)
	errNoFrame = fmt.Errorf("no employee frame: %w", apperror.ErrCommandRejected)
)

const (
	selectFrameFacts = `SELECT CAST($2 AS date) > ` + hrbase.BusinessToday + ` AS future,
                EXISTS (SELECT 1 FROM employee_schedule o WHERE o.employee_id = $1
                          AND o.valid_from <= COALESCE(CAST($3 AS date), DATE 'infinity')
                          AND COALESCE(o.valid_to, DATE 'infinity') >= CAST($2 AS date)) AS overlaps,
                ARRAY(SELECT DISTINCT s.weekday::int FROM work_schedule_shift s
                       WHERE s.schedule_id = (SELECT w.id FROM work_schedule w
                                               WHERE w.effective_from <= CAST($2 AS date)
                                               ORDER BY w.effective_from DESC LIMIT 1)) AS workdays`
	insertFrame = `INSERT INTO employee_schedule(id, employee_id, valid_from, valid_to)
         VALUES ($1, $2, CAST($3 AS date), CAST($4 AS date))`
	selectFrameEnd = `SELECT valid_from > ` + hrbase.BusinessToday + ` AS future,
                (valid_to IS NULL OR valid_to > ` + hrbase.BusinessToday + `) AS running,
                to_char(GREATEST(valid_from, ` + hrbase.BusinessToday + ` + 1),'YYYY-MM-DD') AS "firstChanged"
           FROM employee_schedule WHERE id = $2 AND employee_id = $1`
	deleteFrame = `DELETE FROM employee_schedule WHERE id = $1`
	endFrame    = `UPDATE employee_schedule SET valid_to = ` + hrbase.BusinessToday + ` WHERE id = $1`
)

type frameFacts struct {
	Future   bool
	Overlaps bool
	Workdays []int32
}

type frameEnd struct {
	Future       bool
	Running      bool
	FirstChanged string
}

func employeeTarget(c authority.CommandContext) authority.AuditTarget {
	return authority.AuditTarget{Resource: string(keys.EmployeeResourceEmployee), Key: c.Target.Key, ObjectID: c.Target.ObjectID}
}

// runAddEmployeeFrame is employee.manageSchedule: own hours from a date after today. Frames of one
// employee never overlap (409); an empty weekday keeps the company's hours, and own hours never add a
// workday the company version in force at ValidFrom has off.
func runAddEmployeeFrame(c authority.CommandContext, input EmployeeFrameInput) (IDResult, error) {
	if err := checkWeek(c.Tx, input.Days); err != nil {
		return IDResult{}, err
	}
	rows, err := c.Tx.Query(selectFrameFacts, c.Target.Key, input.ValidFrom, input.ValidTo)
	if err != nil {
		return IDResult{}, err
	}
	facts, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[frameFacts])
	if err != nil {
		return IDResult{}, err
	}
	if !facts.Future {
		return IDResult{}, apperror.ErrInvalidRequest
	}
	for index, frame := range input.Days {
		if len(frame) > 0 && !slices.Contains(facts.Workdays, int32(index+1)) {
			return IDResult{}, apperror.ErrInvalidRequest
		}
	}
	if facts.Overlaps {
		return IDResult{}, errOverlap
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, []string{input.ValidFrom}); err != nil {
		return IDResult{}, err
	}
	id := newUUID()
	if _, err := c.Tx.Exec(insertFrame, id, c.Target.Key, input.ValidFrom, input.ValidTo); err != nil {
		return IDResult{}, err
	}
	if err := insertShifts(c.Tx, insertEmployeeShifts, id, input.Days); err != nil {
		return IDResult{}, err
	}
	if err := c.Audit(audit.KindHREmployeeScheduleUpdate, employeeTarget(c), nil); err != nil {
		return IDResult{}, err
	}
	return IDResult{ID: id}, nil
}

// runEndEmployeeFrame is employee.manageSchedule: a frame not started yet is removed; one in force ends
// today, so today and every earlier day keep its hours. A frame of another employee is no frame.
func runEndEmployeeFrame(c authority.CommandContext, key FrameKey) (IDResult, error) {
	rows, err := c.Tx.Query(selectFrameEnd, c.Target.Key, key.FrameID)
	if err != nil {
		return IDResult{}, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[frameEnd])
	if err != nil {
		return IDResult{}, err
	}
	if len(found) == 0 {
		return IDResult{}, errNoFrame
	}
	frame := found[0]
	if !frame.Future && !frame.Running {
		return IDResult{}, errUnchanged
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, []string{frame.FirstChanged}); err != nil {
		return IDResult{}, err
	}
	statement := endFrame
	if frame.Future {
		statement = deleteFrame
	}
	if _, err := c.Tx.Exec(statement, key.FrameID); err != nil {
		return IDResult{}, err
	}
	if err := c.Audit(audit.KindHREmployeeScheduleUpdate, employeeTarget(c), nil); err != nil {
		return IDResult{}, err
	}
	return IDResult{ID: key.FrameID}, nil
}
