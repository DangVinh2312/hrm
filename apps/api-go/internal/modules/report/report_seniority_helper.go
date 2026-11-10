package report

import (
	"errors"
	"time"

	"hrm/api-go/internal/modules/schedulecore"
)

var errNotEmployed = errors.New("employee is not employed at the cutoff")

const day = 24 * time.Hour

// addMonths is start plus count months, the day clamped to the end of the target month, so 2024-01-31 plus
// one month is 2024-02-29.
func addMonths(start time.Time, count int) time.Time {
	first := time.Date(start.Year(), start.Month()+time.Month(count), 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	return time.Date(first.Year(), first.Month(), min(start.Day(), last), 0, 0, 0, 0, time.UTC)
}

// seniorityOf is the service from hiredOn to asOn, both days counted, in UTC calendar days: errNotEmployed
// when asOn precedes hiredOn.
func seniorityOf(hiredOn, asOn string) (Seniority, error) {
	hired, err := schedulecore.ParseDate(hiredOn)
	if err != nil {
		return Seniority{}, err
	}
	end, err := schedulecore.ParseDate(asOn)
	if err != nil {
		return Seniority{}, err
	}
	if end.Before(hired) {
		return Seniority{}, errNotEmployed
	}
	exclusive := end.AddDate(0, 0, 1)
	months := (end.Year()-hired.Year())*12 + int(end.Month()-hired.Month()) + 1
	for months > 0 && addMonths(hired, months).After(exclusive) {
		months--
	}
	return Seniority{
		Years:     months / 12,
		Months:    months % 12,
		Days:      int(exclusive.Sub(addMonths(hired, months)) / day),
		TotalDays: int(exclusive.Sub(hired) / day),
	}, nil
}
