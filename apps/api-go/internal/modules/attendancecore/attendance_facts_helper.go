package attendancecore

import (
	"slices"

	"hrm/api-go/internal/modules/schedulecore"
)

type PeriodState string

const (
	PeriodOpen   PeriodState = "open"
	PeriodClosed PeriodState = "closed"
)

func date(column string) string { return "to_char(" + column + ",'YYYY-MM-DD')" }

// FirstOfMonth is the first day of the month of a valid `YYYY-MM-DD` or `YYYY-MM` string.
func FirstOfMonth(value string) (string, error) {
	if _, err := ParseMonth(value); err != nil {
		if _, err := schedulecore.ParseDate(value); err != nil {
			return "", err
		}
	}
	return value[:7] + "-01", nil
}

// MonthsOf is the distinct months (first days, ascending) of valid business dates.
func MonthsOf(dates []string) ([]string, error) {
	months := make([]string, 0, len(dates))
	for _, d := range dates {
		if _, err := schedulecore.ParseDate(d); err != nil {
			return nil, err
		}
		months = append(months, d[:7]+"-01")
	}
	slices.Sort(months)
	return slices.Compact(months), nil
}

// FactsRow is everything the sheet of a month depends on for one employee, from ONE statement, so the
// calendar version, the approved segments and the period state are consistent (F-08).
type FactsRow struct {
	ID              string                      `json:"id"`
	HiredOn         string                      `json:"hiredOn"`
	TerminatedOn    *string                     `json:"terminatedOn"`
	CalendarVersion string                      `json:"calendarVersion"`
	PeriodState     *PeriodState                `json:"periodState"`
	Holidays        []string                    `json:"holidays"`
	MakeupDays      []schedulecore.StoredMakeup `json:"makeupDays"`
	Frames          []schedulecore.StoredFrames `json:"frames"`
	// Effects is set when read per row; a set-based read fills it from the groups.
	Effects           []Effect `json:"effects,omitzero"`
	AdjustmentMinutes int      `json:"adjustmentMinutes"`
	// Versions are the company versions of the month, shared by every row of a statement.
	Versions []schedulecore.ScheduleVersion `json:"-"`
}

// MonthsWindow is a half-open range [First, Next) of SQL expressions covering every month of a read.
type MonthsWindow struct {
	First, Next string
}

// EffectsSetBasedMinRows is the row count from which a read uses ApprovedEffectsBySQL; below it the per-row
// ApprovedEffectsSQL. Measured on 5000 employees with a year of history (ADR-18 addendum 2026-10-22); a
// cautious choice between measured points, not a proven optimum.
const EffectsSetBasedMinRows = 300

// EffectsGroup is the effects of an employee in a month, from ApprovedEffectsBySQL.
type EffectsGroup struct {
	EmployeeID string   `json:"employeeId"`
	Month      string   `json:"month"`
	Effects    []Effect `json:"effects"`
}

const effectObject = `json_build_object('kind', s.kind, 'date', ` + "to_char(s.work_date,'YYYY-MM-DD')" + `,
                        'startMinute', s.start_minute, 'endMinute', s.end_minute)
                        ORDER BY s.work_date, s.kind, s.start_minute, s.end_minute`

// ApprovedEffectsSQL is a JSON array (SQL fragment) of the approved segments of ONE employee dated in
// [first, next): the per-row reader. Arguments are SQL of the caller's statement, never input.
func ApprovedEffectsSQL(employee, first, next string) string {
	return `COALESCE((SELECT json_agg(` + effectObject + `)
                       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
                      WHERE r.employee_id = ` + employee + ` AND r.state = 'approved'
                        AND s.work_date >= ` + first + ` AND s.work_date < ` + next + `), '[]'::json)`
}

