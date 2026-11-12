// Package schedulecore holds the business dates and working hours shared by the HR modules (ADR-19):
// pure helpers over `YYYY-MM-DD` dates and minutes of the day, the SQL fragments that read stored
// schedules inside the caller's statement, and the schedule of one employee.
package schedulecore

import (
	"regexp"
	"time"
)

type WorkingTimeRejection string

const (
	RejectInvalidDate   WorkingTimeRejection = "invalid_date"
	RejectInvalidSlot   WorkingTimeRejection = "invalid_slot"
	RejectNonWorkingDay WorkingTimeRejection = "non_working_day"
	RejectMakeupDay     WorkingTimeRejection = "makeup_day"
)

// WorkingTimeRejected is a refused date or slot; the caller maps the reason to its own answer.
type WorkingTimeRejected struct {
	Reason WorkingTimeRejection
}

func (e WorkingTimeRejected) Error() string { return "working time rejected: " + string(e.Reason) }

// MaxHolidayRangeDays is the longest holiday range of one request, both ends included.
const MaxHolidayRangeDays = 31

var dateGrammar = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})$`)

// ParseDate reads a business date in UTC, refusing days that do not exist instead of rolling them over.
func ParseDate(date string) (time.Time, error) {
	match := dateGrammar.FindStringSubmatch(date)
	if match == nil {
		return time.Time{}, WorkingTimeRejected{RejectInvalidDate}
	}
	year, month, day := atoi(match[1]), atoi(match[2]), atoi(match[3])
	value := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if year < 1900 || year > 2100 || value.Year() != year || int(value.Month()) != month || value.Day() != day {
		return time.Time{}, WorkingTimeRejected{RejectInvalidDate}
	}
	return value, nil
}

func atoi(digits string) int {
	n := 0
	for _, c := range digits {
		n = n*10 + int(c-'0')
	}
	return n
}

// IsoWeekday is 1 (Monday)..7 (Sunday) of a valid business date.
func IsoWeekday(date string) (int, error) {
	value, err := ParseDate(date)
	if err != nil {
		return 0, err
	}
	if day := int(value.Weekday()); day != 0 {
		return day, nil
	}
	return 7, nil
}

// DatesBetween is every date of from..to in order. Empty when from > to, when the range is longer than
// maxDays, or when either end is not a valid business date (the caller refuses all three).
func DatesBetween(from, to string, maxDays int) []string {
	start, err := ParseDate(from)
	if err != nil {
		return []string{}
	}
	end, err := ParseDate(to)
	if err != nil || end.Before(start) || end.Sub(start)/(24*time.Hour) >= time.Duration(maxDays) {
		return []string{}
	}
	dates := []string{}
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		dates = append(dates, day.Format(time.DateOnly))
	}
	return dates
}
