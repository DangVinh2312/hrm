package leavecore_test

import (
	"errors"
	"reflect"
	"testing"

	"hrm/api-go/internal/modules/leavecore"
)

const employee = "7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f"

func ptr(s string) *string { return &s }

func official(from string) []leavecore.StatusPeriod {
	return []leavecore.StatusPeriod{{Status: leavecore.StatusOfficial, StartsOn: from}}
}

func rate(from string, minutes int) []leavecore.RatePeriod {
	return []leavecore.RatePeriod{{EffectiveFrom: from, AnnualMinutes: minutes}}
}

func base() leavecore.AccrualFacts {
	return leavecore.AccrualFacts{Year: 2026, HiredOn: "2025-01-06", Periods: official("2025-01-06"), Rates: rate("2025-01-06", 5760)}
}

func at(accrued []int, month int) int { return accrued[month-1] }

func monthly(t *testing.T, entries ...leavecore.DatedMinutes) []int {
	t.Helper()
	months, err := leavecore.MonthlyMinutes(entries, 2026)
	if err != nil {
		t.Fatal(err)
	}
	return months
}

func TestTheStandardRateAccruesExactlyTwelveDays(t *testing.T) {
	accrued := leavecore.AccruedByMonth(base())
	if len(accrued) != 12 || at(accrued, 1) != 480 || at(accrued, 3) != 1440 || at(accrued, 12) != 5760 {
		t.Fatal(accrued)
	}
}

func TestAnAgreedRateAccruesTheCumulativeFloorWithoutDrift(t *testing.T) {
	f := base()
	f.Rates = rate("2025-01-06", 6720)
	if accrued := leavecore.AccruedByMonth(f); at(accrued, 3) != 1680 || at(accrued, 12) != 6720 {
		t.Fatal(accrued)
	}
	f.Rates = rate("2025-01-06", 5761)
	odd := leavecore.AccruedByMonth(f)
	if at(odd, 1) != 480 || at(odd, 12) != 5761 {
		t.Fatal(odd)
	}
	for month := 2; month <= 12; month++ {
		if at(odd, month) < at(odd, month-1) {
			t.Fatalf("not monotonic at %d", month)
		}
	}
}

func TestHiredOfficialMidYearCountsMonthsOfficialOnTheFifteenth(t *testing.T) {
	from := func(date string) []int {
		return leavecore.AccruedByMonth(leavecore.AccrualFacts{Year: 2026, HiredOn: date, Periods: official(date), Rates: rate(date, 5760)})
	}
	if at(from("2026-07-01"), 12) != 2880 || at(from("2026-07-15"), 12) != 2880 || at(from("2026-07-16"), 12) != 2400 {
		t.Fatal("mid-year hire")
	}
	if at(from("2026-07-01"), 6) != 0 || at(from("2026-07-01"), 7) != 480 {
		t.Fatal("months before the hire")
	}
}

func TestProbationAccruesNothingAndIsNotPaidBack(t *testing.T) {
	accrued := leavecore.AccruedByMonth(leavecore.AccrualFacts{Year: 2026, HiredOn: "2026-07-01", Rates: rate("2026-07-01", 5760), Periods: []leavecore.StatusPeriod{
		{Status: leavecore.StatusProbation, StartsOn: "2026-07-01", EndsOn: ptr("2026-09-01")},
		{Status: leavecore.StatusOfficial, StartsOn: "2026-09-01"},
	}})
	if at(accrued, 8) != 0 || at(accrued, 9) != 480 || at(accrued, 12) != 1920 {
		t.Fatal(accrued)
	}
	p1 := leavecore.AccruedByMonth(leavecore.AccrualFacts{Year: 2026, HiredOn: "2026-01-05", Rates: rate("2026-01-05", 5760), Periods: []leavecore.StatusPeriod{
		{Status: leavecore.StatusProbation, StartsOn: "2026-01-05", EndsOn: ptr("2026-11-16")},
		{Status: leavecore.StatusOfficial, StartsOn: "2026-11-16"},
	}})
	if at(p1, 11) != 0 || at(p1, 12) != 480 {
		t.Fatal(p1)
	}
}

func TestTheLastWorkingDayOnOrAfterTheFifteenthCountsTheMonth(t *testing.T) {
	for terminated, want := range map[string]int{"2026-06-15": 2880, "2026-06-14": 2400, "2025-12-31": 0} {
		f := base()
		f.TerminatedOn = ptr(terminated)
		if got := at(leavecore.AccruedByMonth(f), 12); got != want {
			t.Fatalf("%s: %d", terminated, got)
		}
	}
}

