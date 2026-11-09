package schedulecore

import (
	"encoding/json/v2"
	"errors"
)

// StoredShift is [weekday, start, end] of one stored shift, ordered by weekday then position.
type StoredShift [3]int

type StoredVersion struct {
	From   string        `json:"from"`
	Shifts []StoredShift `json:"shifts"`
}

type StoredFrames struct {
	ID     string        `json:"id"`
	From   string        `json:"from"`
	To     *string       `json:"to"`
	Shifts []StoredShift `json:"shifts"`
}

type StoredMakeup struct {
	Date        string      `json:"date"`
	AsWeekday   int         `json:"asWeekday"`
	FrameSource FrameSource `json:"frameSource"`
}

// StoredSchedule is the calendar part of a schedule read: everything but the company versions.
type StoredSchedule struct {
	Frames     []StoredFrames `json:"frames"`
	Holidays   []string       `json:"holidays"`
	MakeupDays []StoredMakeup `json:"makeupDays"`
}

var ErrStoredSchedule = errors.New("stored schedule is invalid")

func day(column string) string { return "to_char(" + column + ",'YYYY-MM-DD')" }

func shiftsSQL(table, parent string) string {
	return `COALESCE((SELECT json_agg(json_build_array(s.weekday, s.start_minute, s.end_minute)
                    ORDER BY s.weekday, s.position)
               FROM ` + table + ` s WHERE s.schedule_id = ` + parent + `), '[]'::json)`
}

// ScheduleVersionsSQL is a JSON array (SQL fragment) of the company versions in force on some day of
// [first, next): the one in force on first and every later one starting before next. Arguments are SQL
// expressions of the caller's statement, never input.
func ScheduleVersionsSQL(first, next string) string {
	return `COALESCE((SELECT json_agg(json_build_object('from', ` + day("w.effective_from") + `,
                    'shifts', ` + shiftsSQL("work_schedule_shift", "w.id") + `) ORDER BY w.effective_from)
               FROM work_schedule w
              WHERE w.effective_from < ` + next + `
                AND w.effective_from >= (SELECT max(v.effective_from) FROM work_schedule v
                                          WHERE v.effective_from <= ` + first + `)), '[]'::json)`
}

// EmployeeFramesSQL is a JSON array (SQL fragment) of the frames of employee covering some day of [first, next).
func EmployeeFramesSQL(employee, first, next string) string {
	return `COALESCE((SELECT json_agg(json_build_object('id', o.id, 'from', ` + day("o.valid_from") + `, 'to', ` + day("o.valid_to") + `,
                    'shifts', ` + shiftsSQL("employee_schedule_shift", "o.id") + `) ORDER BY o.valid_from)
               FROM employee_schedule o
              WHERE o.employee_id = ` + employee + ` AND o.valid_from < ` + next + `
                AND (o.valid_to IS NULL OR o.valid_to >= ` + first + `)), '[]'::json)`
}

func byWeekday(shifts []StoredShift) map[int]Frame {
	days := map[int]Frame{}
	for _, s := range shifts {
		days[s[0]] = append(days[s[0]], Shift{s[1], s[2]})
	}
	return days
}

// WeekFrames is seven frames, Monday first; a weekday without shifts is empty.
func WeekFrames(shifts []StoredShift) []Frame {
	days := byWeekday(shifts)
	week := make([]Frame, 7)
	for w := 1; w <= 7; w++ {
		week[w-1] = days[w]
		if week[w-1] == nil {
			week[w-1] = Frame{}
		}
	}
	return week
}

// StoredShifts is the stored form of seven frames, as WeekFrames reads it back.
func StoredShifts(days []Frame) []StoredShift {
	stored := []StoredShift{}
	for index, frame := range days {
		for _, shift := range frame {
			stored = append(stored, StoredShift{index + 1, shift[0], shift[1]})
		}
	}
	return stored
}

func ScheduleVersions(stored []StoredVersion) []ScheduleVersion {
	versions := make([]ScheduleVersion, len(stored))
	for i, v := range stored {
		versions[i] = ScheduleVersion{EffectiveFrom: v.From, Days: WeekFrames(v.Shifts)}
	}
	return versions
}

func EmployeeFramesOf(stored []StoredFrames) []EmployeeFrames {
	frames := make([]EmployeeFrames, len(stored))
	for i, o := range stored {
		frames[i] = EmployeeFrames{ValidFrom: o.From, ValidTo: o.To, Days: byWeekday(o.Shifts)}
	}
	return frames
}

func Facts(versions []ScheduleVersion, stored StoredSchedule) ScheduleFacts {
	facts := ScheduleFacts{
		Versions:     versions,
		Overrides:    EmployeeFramesOf(stored.Frames),
		PaidHolidays: make(map[string]bool, len(stored.Holidays)),
		MakeupDays:   make(map[string]MakeupDay, len(stored.MakeupDays)),
	}
	for _, date := range stored.Holidays {
		facts.PaidHolidays[date] = true
	}
	for _, m := range stored.MakeupDays {
		facts.MakeupDays[m.Date] = MakeupDay{AsWeekday: m.AsWeekday, FrameSource: m.FrameSource}
	}
	return facts
}

// DecodeStored reads JSON built by the fragments of this package. A shape the fragments never produce is
// ErrStoredSchedule, so a changed statement fails instead of reading as days off.
func DecodeStored[T any](raw []byte) (T, error) {
	var value T
	if err := json.Unmarshal(raw, &value, json.RejectUnknownMembers(true)); err != nil {
		return value, ErrStoredSchedule
	}
	return value, nil
}
