package report

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/internal/modules/schedulecore"
	"hrm/api-go/internal/modules/settingcore"
)

var errMissingSnapshotRow = errors.New("closed month row is missing from its snapshot")

func isoDate(column string) string { return "to_char(" + column + ",'YYYY-MM-DD')" }

type sheetStored struct {
	EmployeeID   string                      `json:"employeeId"`
	EmployeeCode string                      `json:"employeeCode"`
	EmployeeName string                      `json:"employeeName"`
	Month        string                      `json:"month"`
	PeriodState  attendancecore.PeriodState  `json:"periodState"`
	HiredOn      string                      `json:"hiredOn"`
	TerminatedOn *string                     `json:"terminatedOn"`
	Holidays     []string                    `json:"holidays"`
	MakeupDays   []schedulecore.StoredMakeup `json:"makeupDays"`
	Frames       []schedulecore.StoredFrames `json:"frames"`
	// Effects is present when the page is read per row; else the page's effects groups carry it.
	Effects           []attendancecore.Effect `json:"effects"`
	AdjustmentMinutes *int                    `json:"adjustmentMinutes"`
}

type closedMonth struct {
	Month    string         `json:"month"`
	Snapshot jsontext.Value `json:"snapshot"`
	Hash     string         `json:"hash"`
}

type sheetPage struct {
	Total string `json:"total"`
	// Closed is the stored snapshot and hash of each closed month with a row in the page.
	Closed   []closedMonth                 `json:"closed"`
	Rows     []sheetStored                 `json:"rows"`
	Effects  []attendancecore.EffectsGroup `json:"effects"`
	Versions []schedulecore.StoredVersion  `json:"versions"`
}

type sheetRows struct {
	total         string
	rows          []AttendanceRow
	wfhMonthLimit int
}

