package attendancecore

import (
	"encoding/json/v2"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
	"hrm/api/internal/modules/schedulecore"
)

var errPeriodClosed = apperror.Rejection{Code: "error.periodClosed"}

type factsStored struct {
	Rows     []FactsRow                   `json:"rows"`
	Effects  []EffectsGroup               `json:"effects"`
	Versions []schedulecore.StoredVersion `json:"versions"`
}

// LoadFacts reads everything the sheet of month depends on for exactly ids (nil or empty reads nobody),
// from ONE statement so one snapshot (F-08). Rows are in id order.
func LoadFacts(tx *database.Tx, month string, ids []string) ([]FactsRow, error) {
	if ids == nil {
		ids = []string{}
	}
	return loadFacts(tx, month, ids, len(ids) >= EffectsSetBasedMinRows)
}

// LoadAllFacts is LoadFacts for every employee whose employment overlaps month (the close).
func LoadAllFacts(tx *database.Tx, month string) ([]FactsRow, error) {
	return loadFacts(tx, month, nil, true)
}

// loadFacts reads every employee employed in month when ids is nil.
func loadFacts(tx *database.Tx, month string, ids []string, setBased bool) ([]FactsRow, error) {
	if _, err := ParseMonth(month); err != nil {
		return nil, err
	}
	window := MonthsWindow{First: `CAST($1 || '-01' AS date)`, Next: `CAST(CAST($1 || '-01' AS date) + interval '1 month' AS date)`}
	effectsCTE, rowEffects, groups := "", `'effects', `+ApprovedEffectsSQL("sel.id", "sel.first", "sel.next")+`,`, `'[]'::json`
	if setBased {
		effectsCTE, rowEffects, groups = `, fx AS (`+ApprovedEffectsBySQL("sel", window)+`)`, "", EffectsGroupsSQL("fx")
	}
	var idsArg any
	if ids != nil {
		idsArg = ids
	}
	rows, err := tx.Query(`WITH m AS (SELECT `+window.First+` AS first, `+window.Next+` AS next),
          cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST($3 AS uuid)),
          days AS (`+CalendarDaysCTE(window.First, window.Next)+`),
          sel AS (SELECT e.id, e.hired_on, e.terminated_on, m.first, m.next FROM employee e, m
                   WHERE CASE WHEN CAST($2 AS uuid[]) IS NULL
                              THEN e.hired_on < m.next AND (e.terminated_on IS NULL OR e.terminated_on >= m.first)
                              ELSE e.id = ANY(CAST($2 AS uuid[])) END)
          `+effectsCTE+`
     SELECT json_build_object(
              'rows', COALESCE((SELECT json_agg(json_build_object(
                        'id', sel.id::text, 'hiredOn', `+date("sel.hired_on")+`, 'terminatedOn', `+date("sel.terminated_on")+`,
                        'calendarVersion', (SELECT version::text FROM cal),
                        'periodState', (SELECT p.state FROM attendance_period p, m WHERE p.month = m.first),
                        'holidays', `+HolidaysSQL("sel.first", "sel.next")+`,
                        'makeupDays', `+MakeupDaysSQL("sel.first", "sel.next")+`,
                        'frames', `+schedulecore.EmployeeFramesSQL("sel.id", "sel.first", "sel.next")+`,
                        `+rowEffects+`
                        'adjustmentMinutes', `+AdjustmentMinutesSQL("sel.id", "sel.first", "sel.next")+`) ORDER BY sel.id)
                      FROM sel), '[]'::json),
              'effects', `+groups+`,
              'versions', `+schedulecore.ScheduleVersionsSQL(window.First, window.Next)+`)::text`,
		month, idsArg, permission.WorkCalendarID)
	if err != nil {
		return nil, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	var stored factsStored
	if err := json.Unmarshal([]byte(raw), &stored, json.RejectUnknownMembers(true)); err != nil {
		return nil, schedulecore.ErrStoredSchedule
	}
	effectsOf := EffectsIndex(stored.Effects)
	versions := schedulecore.ScheduleVersions(stored.Versions)
	for i := range stored.Rows {
		row := &stored.Rows[i]
		row.Versions = versions
		if row.Effects == nil {
			row.Effects = effectsOf(row.ID, month)
		}
	}
	if stored.Rows == nil {
		stored.Rows = []FactsRow{}
	}
	return stored.Rows, nil
}

// AssertPeriodsOpen locks the attendance period of every month of dates FOR SHARE, ascending, and refuses
// (409 error.periodClosed) when one is closed (D07). The row is upserted first because a lock on a missing
// row would let a close commit between this check and the caller's commit; a close takes the row FOR
// UPDATE, so it waits for every writer holding it. Called after the employee, request/bucket or calendar
// locks of its caller; the months of one request or day, never more than three.
func AssertPeriodsOpen(tx *database.Tx, dates []string) error {
	months, err := MonthsOf(dates)
	if err != nil {
		return err
	}
	for _, month := range months {
		if _, err := tx.Exec(`INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING`, month); err != nil {
			return err
		}
		rows, err := tx.Query(`SELECT state FROM attendance_period WHERE month = CAST($1 AS date) FOR SHARE`, month)
		if err != nil {
			return err
		}
		states, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		if len(states) != 1 || PeriodState(states[0]) != PeriodOpen {
			return errPeriodClosed
		}
	}
	return nil
}
