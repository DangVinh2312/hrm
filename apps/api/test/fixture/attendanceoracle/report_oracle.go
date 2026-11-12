package attendanceoracle

import (
	"encoding/json/jsontext"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/permission"
	"hrm/api/internal/modules/schedulecore"
)

var errMissingSnapshotRow = errors.New("closed month row is missing from its snapshot")

// SheetRow is one employee and month of the correlated attendance report.
type SheetRow struct {
	EmployeeID, EmployeeCode, EmployeeName, Month string
	PeriodState                                   attendancecore.PeriodState
	attendancecore.Totals
}

// SheetRows is a page of the correlated attendance report: Total counts every pair the scope allows.
type SheetRows struct {
	Total string
	Rows  []SheetRow
}

type sheetStored struct {
	EmployeeID        string                      `json:"employeeId"`
	EmployeeCode      string                      `json:"employeeCode"`
	EmployeeName      string                      `json:"employeeName"`
	Month             string                      `json:"month"`
	PeriodState       attendancecore.PeriodState  `json:"periodState"`
	HiredOn           string                      `json:"hiredOn"`
	TerminatedOn      *string                     `json:"terminatedOn"`
	Holidays          []string                    `json:"holidays"`
	MakeupDays        []schedulecore.StoredMakeup `json:"makeupDays"`
	Frames            []schedulecore.StoredFrames `json:"frames"`
	Effects           []attendancecore.Effect     `json:"effects"`
	AdjustmentMinutes *int                        `json:"adjustmentMinutes"`
}

type sheetPage struct {
	Total  string `json:"total"`
	Closed []struct {
		Month    string         `json:"month"`
		Snapshot jsontext.Value `json:"snapshot"`
		Hash     string         `json:"hash"`
	} `json:"closed"`
	Rows     []sheetStored                `json:"rows"`
	Versions []schedulecore.StoredVersion `json:"versions"`
}

// LoadSheetRows is the correlated loadSheetRows of hrm-attendance-effects-oracle.helper.ts (oracleLoadSheetRows):
// one statement per page, the effects and adjustments of each row by a correlated subquery.
func LoadSheetRows(c authority.QueryContext, from, to string, limit, offset int) (SheetRows, error) {
	args, at, err := c.Scope.Args(from, to, limit, offset, permission.WorkCalendarID)
	if err != nil {
		return SheetRows{}, err
	}
	first := `CAST(` + at(1) + ` || '-01' AS date)`
	next := `CAST(CAST(` + at(2) + ` || '-01' AS date) + interval '1 month' AS date)`
	rows, err := c.Tx.Query(`WITH ms AS (
       SELECT CAST(g AS date) AS first, CAST(g + interval '1 month' AS date) AS next,
              COALESCE(p.state, 'open') AS state, p.snapshot, p.snapshot_hash
         FROM generate_series(CAST(`+at(1)+` || '-01' AS timestamp), CAST(`+at(2)+` || '-01' AS timestamp), interval '1 month') g
         LEFT JOIN attendance_period p ON p.month = CAST(g AS date)),
     pairs AS (
       SELECT r.id, r.code, r.full_name, r.hired_on, r.terminated_on, ms.first, ms.next, ms.state
         FROM employee r
         JOIN ms ON (ms.state = 'open' AND r.hired_on < ms.next
                     AND (r.terminated_on IS NULL OR r.terminated_on >= ms.first))
                 OR (ms.state = 'closed'
                     AND (ms.snapshot -> 'employees') @> jsonb_build_array(jsonb_build_object('employeeId', r.id::text)))
        WHERE `+c.Scope.SQL+`),
     page AS (SELECT * FROM pairs ORDER BY code, id, first
               LIMIT CAST(`+at(3)+` AS int8) OFFSET CAST(`+at(4)+` AS int8)),
     cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST(`+at(5)+` AS uuid)),
     days AS (`+attendancecore.CalendarDaysCTE(first, next)+`)
     SELECT json_build_object(
       'total', (SELECT count(*) FROM pairs)::text,
       'closed', COALESCE((SELECT json_agg(json_build_object('month', to_char(ms.first, 'YYYY-MM'),
                             'snapshot', ms.snapshot, 'hash', ms.snapshot_hash))
                            FROM ms WHERE ms.state = 'closed'
                              AND EXISTS (SELECT 1 FROM page WHERE page.first = ms.first)), '[]'::json),
       'rows', COALESCE((SELECT json_agg(x ORDER BY x."employeeCode", x."employeeId", x.month) FROM (
                 SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                        to_char(p.first, 'YYYY-MM') AS month, p.state AS "periodState",
                        to_char(p.hired_on,'YYYY-MM-DD') AS "hiredOn", to_char(p.terminated_on,'YYYY-MM-DD') AS "terminatedOn",
                        CASE WHEN p.state = 'open' THEN `+attendancecore.HolidaysSQL("p.first", "p.next")+` END AS holidays,
                        CASE WHEN p.state = 'open' THEN `+attendancecore.MakeupDaysSQL("p.first", "p.next")+` END AS "makeupDays",
                        CASE WHEN p.state = 'open' THEN `+schedulecore.EmployeeFramesSQL("p.id", "p.first", "p.next")+` END AS frames,
                        CASE WHEN p.state = 'open' THEN `+ApprovedEffectsSQL("p.id", "p.first", "p.next")+` END AS effects,
                        CASE WHEN p.state = 'open' THEN `+adjustmentMinutesSQL("p.id", "p.first", "p.next")+` END AS "adjustmentMinutes"
                   FROM page p) x), '[]'::json),
       'versions', `+schedulecore.ScheduleVersionsSQL(first, next)+`) AS result`, args...)
	if err != nil {
		return SheetRows{}, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[[]byte])
	if err != nil {
		return SheetRows{}, err
	}
	var stored sheetPage
	if err := decodeInto(raw, &stored); err != nil {
		return SheetRows{}, err
	}
	return sheetRows(stored)
}