func TestARateChangeAppliesPerMonthOnTheRateOfThatFifteenth(t *testing.T) {
	f := base()
	f.Rates = []leavecore.RatePeriod{{EffectiveFrom: "2026-07-15", AnnualMinutes: 6720}, {EffectiveFrom: "2025-01-06", AnnualMinutes: 5760}}
	accrued := leavecore.AccruedByMonth(f)
	if at(accrued, 6) != 2880 || at(accrued, 7) != 2880+(6720*7/12-6720*6/12) || at(accrued, 12) != 2880+(6720-6720*6/12) {
		t.Fatal(accrued)
	}
	f.Rates = []leavecore.RatePeriod{{EffectiveFrom: "2025-01-06", AnnualMinutes: 5760}, {EffectiveFrom: "2026-07-16", AnnualMinutes: 6720}}
	if late := leavecore.AccruedByMonth(f); at(late, 7) != 3360 {
		t.Fatal(late)
	}
}

func TestNoCarryOverNoSeniorityAndNoGuessedRate(t *testing.T) {
	f := base()
	f.HiredOn = "2020-01-06"
	for _, year := range []int{2026, 2027} {
		f.Year = year
		if accrued := leavecore.AccruedByMonth(f); at(accrued, 1) != 480 || at(accrued, 12) != 5760 {
			t.Fatal(year, accrued)
		}
	}
	none := base()
	none.Rates = nil
	if at(leavecore.AccruedByMonth(none), 12) != 0 {
		t.Fatal("a missing rate accrued")
	}
}

func TestFirstMonthOverChecksCumulativeCommittedMinutes(t *testing.T) {
	accrued := leavecore.AccruedByMonth(base())
	d := func(date string, minutes int) leavecore.DatedMinutes {
		return leavecore.DatedMinutes{Date: date, Minutes: minutes}
	}
	for name, c := range map[string]struct {
		entries []leavecore.DatedMinutes
		want    int
	}{
		"none":            {nil, 0},
		"five days March": {[]leavecore.DatedMinutes{d("2026-03-02", 2400)}, 3},
		"exact":           {[]leavecore.DatedMinutes{d("2026-03-31", 1440)}, 0},
		"one more":        {[]leavecore.DatedMinutes{d("2026-03-31", 1441)}, 3},
		"early months":    {[]leavecore.DatedMinutes{d("2026-01-05", 480), d("2026-02-03", 480)}, 0},
		"cumulative":      {[]leavecore.DatedMinutes{d("2026-01-05", 480), d("2026-01-06", 480)}, 1},
	} {
		if got := leavecore.FirstMonthOver(accrued, monthly(t, c.entries...)); got != c.want {
			t.Fatalf("%s: %d", name, got)
		}
	}
	negative := []int{-960, -480, 0, 480, 960, 1440, 1920, 2400, 2880, 3360, 3840, 4320}
	for name, c := range map[string]struct {
		entries []leavecore.DatedMinutes
		want    int
	}{
		"nothing": {nil, 0}, "April fits": {[]leavecore.DatedMinutes{d("2026-04-10", 480)}, 0},
		"April over": {[]leavecore.DatedMinutes{d("2026-04-10", 481)}, 4}, "February": {[]leavecore.DatedMinutes{d("2026-02-10", 1)}, 2},
	} {
		if got := leavecore.FirstMonthOver(negative, monthly(t, c.entries...)); got != c.want {
			t.Fatalf("negative %s: %d", name, got)
		}
	}
	if got := leavecore.FirstMonthOver([]int{480, 960}, []int{0, 960}); got != 0 {
		t.Fatalf("short accrual, February fits: %d", got)
	}
	if got := leavecore.FirstMonthOver([]int{480, 960}, []int{0, 960, 0}); got != 3 {
		t.Fatalf("a month past the accrual counts against 0: %d", got)
	}
	for _, date := range []string{"2027-01-01", "2026-1x-01", "2026-+1-01", "2026- 3-01", "2026-00-01", "2026-13-01", "2026-1"} {
		if _, err := leavecore.MonthlyMinutes([]leavecore.DatedMinutes{d(date, 1)}, 2026); !errors.Is(err, leavecore.ErrOutsideYear) {
			t.Fatal(date, err)
		}
	}
}