// ApprovedEffectsBySQL is the set-based reader (body of a CTE with columns id, first, effects) for the
// employees of source, already narrowed to the caller's scope and page. The employees reach the scan as
// one array filter, never as a join with source: a join on a CTE estimate was measured to pick a nested
// loop over 5000 rows or a scan of all requests.
func ApprovedEffectsBySQL(source string, window MonthsWindow) string {
	return `SELECT r.employee_id AS id, CAST(date_trunc('month', CAST(s.work_date AS timestamp)) AS date) AS first,
          json_agg(` + effectObject + `) AS effects
     FROM work_request r
     JOIN work_request_segment s ON s.request_id = r.id
    WHERE r.employee_id = ANY(CAST((SELECT array_agg(k.id) FROM ` + source + ` k) AS uuid[])) AND r.state = 'approved'
      AND s.work_date >= ` + window.First + ` AND s.work_date < ` + window.Next + `
    GROUP BY r.employee_id, CAST(date_trunc('month', CAST(s.work_date AS timestamp)) AS date)`
}

// EffectsGroupsSQL is a JSON array (SQL fragment) of the groups of a CTE built with ApprovedEffectsBySQL.
func EffectsGroupsSQL(groups string) string {
	return `COALESCE((SELECT json_agg(json_build_object('employeeId', g.id::text, 'month', to_char(g.first, 'YYYY-MM'),
                        'effects', g.effects)) FROM ` + groups + ` g), '[]'::json)`
}

// EffectsIndex looks groups up by employee and month; a missing key is no effect.
func EffectsIndex(groups []EffectsGroup) func(employeeID, month string) []Effect {
	byKey := make(map[[2]string][]Effect, len(groups))
	for _, g := range groups {
		byKey[[2]string{g.EmployeeID, g.Month}] = g.Effects
	}
	return func(employeeID, month string) []Effect {
		if effects, ok := byKey[[2]string{employeeID, month}]; ok {
			return effects
		}
		return []Effect{}
	}
}

// AdjustmentMinutesSQL is the signed sum (SQL int fragment) of the attendance.adjust rows of employee dated in
// [first, next): the one reader of adjustments. An int overflow fails the statement, it never wraps.
func AdjustmentMinutesSQL(employee, first, next string) string {
	return `COALESCE((SELECT SUM(a.minutes) FROM attendance_adjustment a
              WHERE a.employee_id = ` + employee + ` AND a.work_date >= ` + first + ` AND a.work_date < ` + next + `), 0)::int`
}

// HolidaysSQL is a JSON array of the paid holidays in [first, next), from a CTE days(day, kind, as_weekday, frame_source).
func HolidaysSQL(first, next string) string {
	return `COALESCE((SELECT json_agg(` + date("d.day") + ` ORDER BY d.day) FROM days d
              WHERE d.kind = 'paid_holiday' AND d.day >= ` + first + ` AND d.day < ` + next + `), '[]'::json)`
}

// MakeupDaysSQL is a JSON array of the makeup days in [first, next) with their hours, from days.
func MakeupDaysSQL(first, next string) string {
	return `COALESCE((SELECT json_agg(json_build_object('date', ` + date("d.day") + `, 'asWeekday', d.as_weekday,
                    'frameSource', d.frame_source) ORDER BY d.day) FROM days d
              WHERE d.kind = 'makeup_workday' AND d.day >= ` + first + ` AND d.day < ` + next + `), '[]'::json)`
}

// CalendarDaysCTE is the days CTE body over [first, next) at the calendar version of a CTE cal(version).
func CalendarDaysCTE(first, next string) string {
	return `SELECT DISTINCT ON (x.day) x.day, x.kind, x.as_weekday, x.frame_source
     FROM work_calendar_change x, cal
    WHERE x.day >= ` + first + ` AND x.day < ` + next + ` AND x.version <= cal.version
    ORDER BY x.day, x.version DESC`
}

// TotalsOf is the sheet of month for one facts row.
func TotalsOf(month string, row FactsRow) (Totals, error) {
	return MonthTotals(Facts{
		Month:        month,
		HiredOn:      row.HiredOn,
		TerminatedOn: row.TerminatedOn,
		Schedule: schedulecore.Facts(row.Versions, schedulecore.StoredSchedule{
			Frames: row.Frames, Holidays: row.Holidays, MakeupDays: row.MakeupDays,
		}),
		Effects:           row.Effects,
		AdjustmentMinutes: row.AdjustmentMinutes,
	})
}
