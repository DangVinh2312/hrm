package workschedule

import (
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/internal/modules/schedulecore"
)

const (
	todaySQL = `to_char(` + hrbase.BusinessToday + `,'YYYY-MM-DD')`
	endSQL   = `DATE '2101-01-01'`
)

var errNoCalendar = errors.New("work calendar anchor is missing")

type none struct{}

type storedToday struct {
	Today  string
	Stored string
}

type storedEmployee struct {
	ID       string
	Calendar *string
}

func readToday(c authority.QueryContext, sql string, args []any) ([]storedToday, error) {
	rows, err := c.Tx.Query(sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[storedToday])
}

// readCompanySchedule is workCalendar.read: the company version in force today and every later one.
func readCompanySchedule(c authority.QueryContext, _ none) (authority.QueryResult[CompanyScheduleView], error) {
	var result authority.QueryResult[CompanyScheduleView]
	args, at, err := c.Scope.Args(permission.WorkCalendarID)
	if err != nil {
		return result, err
	}
	found, err := readToday(c, `SELECT `+todaySQL+` AS today, (`+schedulecore.ScheduleVersionsSQL(hrbase.BusinessToday, endSQL)+`)::text AS versions
           FROM work_calendar r WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args)
	if err != nil || len(found) == 0 {
		return result, err
	}
	stored, err := schedulecore.DecodeStored[[]schedulecore.StoredVersion]([]byte(found[0].Stored))
	if err != nil {
		return result, err
	}
	limit, err := maxMinutes(c.Tx)
	if err != nil {
		return result, err
	}
	view := CompanyScheduleView{Today: found[0].Today, MaxMinutes: limit, Versions: []CompanyScheduleVersion{}}
	for _, version := range schedulecore.ScheduleVersions(stored) {
		view.Versions = append(view.Versions, CompanyScheduleVersion{EffectiveFrom: version.EffectiveFrom, Days: version.Days})
	}
	return authority.QueryResult[CompanyScheduleView]{Found: true, Value: view}, nil
}

// readEmployeeFrames is employee.readSchedule: the employee's frames that end today or later.
func readEmployeeFrames(c authority.QueryContext, employeeID string) (authority.QueryResult[FramesView], error) {
	var result authority.QueryResult[FramesView]
	args, at, err := c.Scope.Args(employeeID)
	if err != nil {
		return result, err
	}
	found, err := readToday(c, `SELECT `+todaySQL+` AS today, (`+schedulecore.EmployeeFramesSQL("r.id", hrbase.BusinessToday, endSQL)+`)::text AS frames
           FROM employee r WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args)
	if err != nil || len(found) == 0 {
		return result, err
	}
	stored, err := schedulecore.DecodeStored[[]schedulecore.StoredFrames]([]byte(found[0].Stored))
	if err != nil {
		return result, err
	}
	limit, err := maxMinutes(c.Tx)
	if err != nil {
		return result, err
	}
	view := FramesView{Today: found[0].Today, MaxMinutes: limit, Frames: []FrameView{}}
	for _, frame := range stored {
		view.Frames = append(view.Frames, FrameView{ID: frame.ID, ValidFrom: frame.From, ValidTo: frame.To, Days: schedulecore.WeekFrames(frame.Shifts)})
	}
	return authority.QueryResult[FramesView]{Found: true, Value: view}, nil
}

// readEmployeeDays is employee.readSchedule: the hours of each day of From..To at the current calendar
// version. The scope is checked first, so the schedule of an employee out of scope is never read.
func readEmployeeDays(c authority.QueryContext, query ScheduleQuery) (authority.QueryResult[ScheduleView], error) {
	var result authority.QueryResult[ScheduleView]
	args, at, err := c.Scope.Args(query.EmployeeID, permission.WorkCalendarID)
	if err != nil {
		return result, err
	}
	rows, err := c.Tx.Query(`SELECT r.id::text AS id,
                (SELECT c.version::text FROM work_calendar c WHERE c.id = CAST(`+at(2)+` AS uuid)) AS calendar
           FROM employee r WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return result, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedEmployee])
	if err != nil || len(found) == 0 {
		return result, err
	}
	if found[0].Calendar == nil {
		return result, errNoCalendar
	}
	dates := schedulecore.DatesBetween(query.From, query.To, maxScheduleRangeDays)
	if len(dates) == 0 {
		return result, apperror.ErrInvalidRequest
	}
	facts, err := schedulecore.EmployeeSchedule(c.Tx, found[0].ID, dates, *found[0].Calendar)
	if err != nil {
		return result, err
	}
	view := ScheduleView{EmployeeID: found[0].ID, Days: make([]ScheduleDay, 0, len(dates))}
	for _, date := range dates {
		day, err := schedulecore.FrameOn(date, facts)
		if err != nil {
			return result, err
		}
		view.Days = append(view.Days, ScheduleDay{Date: date, Kind: day.Kind, Shifts: day.Frame})
	}
	return authority.QueryResult[ScheduleView]{Found: true, Value: view}, nil
}
