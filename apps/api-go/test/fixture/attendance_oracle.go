package fixture

import (
	"encoding/json/v2"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/internal/modules/schedulecore"
)

// OracleApprovedEffectsSQL is the correlated statement of hrm-attendance-effects-oracle.helper.ts
// (oracleLoadAttendanceFacts), kept verbatim so the set-based reader is compared with the formulation it
// replaced, never with itself.
func OracleApprovedEffectsSQL(employee, first, next string) string {
	return `COALESCE((SELECT json_agg(json_build_object('kind', s.kind, 'date', to_char(s.work_date,'YYYY-MM-DD'),
                        'startMinute', s.start_minute, 'endMinute', s.end_minute)
                        ORDER BY s.work_date, s.kind, s.start_minute, s.end_minute)
                       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
                      WHERE r.employee_id = ` + employee + ` AND r.state = 'approved'
                        AND s.work_date >= ` + first + ` AND s.work_date < ` + next + `), '[]'::json)`
}

func oracleAdjustmentMinutesSQL(employee, first, next string) string {
	return `COALESCE((SELECT SUM(a.minutes) FROM attendance_adjustment a
              WHERE a.employee_id = ` + employee + ` AND a.work_date >= ` + first + ` AND a.work_date < ` + next + `), 0)::int`
}

type oracleRow struct {
	ID, HiredOn                                         string
	TerminatedOn                                        *string
	CalendarVersion                                     string
	PeriodState                                         *string
	Holidays, MakeupDays, Frames, Versions, EffectsJSON []byte
	AdjustmentMinutes                                   int32
}

func decodeInto(raw []byte, target any) error {
	return json.Unmarshal(raw, target, json.RejectUnknownMembers(true))
}

// OracleLoadFacts is the correlated facts of month: exactly ids, or with nil every employee employed in it.
func OracleLoadFacts(tx *database.Tx, month string, ids []string) ([]attendancecore.FactsRow, error) {
	first := `CAST($1 || '-01' AS date)`
	next := `CAST(CAST($1 || '-01' AS date) + interval '1 month' AS date)`
	var idsArg any
	if ids != nil {
		idsArg = ids
	}
	rows, err := tx.Query(`WITH m AS (SELECT `+first+` AS first, `+next+` AS next),
          cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST($3 AS uuid)),
          days AS (`+attendancecore.CalendarDaysCTE(first, next)+`)
     SELECT e.id::text AS id, to_char(e.hired_on,'YYYY-MM-DD') AS "hiredOn", to_char(e.terminated_on,'YYYY-MM-DD') AS "terminatedOn",
            (SELECT version::text FROM cal) AS "calendarVersion",
            (SELECT p.state FROM attendance_period p, m WHERE p.month = m.first) AS "periodState",
            `+attendancecore.HolidaysSQL(first, next)+` AS holidays,
            `+attendancecore.MakeupDaysSQL(first, next)+` AS "makeupDays",
            `+schedulecore.EmployeeFramesSQL("e.id", first, next)+` AS frames,
            `+schedulecore.ScheduleVersionsSQL(first, next)+` AS versions,
            `+OracleApprovedEffectsSQL("e.id", "(SELECT first FROM m)", "(SELECT next FROM m)")+` AS effects,
            `+oracleAdjustmentMinutesSQL("e.id", "(SELECT first FROM m)", "(SELECT next FROM m)")+` AS "adjustmentMinutes"
       FROM employee e, m
      WHERE CASE WHEN CAST($2 AS uuid[]) IS NULL
                 THEN e.hired_on < m.next AND (e.terminated_on IS NULL OR e.terminated_on >= m.first)
                 ELSE e.id = ANY(CAST($2 AS uuid[])) END
      ORDER BY e.id`, month, idsArg, permission.WorkCalendarID)
	if err != nil {
		return nil, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[oracleRow])
	if err != nil {
		return nil, err
	}
	facts := []attendancecore.FactsRow{}
	for _, o := range stored {
		row := attendancecore.FactsRow{ID: o.ID, HiredOn: o.HiredOn, TerminatedOn: o.TerminatedOn, CalendarVersion: o.CalendarVersion,
			PeriodState: (*attendancecore.PeriodState)(o.PeriodState), AdjustmentMinutes: int(o.AdjustmentMinutes)}
		var versions []schedulecore.StoredVersion
		if err := errors.Join(decodeInto(o.Holidays, &row.Holidays), decodeInto(o.MakeupDays, &row.MakeupDays),
			decodeInto(o.Frames, &row.Frames), decodeInto(o.Versions, &versions), decodeInto(o.EffectsJSON, &row.Effects)); err != nil {
			return nil, err
		}
		row.Versions = schedulecore.ScheduleVersions(versions)
		facts = append(facts, row)
	}
	return facts, nil
}
