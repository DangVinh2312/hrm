package attendancecore_test

import (
	"errors"
	"slices"
	"testing"

	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/hrbase"
	"hrm/api/internal/modules/schedulecore"
)

var standard = schedulecore.Frame{{540, 780}, {840, 1080}}

func schedule() schedulecore.ScheduleFacts {
	return schedulecore.ScheduleFacts{
		Versions:     []schedulecore.ScheduleVersion{{EffectiveFrom: "1900-01-01", Days: []schedulecore.Frame{standard, standard, standard, standard, standard, {}, {}}}},
		PaidHolidays: map[string]bool{}, MakeupDays: map[string]schedulecore.MakeupDay{},
	}
}

// November 2026: Sunday the 1st, 21 weekdays.
func facts() attendancecore.Facts {
	return attendancecore.Facts{Month: "2026-11", HiredOn: "2026-01-05", Schedule: schedule()}
}

func effect(kind hrbase.RequestKind, date string, start, end int) attendancecore.Effect {
	return attendancecore.Effect{Kind: kind, Date: date, StartMinute: start, EndMinute: end}
}

func ptr(s string) *string { return &s }

func totals(t *testing.T, f attendancecore.Facts) attendancecore.Totals {
	t.Helper()
	got, err := attendancecore.MonthTotals(f)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestAMonthWithoutRequestsIsPaidByTheCalendar(t *testing.T) {
	want := attendancecore.Totals{ScheduledMinutes: 10080, PaidMinutes: 10080}
	if got := totals(t, facts()); got != want {
		t.Fatalf("%+v", got)
	}
}

func TestNothingCountsOutsideEmployment(t *testing.T) {
	f := facts()
	f.HiredOn = "2026-11-16"
	if totals(t, f).ScheduledMinutes != 5280 {
		t.Fatal("hire")
	}
	f = facts()
	f.TerminatedOn = ptr("2026-11-13")
	if totals(t, f).ScheduledMinutes != 4800 {
		t.Fatal("leave")
	}
	f = facts()
	f.HiredOn = "2026-12-01"
	if totals(t, f).ScheduledMinutes != 0 {
		t.Fatal("hired after")
	}
	f = facts()
	f.TerminatedOn = ptr("2026-10-30")
	if totals(t, f).PaidMinutes != 0 {
		t.Fatal("left before")
	}
}

func TestMakeupDaysAndPaidHolidays(t *testing.T) {
	f := facts()
	f.Schedule.MakeupDays["2026-11-14"] = schedulecore.MakeupDay{AsWeekday: 1, FrameSource: schedulecore.FrameSourceCompany}
	if totals(t, f).ScheduledMinutes != 22*480 {
		t.Fatal("makeup")
	}
	f = facts()
	f.Schedule.PaidHolidays["2026-11-10"] = true
	if got := totals(t, f); got.ScheduledMinutes != 20*480 || got.PaidHolidayMinutes != 480 || got.PaidMinutes != 10080 {
		t.Fatalf("%+v", got)
	}
	f.HiredOn = "2026-11-16"
	if totals(t, f).PaidHolidayMinutes != 0 {
		t.Fatal("holiday outside employment")
	}
}

func TestAnEmployeeFrameSetsTheDayMinutes(t *testing.T) {
	f := facts()
	f.Schedule.PaidHolidays["2026-11-10"] = true
	f.Schedule.Overrides = []schedulecore.EmployeeFrames{{ValidFrom: "2026-11-01", Days: map[int]schedulecore.Frame{2: {{480, 720}}}}}
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestUnpaidLeave, "2026-11-03", 480, 1080)}
	if got := totals(t, f); got.ScheduledMinutes != 17*480+3*240 || got.PaidHolidayMinutes != 240 || got.UnpaidMinutes != 240 {
		t.Fatalf("%+v", got)
	}
}

func TestLeaveWfhLateAndEarly(t *testing.T) {
	for end, want := range map[int][2]int{660: {120, 9960}, 780: {240, 9840}, 1080: {480, 9600}} {
		f := facts()
		f.Effects = []attendancecore.Effect{effect(hrbase.RequestUnpaidLeave, "2026-11-03", 540, end)}
		if got := totals(t, f); got.UnpaidMinutes != want[0] || got.PaidMinutes != want[1] {
			t.Fatalf("%d: %+v", end, got)
		}
	}
	f := facts()
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestAnnualLeave, "2026-11-03", 540, 1080)}
	if got := totals(t, f); got.AnnualLeaveMinutes != 480 || got.UnpaidMinutes != 0 || got.PaidMinutes != 10080 {
		t.Fatalf("%+v", got)
	}
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestWfh, "2026-11-03", 540, 1080), effect(hrbase.RequestWfh, "2026-11-04", 540, 1080), effect(hrbase.RequestWfh, "2026-11-04", 540, 1080)}
	if got := totals(t, f); got.WfhDays != 2 || got.PaidMinutes != 10080 {
		t.Fatalf("%+v", got)
	}
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestLateArrival, "2026-11-03", 540, 600), effect(hrbase.RequestLateArrival, "2026-11-04", 840, 870), effect(hrbase.RequestEarlyDeparture, "2026-11-05", 1020, 1080)}
	if got := totals(t, f); got.LateCount != 2 || got.LateMinutes != 90 || got.EarlyCount != 1 || got.EarlyMinutes != 60 || got.PaidMinutes != 10080 {
		t.Fatalf("%+v", got)
	}
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestLateArrival, "2026-11-03", 540, 600), effect(hrbase.RequestLateArrival, "2026-11-03", 840, 870),
		effect(hrbase.RequestEarlyDeparture, "2026-11-05", 720, 780), effect(hrbase.RequestEarlyDeparture, "2026-11-05", 1020, 1080)}
	if got := totals(t, f); got.LateCount != 1 || got.LateMinutes != 90 || got.EarlyCount != 1 || got.EarlyMinutes != 120 {
		t.Fatalf("same day: %+v", got)
	}
}