func balance(t *testing.T, input leavecore.BalanceInput) leavecore.BalanceView {
	t.Helper()
	view, err := leavecore.Balance(input)
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func TestTheBalanceViewSeparatesEntitledUsedFutureAndPending(t *testing.T) {
	view := balance(t, leavecore.BalanceInput{EmployeeID: employee, AsOn: "2026-11-30", Facts: base(),
		Approved: []leavecore.DatedMinutes{{Date: "2026-11-04", Minutes: 240}, {Date: "2026-11-30", Minutes: 480}, {Date: "2026-12-15", Minutes: 480}},
		Pending:  []leavecore.DatedMinutes{{Date: "2026-12-16", Minutes: 240}}})
	rate := 5760
	want := leavecore.BalanceView{EmployeeID: employee, Year: 2026, AsOn: "2026-11-30", AnnualMinutes: &rate, EntitledMinutes: 5280,
		UsedMinutes: 720, FutureApprovedMinutes: 480, PendingMinutes: 240, AvailableMinutes: 5280 - 720 - 480 - 240}
	if !reflect.DeepEqual(view, want) {
		t.Fatalf("%+v", view)
	}
}

func TestTheBalanceViewShowsNoRateWhileNotOfficial(t *testing.T) {
	view := func(asOn string, rates []leavecore.RatePeriod) leavecore.BalanceView {
		return balance(t, leavecore.BalanceInput{EmployeeID: employee, AsOn: asOn, Facts: leavecore.AccrualFacts{Year: 2026, HiredOn: "2026-01-05", Rates: rates,
			Periods: []leavecore.StatusPeriod{{Status: leavecore.StatusProbation, StartsOn: "2026-01-05", EndsOn: ptr("2026-09-01")}, {Status: leavecore.StatusOfficial, StartsOn: "2026-09-01"}}}})
	}
	standardRate := rate("2026-09-01", 5760)
	if v := view("2026-08-31", standardRate); v.AnnualMinutes != nil || v.EntitledMinutes != 0 {
		t.Fatalf("%+v", v)
	}
	if v := view("2026-09-01", standardRate); v.AnnualMinutes == nil || *v.AnnualMinutes != 5760 {
		t.Fatalf("%+v", v)
	}
	legacy := rate("2026-01-05", 5760)
	if v := view("2026-03-31", legacy); v.AnnualMinutes != nil {
		t.Fatal("rate shown on probation")
	}
	if v := view("2026-09-30", legacy); v.AnnualMinutes == nil || *v.AnnualMinutes != 5760 {
		t.Fatal("legacy rate hidden while official")
	}
	if v := view("2026-09-30", nil); v.AnnualMinutes != nil {
		t.Fatal("guessed rate")
	}
}

func TestAvailableNeverGoesBelowZeroAndLaterEntriesStayOut(t *testing.T) {
	view := balance(t, leavecore.BalanceInput{EmployeeID: employee, AsOn: "2026-02-10", Facts: base(),
		Adjustments: []leavecore.DatedMinutes{{Date: "2026-01-02", Minutes: -2000}, {Date: "2026-05-02", Minutes: 4000}},
		Pending:     []leavecore.DatedMinutes{{Date: "2026-02-12", Minutes: 480}}})
	if view.EntitledMinutes != 960-2000 || view.AvailableMinutes != 0 {
		t.Fatalf("%+v", view)
	}
}

func TestTheReportYearIsTheYearOfTheDateAndAReversalNetsOut(t *testing.T) {
	f := base()
	f.Year = 2027
	view := balance(t, leavecore.BalanceInput{EmployeeID: employee, AsOn: "2027-01-20", Facts: f,
		Approved: []leavecore.DatedMinutes{{Date: "2027-01-12", Minutes: 480}, {Date: "2027-01-12", Minutes: -480}}})
	if view.Year != 2027 || view.UsedMinutes != 0 || view.EntitledMinutes != 480 || view.AvailableMinutes != 480 {
		t.Fatalf("%+v", view)
	}
	if _, err := leavecore.Balance(leavecore.BalanceInput{AsOn: "2026-01-20", Facts: f}); !errors.Is(err, leavecore.ErrOtherYear) {
		t.Fatal(err)
	}
}

func TestFactsOfSplitsTheLedgerAndRejectsUnknownShapes(t *testing.T) {
	row, err := leavecore.DecodeFactsRow([]byte(`{"hiredOn":"2025-01-06","terminatedOn":null,"periods":[{"status":"official","startsOn":"2025-01-06","endsOn":null}],
	  "rates":[{"effectiveFrom":"2025-01-06","annualMinutes":5760}],
	  "ledger":[{"kind":"opening","date":"2026-01-01","minutes":120},{"kind":"debit","date":"2026-02-02","minutes":480},
	            {"kind":"reversal","date":"2026-02-02","minutes":480},{"kind":"adjustment","date":"2026-03-01","minutes":-60}],
	  "pending":[{"requestId":"r1","date":"2026-04-01","minutes":240}]}`))
	if err != nil {
		t.Fatal(err)
	}
	facts := leavecore.FactsOf(row, 2026)
	if !reflect.DeepEqual(facts.Adjustments, []leavecore.DatedMinutes{{Date: "2026-01-01", Minutes: 120}, {Date: "2026-03-01", Minutes: -60}}) ||
		!reflect.DeepEqual(facts.Approved, []leavecore.DatedMinutes{{Date: "2026-02-02", Minutes: 480}, {Date: "2026-02-02", Minutes: -480}}) ||
		len(facts.Pending) != 1 || facts.Accrual.Year != 2026 {
		t.Fatalf("%+v", facts)
	}
	if _, err := leavecore.DecodeFactsRow([]byte(`{"hiredOn":"x","other":1}`)); !errors.Is(err, leavecore.ErrStoredFacts) {
		t.Fatal(err)
	}
}
