// Package leavecore holds the annual-leave rules shared by submit, approval, cancellation, the leave
// module and the reports: monthly accrual (D03), the invariant over every month (spec §8), the balance
// view (D09), the one reader of leave facts and the ledger effects of a decision.
package leavecore

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

type EmploymentStatus string

const (
	StatusProbation EmploymentStatus = "probation"
	StatusOfficial  EmploymentStatus = "official"
)

type StatusPeriod struct {
	Status   EmploymentStatus `json:"status"`
	StartsOn string           `json:"startsOn"`
	// EndsOn is exclusive; nil has no end.
	EndsOn *string `json:"endsOn"`
}

type RatePeriod struct {
	EffectiveFrom string `json:"effectiveFrom"`
	AnnualMinutes int    `json:"annualMinutes"`
}

// AccrualFacts is what the accrual of one employee and year depends on (business dates `YYYY-MM-DD`).
type AccrualFacts struct {
	Year    int
	HiredOn string
	// TerminatedOn is the last working day; nil while employed.
	TerminatedOn *string
	Periods      []StatusPeriod
	Rates        []RatePeriod
}

// DatedMinutes is minutes on a business date; a ledger net amount may be negative.
type DatedMinutes struct {
	Date    string `json:"date"`
	Minutes int    `json:"minutes"`
}

// PendingMinutes is a pending annual-leave segment with the request that holds it.
type PendingMinutes struct {
	RequestID string `json:"requestId"`
	Date      string `json:"date"`
	Minutes   int    `json:"minutes"`
}

// BalanceView is the annual leave balance at a report date (D09), in minutes of the report date's year.
type BalanceView struct {
	EmployeeID string `json:"employeeId"`
	Year       int    `json:"year"`
	AsOn       string `json:"asOn"`
	// AnnualMinutes is the rate in force while the report date is official; nil otherwise.
	AnnualMinutes         *int `json:"annualMinutes"`
	EntitledMinutes       int  `json:"entitledMinutes"`
	UsedMinutes           int  `json:"usedMinutes"`
	FutureApprovedMinutes int  `json:"futureApprovedMinutes"`
	PendingMinutes        int  `json:"pendingMinutes"`
	AvailableMinutes      int  `json:"availableMinutes"`
}

var ErrOutsideYear = errors.New("date is outside the leave year")

// monthIn is the month 1..12 of a business date of year.
func monthIn(date string, year int) (int, error) {
	if len(date) < 7 || !strings.HasPrefix(date, fmt.Sprintf("%04d-", year)) {
		return 0, ErrOutsideYear
	}
	tens, units := date[5], date[6]
	if tens < '0' || tens > '1' || units < '0' || units > '9' {
		return 0, ErrOutsideYear
	}
	m := int(tens-'0')*10 + int(units-'0')
	if m < 1 || m > 12 {
		return 0, ErrOutsideYear
	}
	return m, nil
}

func sortedRates(rates []RatePeriod) []RatePeriod {
	sorted := slices.Clone(rates)
	slices.SortStableFunc(sorted, func(a, b RatePeriod) int { return strings.Compare(a.EffectiveFrom, b.EffectiveFrom) })
	return sorted
}

// rateOn is the last rate starting on or before day.
func rateOn(rates []RatePeriod, day string) (RatePeriod, bool) {
	found, ok := RatePeriod{}, false
	for _, r := range rates {
		if r.EffectiveFrom <= day {
			found, ok = r, true
		}
	}
	return found, ok
}

func officialOn(periods []StatusPeriod, day string) bool {
	for _, p := range periods {
		if p.Status == StatusOfficial && p.StartsOn <= day && (p.EndsOn == nil || *p.EndsOn > day) {
			return true
		}
	}
	return false
}

// floorDiv12 is floor(n/12) for any sign, as Math.floor does.
func floorDiv12(n int) int {
	if n < 0 {
		return -((-n + 11) / 12)
	}
	return n / 12
}

