package workschedule

import (
	"fmt"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/schedulecore"
	"hrm/api/internal/modules/settingcore"
)

const (
	shiftColumns         = `(schedule_id,weekday,position,start_minute,end_minute)`
	unnestShifts         = ` SELECT $1, w, p, s, e FROM unnest(CAST($2 AS int[]), CAST($3 AS int[]), CAST($4 AS int[]), CAST($5 AS int[])) AS t(w, p, s, e)`
	insertCompanyShifts  = `INSERT INTO work_schedule_shift` + shiftColumns + unnestShifts
	insertEmployeeShifts = `INSERT INTO employee_schedule_shift` + shiftColumns + unnestShifts
)

var errMakeupDay = fmt.Errorf("makeup day would break: %w", apperror.ErrCommandRejected)

type storedMakeup struct {
	Date      string `json:"date"`
	AsWeekday int    `json:"asWeekday"`
}

type storedMakeups struct {
	Versions string
	Makeup   string
}

// insertShifts writes the shifts of days under parent id; positions count from 1 within each weekday.
// statement is insertCompanyShifts or insertEmployeeShifts.
func insertShifts(tx *database.Tx, statement, id string, days []schedulecore.Frame) error {
	var weekdays, positions, starts, ends []int
	for index, frame := range days {
		for position, shift := range frame {
			weekdays, positions = append(weekdays, index+1), append(positions, position+1)
			starts, ends = append(starts, shift[0]), append(ends, shift[1])
		}
	}
	_, err := tx.Exec(statement, id, weekdays, positions, starts, ends)
	return err
}

func maxMinutes(tx *database.Tx) (int64, error) {
	values, err := settingcore.Read(tx, []settingcore.Key{settingcore.KeyWorkdayMaxMinutes})
	if err != nil {
		return 0, err
	}
	return values[settingcore.KeyWorkdayMaxMinutes].Int, nil
}

// checkWeek: every day a valid frame within hr.workdayMaxMinutes in force now, and at least one not empty.
func checkWeek(tx *database.Tx, days []schedulecore.Frame) error {
	limit, err := maxMinutes(tx)
	if err != nil {
		return err
	}
	empty := true
	for _, frame := range days {
		if !schedulecore.IsValidFrame(frame, int(limit)) {
			return apperror.ErrInvalidRequest
		}
		empty = empty && len(frame) == 0
	}
	if len(days) != 7 || empty {
		return apperror.ErrInvalidRequest
	}
	return nil
}

// checkMakeupDays: every makeup day from on still works a day the company has off, with the hours of a
// weekday the company works (the rule of a calendar change); otherwise the change is refused (409) rather
// than silently moving those days.
func checkMakeupDays(tx *database.Tx, from string) error {
	rows, err := tx.Query(`SELECT (`+schedulecore.ScheduleVersionsSQL("CAST($1 AS date)", "DATE 'infinity'")+`)::text AS versions,
              COALESCE((SELECT json_agg(json_build_object('date', to_char(d.day,'YYYY-MM-DD'),
                                'asWeekday', d.as_weekday))
                          FROM (SELECT DISTINCT ON (x.day) x.day, x.kind, x.as_weekday
                                  FROM work_calendar_change x WHERE x.day >= CAST($1 AS date)
                                 ORDER BY x.day, x.version DESC) d
                         WHERE d.kind = 'makeup_workday'), '[]'::json)::text AS makeup`, from)
	if err != nil {
		return err
	}
	stored, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[storedMakeups])
	if err != nil {
		return err
	}
	versions, err := schedulecore.DecodeStored[[]schedulecore.StoredVersion]([]byte(stored.Versions))
	if err != nil {
		return err
	}
	makeup, err := schedulecore.DecodeStored[[]storedMakeup]([]byte(stored.Makeup))
	if err != nil {
		return err
	}
	company := schedulecore.ScheduleVersions(versions)
	for _, day := range makeup {
		weekday, err := schedulecore.IsoWeekday(day.Date)
		if err != nil {
			return err
		}
		own, err := schedulecore.CompanyFrameOn(day.Date, weekday, company)
		if err != nil {
			return err
		}
		borrowed, err := schedulecore.CompanyFrameOn(day.Date, day.AsWeekday, company)
		if err != nil {
			return err
		}
		if len(own) > 0 || len(borrowed) == 0 {
			return errMakeupDay
		}
	}
	return nil
}