func sheetRows(stored sheetPage) (SheetRows, error) {
	versions := schedulecore.ScheduleVersions(stored.Versions)
	closed := map[string]map[string]attendancecore.Totals{}
	for _, m := range stored.Closed {
		snapshot, err := attendancecore.VerifiedSnapshot(m.Month, m.Snapshot, m.Hash)
		if err != nil {
			return SheetRows{}, err
		}
		employees := map[string]attendancecore.Totals{}
		for _, e := range snapshot.Employees {
			employees[e.EmployeeID] = e.Totals
		}
		closed[m.Month] = employees
	}
	result := SheetRows{Total: stored.Total, Rows: []SheetRow{}}
	for _, row := range stored.Rows {
		out := SheetRow{EmployeeID: row.EmployeeID, EmployeeCode: row.EmployeeCode, EmployeeName: row.EmployeeName,
			Month: row.Month, PeriodState: row.PeriodState}
		if row.PeriodState == attendancecore.PeriodClosed {
			totals, ok := closed[row.Month][row.EmployeeID]
			if !ok {
				return SheetRows{}, errMissingSnapshotRow
			}
			out.Totals = totals
			result.Rows = append(result.Rows, out)
			continue
		}
		effects := row.Effects
		if effects == nil {
			effects = []attendancecore.Effect{}
		}
		adjustment := 0
		if row.AdjustmentMinutes != nil {
			adjustment = *row.AdjustmentMinutes
		}
		totals, err := attendancecore.TotalsOf(row.Month, attendancecore.FactsRow{
			ID: row.EmployeeID, HiredOn: row.HiredOn, TerminatedOn: row.TerminatedOn, Holidays: row.Holidays,
			MakeupDays: row.MakeupDays, Frames: row.Frames, Effects: effects, AdjustmentMinutes: adjustment, Versions: versions,
		})
		if err != nil {
			return SheetRows{}, err
		}
		out.Totals = totals
		result.Rows = append(result.Rows, out)
	}
	return result, nil
}
