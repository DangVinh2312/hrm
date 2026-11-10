package attendance

import (
	"encoding/json/v2"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/permission"
)

var (
	errMissingFacts = errors.New("employee facts are missing")
	errStoredPeriod = errors.New("stored attendance period is invalid")
)

type sheetRow struct {
	ID    string
	Month string
}

// readSheet is employee.readAttendance (self, HR; Root): the plan's scope on the employee row, then the sheet
// of the month (default: the current month by the DB clock in the business timezone) from one consistent
// read of exactly that employee. A closed month is still the live facts; the snapshot is the report's.
func readSheet(c authority.QueryContext, input SheetQuery) (authority.QueryResult[SheetView], error) {
	var none authority.QueryResult[SheetView]
	args, at, err := c.Scope.Args(input.EmployeeID, input.Month)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`SELECT r.id::text AS id, COALESCE(CAST(`+at(2)+` AS text), to_char(`+hrbase.BusinessToday+`, 'YYYY-MM')) AS month
         FROM employee r WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return none, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[sheetRow])
	if err != nil || len(found) == 0 {
		return none, err
	}
	row := found[0]
	facts, err := attendancecore.LoadFacts(c.Tx, row.Month, []string{row.ID})
	if err != nil {
		return none, err
	}
	if len(facts) != 1 || facts[0].ID != row.ID {
		return none, errMissingFacts
	}
	totals, err := attendancecore.TotalsOf(row.Month, facts[0])
	if err != nil {
		return none, err
	}
	state := attendancecore.PeriodOpen
	if facts[0].PeriodState != nil {
		state = *facts[0].PeriodState
	}
	return authority.QueryResult[SheetView]{Found: true, Value: SheetView{EmployeeID: row.ID, Month: row.Month, PeriodState: state, Totals: totals}}, nil
}

type periodRow struct {
	State   string
	Version string
	Events  string
}

// readPeriodState is hrCompany.read on the company row: the close state of a month, its version and the
// history of every close and reopen, newest first, at most 50. A month nobody touched is open, version 1,
// no events. Not the snapshot, its hash or the actor.
func readPeriodState(c authority.QueryContext, month string) (authority.QueryResult[PeriodHistory], error) {
	var none authority.QueryResult[PeriodHistory]
	args, at, err := c.Scope.Args(permission.CompanyID, month+"-01")
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`SELECT COALESCE(p.state, 'open') AS state, COALESCE(p.version, 1)::text AS version,
              COALESCE((SELECT json_agg(json_build_object('event', e.event, 'version', e.version::text,
                          'reason', e.reason,
                          'occurredAt', to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
                          ORDER BY e.version DESC)
                         FROM (SELECT x.event, x.version, x.reason, x.occurred_at
                                 FROM attendance_period_event x WHERE x.month = CAST(`+at(2)+` AS date)
                                ORDER BY x.version DESC LIMIT 50) e), '[]'::json)::text AS events
         FROM hr_company r
         LEFT JOIN attendance_period p ON p.month = CAST(`+at(2)+` AS date)
        WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return none, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[periodRow])
	if err != nil || len(found) == 0 {
		return none, err
	}
	view := PeriodHistory{Month: month, State: attendancecore.PeriodState(found[0].State), Version: found[0].Version}
	if err := json.Unmarshal([]byte(found[0].Events), &view.Events, json.RejectUnknownMembers(true)); err != nil {
		return none, err
	}
	if view.State != attendancecore.PeriodOpen && view.State != attendancecore.PeriodClosed {
		return none, errStoredPeriod
	}
	for _, e := range view.Events {
		if e.Event != PeriodEventClose && e.Event != PeriodEventReopen {
			return none, errStoredPeriod
		}
	}
	return authority.QueryResult[PeriodHistory]{Found: true, Value: view}, nil
}

// readAdjustments is employee.readAttendanceAdjustment (HR, company scope): the entries of one month for one
// employee, newest day first, with the month's signed total and an exact count. The plan's scope is ANDed
// into the employee lookup before the count and the page. The actor is not shown.
func readAdjustments(c authority.QueryContext, input AdjustmentQuery) (authority.QueryResult[AdjustmentList], error) {
	var none authority.QueryResult[AdjustmentList]
	args, at, err := c.Scope.Args(input.EmployeeID, input.Month+"-01", input.Limit, input.Offset)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`SELECT json_build_object(
          'employeeId', r.id::text, 'month', to_char(m.first, 'YYYY-MM'),
          'periodState', COALESCE((SELECT p.state FROM attendance_period p WHERE p.month = m.first), 'open'),
          'adjustmentMinutes', `+attendancecore.AdjustmentMinutesSQL("r.id", "m.first", "m.next")+`,
          'total', (SELECT count(*) FROM attendance_adjustment a
                     WHERE a.employee_id = r.id AND a.work_date >= m.first AND a.work_date < m.next)::text,
          'items', COALESCE((SELECT json_agg(json_build_object(
                      'id', x.id::text, 'workDate', to_char(x.work_date,'YYYY-MM-DD'), 'minutes', x.minutes,
                      'reason', x.reason, 'reference', x.reference,
                      'createdAt', to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
                      ORDER BY x.work_date DESC, x.created_at DESC, x.id DESC)
                     FROM (SELECT a.id, a.work_date, a.minutes, a.reason, a.reference, a.created_at
                             FROM attendance_adjustment a
                            WHERE a.employee_id = r.id AND a.work_date >= m.first AND a.work_date < m.next
                            ORDER BY a.work_date DESC, a.created_at DESC, a.id DESC
                            LIMIT CAST(`+at(3)+` AS int8) OFFSET CAST(`+at(4)+` AS int8)) x), '[]'::json)
        )::text AS result
         FROM employee r,
              LATERAL (SELECT CAST(`+at(2)+` AS date) AS first,
                              CAST(CAST(`+at(2)+` AS date) + interval '1 month' AS date) AS next) m
        WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return none, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(found) == 0 {
		return none, err
	}
	var list AdjustmentList
	if err := json.Unmarshal([]byte(found[0]), &list, json.RejectUnknownMembers(true)); err != nil {
		return none, err
	}
	return authority.QueryResult[AdjustmentList]{Found: true, Value: list}, nil
}
