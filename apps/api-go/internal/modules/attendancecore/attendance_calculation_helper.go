// Package attendancecore holds the monthly attendance sheet shared by attendance, reports, requests and
// calendar changes (design §9, D05, D07): the pure totals, the one reader of attendance facts, the period
// guard and the attendance and WFH effects of a decision.
package attendancecore

import (
	"cmp"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"time"

	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/schedulecore"
)

// Effect is one segment of an approved request, as stored (the request row is the single source).
type Effect struct {
	Kind        hrbase.RequestKind `json:"kind"`
	Date        string             `json:"date"`
	StartMinute int                `json:"startMinute"`
	EndMinute   int                `json:"endMinute"`
}

// Facts is what the sheet of one employee and month depends on. Nothing reads a clock.
type Facts struct {
	// Month is `YYYY-MM`.
	Month   string
	HiredOn string
	// TerminatedOn is the last working day, inclusive; nil while employed.
	TerminatedOn *string
	Schedule     schedulecore.ScheduleFacts
	Effects      []Effect
	// AdjustmentMinutes is the signed sum of HR's audited adjustments dated in the month.
	AdjustmentMinutes int
}

// Totals of one month in minutes (D05). PaidMinutes = scheduled − unpaid + paid holidays + adjustments:
// annual leave, WFH and late/early never reduce it. The JSON order is the order of the sheet.
type Totals struct {
	ScheduledMinutes   int `json:"scheduledMinutes"`
	PaidHolidayMinutes int `json:"paidHolidayMinutes"`
	UnpaidMinutes      int `json:"unpaidMinutes"`
	AnnualLeaveMinutes int `json:"annualLeaveMinutes"`
	PaidMinutes        int `json:"paidMinutes"`
	WfhDays            int `json:"wfhDays"`
	LateCount          int `json:"lateCount"`
	LateMinutes        int `json:"lateMinutes"`
	EarlyCount         int `json:"earlyCount"`
	EarlyMinutes       int `json:"earlyMinutes"`
	AdjustmentMinutes  int `json:"adjustmentMinutes"`
}

var (
	ErrInvalidMonth = errors.New("invalid month")
	monthGrammar    = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})$`)
)

// ParseMonth accepts `YYYY-MM` of years 1900..2100 only.
func ParseMonth(value string) (string, error) {
	match := monthGrammar.FindStringSubmatch(value)
	if match == nil {
		return "", ErrInvalidMonth
	}
	var year, month int
	if _, err := fmt.Sscanf(value, "%4d-%2d", &year, &month); err != nil || year < 1900 || year > 2100 || month < 1 || month > 12 {
		return "", ErrInvalidMonth
	}
	return value, nil
}

// MonthDates is every date of `YYYY-MM`, in order.
func MonthDates(month string) ([]string, error) {
	if _, err := ParseMonth(month); err != nil {
		return nil, err
	}
	first, err := time.Parse("2006-01", month)
	if err != nil {
		return nil, ErrInvalidMonth
	}
	var dates []string
	for day := first; day.Month() == first.Month(); day = day.AddDate(0, 0, 1) {
		dates = append(dates, day.Format(time.DateOnly))
	}
	return dates, nil
}

type tally struct {
	count, minutes int
	days           map[string]bool
}

func (t *tally) add(date string, minutes int) {
	if !t.days[date] {
		t.count++
	}
	t.days[date] = true
	t.minutes += minutes
}

// MonthTotals computes the sheet; the same facts always give the same numbers, whatever the effect order.
func MonthTotals(facts Facts) (Totals, error) {
	dates, err := MonthDates(facts.Month)
	if err != nil {
		return Totals{}, err
	}
	work := map[string]schedulecore.Frame{}
	totals := Totals{AdjustmentMinutes: facts.AdjustmentMinutes}
	for _, date := range dates {
		if date < facts.HiredOn || (facts.TerminatedOn != nil && date > *facts.TerminatedOn) {
			continue
		}
		day, err := schedulecore.FrameOn(date, facts.Schedule)
		if err != nil {
			return Totals{}, err
		}
		switch day.Kind {
		case schedulecore.DayWorkday, schedulecore.DayMakeupWorkday:
			work[date] = day.Frame
			totals.ScheduledMinutes += schedulecore.FrameMinutes(day.Frame)
		case schedulecore.DayPaidHoliday:
			totals.PaidHolidayMinutes += schedulecore.FrameMinutes(day.Frame)
		case schedulecore.DayOff:
		}
	}
	// Annual leave sorts before unpaid leave, so a minute shared by both is attributed to annual leave.
	effects := slices.DeleteFunc(slices.Clone(facts.Effects), func(e Effect) bool { _, ok := work[e.Date]; return !ok })
	slices.SortFunc(effects, func(a, b Effect) int {
		return cmp.Or(cmp.Compare(a.Date, b.Date), cmp.Compare(a.Kind, b.Kind), cmp.Compare(a.StartMinute, b.StartMinute), cmp.Compare(a.EndMinute, b.EndMinute))
	})
	covered := map[string]*[1440]bool{}
	wfh := map[string]bool{}
	late, early := tally{days: map[string]bool{}}, tally{days: map[string]bool{}}
	for _, e := range effects {
		switch e.Kind {
		case hrbase.RequestUnpaidLeave, hrbase.RequestAnnualLeave:
			day := covered[e.Date]
			if day == nil {
				day = &[1440]bool{}
				covered[e.Date] = day
			}
			minutes := 0
			for _, shift := range work[e.Date] {
				for m := max(shift[0], e.StartMinute); m < min(shift[1], e.EndMinute); m++ {
					if !day[m] {
						day[m] = true
						minutes++
					}
				}
			}
			if e.Kind == hrbase.RequestUnpaidLeave {
				totals.UnpaidMinutes += minutes
			} else {
				totals.AnnualLeaveMinutes += minutes
			}
		case hrbase.RequestWfh:
			wfh[e.Date] = true
		case hrbase.RequestLateArrival:
			late.add(e.Date, e.EndMinute-e.StartMinute)
		case hrbase.RequestEarlyDeparture:
			early.add(e.Date, e.EndMinute-e.StartMinute)
		}
	}
	totals.PaidMinutes = totals.ScheduledMinutes - totals.UnpaidMinutes + totals.PaidHolidayMinutes + facts.AdjustmentMinutes
	totals.WfhDays = len(wfh)
	totals.LateCount, totals.LateMinutes = late.count, late.minutes
	totals.EarlyCount, totals.EarlyMinutes = early.count, early.minutes
	return totals, nil
}