func TestOverlappingLeaveIsNeverCountedTwice(t *testing.T) {
	f := facts()
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestUnpaidLeave, "2026-11-03", 540, 780), effect(hrbase.RequestAnnualLeave, "2026-11-03", 540, 660)}
	if got := totals(t, f); got.AnnualLeaveMinutes != 120 || got.UnpaidMinutes != 120 {
		t.Fatalf("%+v", got)
	}
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestUnpaidLeave, "2026-11-03", 540, 1080), effect(hrbase.RequestUnpaidLeave, "2026-11-03", 540, 660)}
	if totals(t, f).UnpaidMinutes != 480 {
		t.Fatal("unpaid above the day")
	}
}

func TestEffectsOutsideTheSheetChangeNothing(t *testing.T) {
	f := facts()
	f.HiredOn = "2026-11-16"
	f.Effects = []attendancecore.Effect{
		effect(hrbase.RequestUnpaidLeave, "2026-10-30", 540, 1080), effect(hrbase.RequestUnpaidLeave, "2026-11-07", 540, 1080),
		effect(hrbase.RequestUnpaidLeave, "2026-11-09", 540, 1080), effect(hrbase.RequestWfh, "2026-11-09", 540, 1080),
		effect(hrbase.RequestLateArrival, "2026-11-09", 540, 600),
	}
	if got := totals(t, f); got.UnpaidMinutes != 0 || got.WfhDays != 0 || got.LateCount != 0 || got.PaidMinutes != 5280 {
		t.Fatalf("%+v", got)
	}
}

func TestRecomputeIgnoresEffectOrderAndAddsAdjustments(t *testing.T) {
	f := facts()
	f.AdjustmentMinutes = 90
	f.Effects = []attendancecore.Effect{
		effect(hrbase.RequestUnpaidLeave, "2026-11-03", 540, 660), effect(hrbase.RequestAnnualLeave, "2026-11-05", 540, 1080),
		effect(hrbase.RequestLateArrival, "2026-11-04", 840, 870), effect(hrbase.RequestWfh, "2026-11-06", 540, 1080),
	}
	first := totals(t, f)
	reversed := f
	reversed.Effects = slices.Clone(f.Effects)
	slices.Reverse(reversed.Effects)
	if totals(t, reversed) != first || first.PaidMinutes != 10080-120+90 || first.AdjustmentMinutes != 90 {
		t.Fatalf("%+v", first)
	}
	f = facts()
	f.AdjustmentMinutes = -480
	f.Effects = []attendancecore.Effect{effect(hrbase.RequestUnpaidLeave, "2026-11-03", 540, 660)}
	if got := totals(t, f); got.AdjustmentMinutes != -480 || got.UnpaidMinutes != 120 || got.PaidMinutes != 9480 {
		t.Fatalf("%+v", got)
	}
	f = facts()
	f.HiredOn, f.AdjustmentMinutes = "2026-12-01", -60
	if totals(t, f).PaidMinutes != -60 {
		t.Fatal("the sheet clamps adjustments")
	}
}

func TestMonthDatesAndMonthGrammar(t *testing.T) {
	for month, n := range map[string]int{"2026-11": 30, "2028-02": 29, "2027-02": 28, "2026-12": 31} {
		if dates, err := attendancecore.MonthDates(month); err != nil || len(dates) != n || dates[n-1][:7] != month {
			t.Fatal(month, dates, err)
		}
	}
	for _, month := range []string{"2026-13", "2026-1", "2026-00", "1899-12", "2101-01", "2026-11-01", " 2026-11", ""} {
		if _, err := attendancecore.MonthDates(month); !errors.Is(err, attendancecore.ErrInvalidMonth) {
			t.Fatal(month, err)
		}
	}
	if got, err := attendancecore.MonthsOf([]string{"2026-12-31", "2026-11-30", "2027-01-01", "2026-12-01"}); err != nil || !slices.Equal(got, []string{"2026-11-01", "2026-12-01", "2027-01-01"}) {
		t.Fatal(got, err)
	}
	for _, value := range []string{"", "2026", "2026-1", "2026-02-30", "2026-03-1x"} {
		if got, err := attendancecore.MonthsOf([]string{"2026-03-01", value}); err == nil {
			t.Fatalf("MonthsOf accepted %q: %v", value, got)
		}
		if got, err := attendancecore.FirstOfMonth(value); err == nil {
			t.Fatalf("FirstOfMonth accepted %q: %q", value, got)
		}
	}
	for value, want := range map[string]string{"2026-03": "2026-03-01", "2026-03-31": "2026-03-01"} {
		if got, err := attendancecore.FirstOfMonth(value); err != nil || got != want {
			t.Fatal(value, got, err)
		}
	}
}