// loadSheetRows is the employee × month sheets of From..To in the caller's scope from ONE statement (one
// snapshot, so approvals, the calendar, employment dates and the period state agree). The scope is ANDed into
// the employee scan before count and page. A closed month lists the employees of its snapshot, whose hash is
// re-verified; an open month the employees employed in it, computed live. The span is checked against
// report.maxMonths first; the same read gives the WFH limit in force.
func loadSheetRows(c authority.QueryContext, q Query) (sheetRows, error) {
	limits, err := settingcore.Read(c.Tx, []settingcore.Key{settingcore.KeyReportMaxMonths, settingcore.KeyWfhMonthLimit})
	if err != nil {
		return sheetRows{}, err
	}
	if err := checkSpan(q.From, q.To, int(limits[settingcore.KeyReportMaxMonths].Int)); err != nil {
		return sheetRows{}, err
	}
	args, at, err := c.Scope.Args(q.From, q.To, q.Limit, q.Offset, permission.WorkCalendarID)
	if err != nil {
		return sheetRows{}, err
	}
	window := attendancecore.MonthsWindow{
		First: `CAST(` + at(1) + ` || '-01' AS date)`,
		Next:  `CAST(CAST(` + at(2) + ` || '-01' AS date) + interval '1 month' AS date)`,
	}
	effectsCTE, rowEffects, groups := "", `CASE WHEN p.state = 'open' THEN `+attendancecore.ApprovedEffectsSQL("p.id", "p.first", "p.next")+` END AS effects,`, `'[]'::json`
	if q.Limit >= attendancecore.EffectsSetBasedMinRows {
		effectsCTE = `live_page AS (SELECT id FROM page WHERE state = 'open'),
     fx AS (` + attendancecore.ApprovedEffectsBySQL("live_page", window) + `),`
		rowEffects, groups = "", attendancecore.EffectsGroupsSQL("fx")
	}
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
     `+effectsCTE+`
     cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST(`+at(5)+` AS uuid)),
     days AS (`+attendancecore.CalendarDaysCTE(window.First, window.Next)+`)
     SELECT json_build_object(
       'total', (SELECT count(*) FROM pairs)::text,
       'closed', COALESCE((SELECT json_agg(json_build_object('month', to_char(ms.first, 'YYYY-MM'),
                             'snapshot', ms.snapshot, 'hash', ms.snapshot_hash))
                            FROM ms WHERE ms.state = 'closed'
                              AND EXISTS (SELECT 1 FROM page WHERE page.first = ms.first)), '[]'::json),
       'rows', COALESCE((SELECT json_agg(x ORDER BY x."employeeCode", x."employeeId", x.month) FROM (
                 SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                        to_char(p.first, 'YYYY-MM') AS month, p.state AS "periodState",
                        `+isoDate("p.hired_on")+` AS "hiredOn", `+isoDate("p.terminated_on")+` AS "terminatedOn",
                        CASE WHEN p.state = 'open' THEN `+attendancecore.HolidaysSQL("p.first", "p.next")+` END AS holidays,
                        CASE WHEN p.state = 'open' THEN `+attendancecore.MakeupDaysSQL("p.first", "p.next")+` END AS "makeupDays",
                        CASE WHEN p.state = 'open' THEN `+schedulecore.EmployeeFramesSQL("p.id", "p.first", "p.next")+` END AS frames,
                        `+rowEffects+`
                        CASE WHEN p.state = 'open' THEN `+attendancecore.AdjustmentMinutesSQL("p.id", "p.first", "p.next")+` END AS "adjustmentMinutes"
                   FROM page p) x), '[]'::json),
       'effects', `+groups+`,
       'versions', `+schedulecore.ScheduleVersionsSQL(window.First, window.Next)+`)::text AS result`, args...)
	if err != nil {
		return sheetRows{}, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return sheetRows{}, err
	}
	var stored sheetPage
	if err := json.Unmarshal([]byte(raw), &stored, json.RejectUnknownMembers(true)); err != nil {
		return sheetRows{}, err
	}
	result, err := sheetTotals(stored)
	if err != nil {
		return sheetRows{}, err
	}
	result.wfhMonthLimit = int(limits[settingcore.KeyWfhMonthLimit].Int)
	return result, nil
}

// sheetTotals takes a closed month's totals from its verified snapshot, never from a second formula, and an
// open month's from attendancecore.TotalsOf.
func sheetTotals(stored sheetPage) (sheetRows, error) {
	closed := make(map[string]map[string]attendancecore.Totals, len(stored.Closed))
	for _, m := range stored.Closed {
		snapshot, err := attendancecore.VerifiedSnapshot(m.Month, m.Snapshot, m.Hash)
		if err != nil {
			return sheetRows{}, err
		}
		employees := make(map[string]attendancecore.Totals, len(snapshot.Employees))
		for _, e := range snapshot.Employees {
			employees[e.EmployeeID] = e.Totals
		}
		closed[m.Month] = employees
	}
	effectsOf := attendancecore.EffectsIndex(stored.Effects)
	versions := schedulecore.ScheduleVersions(stored.Versions)
	result := sheetRows{total: stored.Total, rows: make([]AttendanceRow, 0, len(stored.Rows))}
	for _, row := range stored.Rows {
		out := AttendanceRow{
			Employee:    Employee{EmployeeID: row.EmployeeID, EmployeeCode: row.EmployeeCode, EmployeeName: row.EmployeeName},
			Month:       row.Month,
			PeriodState: row.PeriodState,
		}
		if row.PeriodState == attendancecore.PeriodClosed {
			totals, ok := closed[row.Month][row.EmployeeID]
			if !ok {
				return sheetRows{}, errMissingSnapshotRow
			}
			out.Totals = totals
			result.rows = append(result.rows, out)
			continue
		}
		effects := row.Effects
		if effects == nil {
			effects = effectsOf(row.EmployeeID, row.Month)
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
			return sheetRows{}, err
		}
		out.Totals = totals
		result.rows = append(result.rows, out)
	}
	return result, nil
}

// readAttendance is employee.reportAttendance: the full sheet per employee and month.
func readAttendance(c authority.QueryContext, q Query) (Result, error) {
	sheet, err := loadSheetRows(c, q)
	if err != nil {
		return nil, err
	}
	return Page[AttendanceRow]{Kind: KindAttendance, Total: sheet.total, Rows: sheet.rows}, nil
}

// readLateEarly is employee.reportLateEarly: approved late arrivals and early departures per employee and month.
func readLateEarly(c authority.QueryContext, q Query) (Result, error) {
	sheet, err := loadSheetRows(c, q)
	if err != nil {
		return nil, err
	}
	rows := make([]LateEarlyRow, len(sheet.rows))
	for i, r := range sheet.rows {
		rows[i] = LateEarlyRow{Employee: r.Employee, Month: r.Month, PeriodState: r.PeriodState,
			LateCount: r.LateCount, LateMinutes: r.LateMinutes, EarlyCount: r.EarlyCount, EarlyMinutes: r.EarlyMinutes}
	}
	return Page[LateEarlyRow]{Kind: KindLateEarly, Total: sheet.total, Rows: rows}, nil
}

// readWfh is employee.reportWfh: approved WFH days per employee and month of the WFH day, over the limit in force.
func readWfh(c authority.QueryContext, q Query) (Result, error) {
	sheet, err := loadSheetRows(c, q)
	if err != nil {
		return nil, err
	}
	rows := make([]WfhRow, len(sheet.rows))
	for i, r := range sheet.rows {
		rows[i] = WfhRow{Employee: r.Employee, Month: r.Month, PeriodState: r.PeriodState, WfhDays: r.WfhDays, OverLimit: r.WfhDays > sheet.wfhMonthLimit}
	}
	return Page[WfhRow]{Kind: KindWfh, Total: sheet.total, Rows: rows}, nil
}