// AccruedByMonth is the cumulative accrual at the end of each month 1..12 (index 0..11), D03. Month M
// counts when, on its 15th, the employee is employed and official; with k counted months and R the rate
// of that 15th, the month adds floor(R*k/12) − floor(R*(k−1)/12). No rate on a counted 15th accrues
// nothing: guessing a standard rate would grant leave unrecorded.
func AccruedByMonth(facts AccrualFacts) []int {
	rates := sortedRates(facts.Rates)
	cumulative := make([]int, 12)
	counted, total := 0, 0
	for month := 1; month <= 12; month++ {
		day := fmt.Sprintf("%04d-%02d-15", facts.Year, month)
		employed := facts.HiredOn <= day && (facts.TerminatedOn == nil || *facts.TerminatedOn >= day)
		if rate, ok := rateOn(rates, day); employed && officialOn(facts.Periods, day) && ok {
			counted++
			total += floorDiv12(rate.AnnualMinutes*counted) - floorDiv12(rate.AnnualMinutes*(counted-1))
		}
		cumulative[month-1] = total
	}
	return cumulative
}

// MonthlyMinutes is the minutes of entries summed per month of year (not cumulative).
func MonthlyMinutes(entries []DatedMinutes, year int) ([]int, error) {
	months := make([]int, 12)
	for _, entry := range entries {
		month, err := monthIn(entry.Date, year)
		if err != nil {
			return nil, err
		}
		months[month-1] += entry.Minutes
	}
	return months, nil
}

func cumulative(months []int) []int {
	sums := make([]int, len(months))
	sum := 0
	for i, minutes := range months {
		sum += minutes
		sums[i] = sum
	}
	return sums
}

// FirstMonthOver is the first month 1..12 whose committed minutes up to its end exceed the accrual to its
// end (spec §8), or 0. A negative entitlement only forbids taking leave.
func FirstMonthOver(accrued, committed []int) int {
	for i, used := range cumulative(committed) {
		limit := 0
		if i < len(accrued) {
			limit = max(0, accrued[i])
		}
		if used > limit {
			return i + 1
		}
	}
	return 0
}

// EntitledByMonth is accrual plus the opening/adjustment entries dated up to each month.
func EntitledByMonth(accrued []int, adjustments []DatedMinutes, year int) ([]int, error) {
	monthly, err := MonthlyMinutes(adjustments, year)
	if err != nil {
		return nil, err
	}
	adjusted := cumulative(monthly)
	entitled := make([]int, len(accrued))
	for i, minutes := range accrued {
		entitled[i] = minutes + adjusted[i]
	}
	return entitled, nil
}

type BalanceInput struct {
	EmployeeID  string
	AsOn        string
	Facts       AccrualFacts
	Adjustments []DatedMinutes
	Approved    []DatedMinutes
	Pending     []DatedMinutes
}

var ErrOtherYear = errors.New("facts are for another year")

// Balance is the balance at AsOn (D09); every list holds entries of the report year only.
func Balance(input BalanceInput) (BalanceView, error) {
	year := input.Facts.Year
	month, err := monthIn(input.AsOn, year)
	if err != nil {
		return BalanceView{}, ErrOtherYear
	}
	entitledByMonth, err := EntitledByMonth(AccruedByMonth(input.Facts), input.Adjustments, year)
	if err != nil {
		return BalanceView{}, err
	}
	view := BalanceView{EmployeeID: input.EmployeeID, Year: year, AsOn: input.AsOn, EntitledMinutes: entitledByMonth[month-1]}
	for _, e := range input.Approved {
		if e.Date <= input.AsOn {
			view.UsedMinutes += e.Minutes
		} else {
			view.FutureApprovedMinutes += e.Minutes
		}
	}
	for _, e := range input.Pending {
		view.PendingMinutes += e.Minutes
	}
	if officialOn(input.Facts.Periods, input.AsOn) {
		if rate, ok := rateOn(sortedRates(input.Facts.Rates), input.AsOn); ok {
			view.AnnualMinutes = &rate.AnnualMinutes
		}
	}
	view.AvailableMinutes = max(0, view.EntitledMinutes-view.UsedMinutes-view.FutureApprovedMinutes-view.PendingMinutes)
	return view, nil
}
