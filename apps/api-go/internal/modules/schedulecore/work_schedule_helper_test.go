package schedulecore_test

import (
	"errors"
	"reflect"
	"testing"

	"hrm/api-go/internal/modules/schedulecore"
)

// 2026-11-02 is a Monday, 2026-11-07 a Saturday, 2026-11-08 a Sunday.
var standard = schedulecore.Frame{{540, 780}, {840, 1080}}

var earlyFrame = schedulecore.Frame{{510, 780}, {840, 1050}}

func week(workday, weekend schedulecore.Frame) []schedulecore.Frame {
	return []schedulecore.Frame{workday, workday, workday, workday, workday, weekend, weekend}
}

var seed = schedulecore.ScheduleVersion{EffectiveFrom: "1900-01-01", Days: week(standard, schedulecore.Frame{})}

type factsOption func(*schedulecore.ScheduleFacts)

func facts(options ...factsOption) schedulecore.ScheduleFacts {
	f := schedulecore.ScheduleFacts{Versions: []schedulecore.ScheduleVersion{seed}, PaidHolidays: map[string]bool{}, MakeupDays: map[string]schedulecore.MakeupDay{}}
	for _, option := range options {
		option(&f)
	}
	return f
}

func own(from string, to *string, days map[int]schedulecore.Frame) factsOption {
	return func(f *schedulecore.ScheduleFacts) {
		f.Overrides = append(f.Overrides, schedulecore.EmployeeFrames{ValidFrom: from, ValidTo: to, Days: days})
	}
}

func versions(v ...schedulecore.ScheduleVersion) factsOption {
	return func(f *schedulecore.ScheduleFacts) { f.Versions = v }
}

func holidays(dates ...string) factsOption {
	return func(f *schedulecore.ScheduleFacts) {
		for _, d := range dates {
			f.PaidHolidays[d] = true
		}
	}
}

func makeup(date string, weekday int, source schedulecore.FrameSource) factsOption {
	return func(f *schedulecore.ScheduleFacts) {
		f.MakeupDays[date] = schedulecore.MakeupDay{AsWeekday: weekday, FrameSource: source}
	}
}

func ptr(s string) *string { return &s }

var (
	workday = schedulecore.DaySchedule{Kind: schedulecore.DayWorkday, Frame: standard}
	off     = schedulecore.DaySchedule{Kind: schedulecore.DayOff, Frame: schedulecore.Frame{}}
)

func dayIs(t *testing.T, date string, f schedulecore.ScheduleFacts, want schedulecore.DaySchedule) {
	t.Helper()
	got, err := schedulecore.FrameOn(date, f)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: %+v %v, want %+v", date, got, err, want)
	}
}

func TestTheSeededScheduleKeepsTheOldWeek(t *testing.T) {
	for _, date := range []string{"2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"} {
		dayIs(t, date, facts(), workday)
	}
	dayIs(t, "2026-11-07", facts(), off)
	dayIs(t, "2026-11-08", facts(), off)
	if schedulecore.FrameMinutes(standard) != 480 {
		t.Fatal("standard frame")
	}
}

func TestLeaveSlotsAndEdges(t *testing.T) {
	custom := schedulecore.DaySchedule{Kind: schedulecore.DayWorkday, Frame: earlyFrame}
	for _, c := range []struct {
		day                 schedulecore.DaySchedule
		start, end, minutes int
	}{
		{workday, 540, 660, 120}, {workday, 660, 780, 120}, {workday, 840, 960, 120}, {workday, 960, 1080, 120},
		{workday, 540, 780, 240}, {workday, 840, 1080, 240}, {workday, 540, 1080, 480},
		{workday, 600, 720, 120}, {workday, 720, 900, 120}, {workday, 540, 840, 240},
		{custom, 510, 600, 90}, {custom, 960, 1050, 90}, {custom, 510, 1050, 480},
	} {
		if got, err := schedulecore.LeaveMinutes(c.day, c.start, c.end); err != nil || got != c.minutes {
			t.Fatalf("%d..%d: %d %v", c.start, c.end, got, err)
		}
	}
	for _, c := range []struct {
		day        schedulecore.DaySchedule
		start, end int
	}{{workday, 780, 840}, {workday, 570, 660}, {workday, 480, 600}, {workday, 1080, 1140}, {workday, 660, 540}, {workday, 660, 660}, {custom, 540, 1080}} {
		_, err := schedulecore.LeaveMinutes(c.day, c.start, c.end)
		rejectedAs(t, err, schedulecore.RejectInvalidSlot)
	}
	_, err := schedulecore.LeaveMinutes(off, 540, 660)
	rejectedAs(t, err, schedulecore.RejectNonWorkingDay)
	_, err = schedulecore.LeaveMinutes(schedulecore.DaySchedule{Kind: schedulecore.DayPaidHoliday, Frame: standard}, 540, 660)
	rejectedAs(t, err, schedulecore.RejectNonWorkingDay)
	_, err = schedulecore.LeaveMinutes(schedulecore.DaySchedule{Kind: schedulecore.DayMakeupWorkday, Frame: standard}, 540, 660)
	rejectedAs(t, err, schedulecore.RejectMakeupDay)
}

func TestLateAndEarlySegmentsKeepTheOldMinutes(t *testing.T) {
	for m := 0; m <= 1440; m++ {
		late, lateOK := schedulecore.LateSegment(standard, m)
		wantLate, wantLateOK := schedulecore.Shift{}, false
		switch {
		case m >= 541 && m <= 780:
			wantLate, wantLateOK = schedulecore.Shift{540, m}, true
		case m >= 841 && m <= 1079:
			wantLate, wantLateOK = schedulecore.Shift{840, m}, true
		}
		early, earlyOK := schedulecore.EarlySegment(standard, m)
		wantEarly, wantEarlyOK := schedulecore.Shift{}, false
		switch {
		case m >= 541 && m <= 779:
			wantEarly, wantEarlyOK = schedulecore.Shift{m, 780}, true
		case m >= 841 && m <= 1079:
			wantEarly, wantEarlyOK = schedulecore.Shift{m, 1080}, true
		}
		if late != wantLate || lateOK != wantLateOK || early != wantEarly || earlyOK != wantEarlyOK {
			t.Fatalf("%d: late %v %v early %v %v", m, late, lateOK, early, earlyOK)
		}
	}
	if _, ok := schedulecore.LateSegment(schedulecore.Frame{}, 600); ok {
		t.Fatal("late on no frame")
	}
	if _, ok := schedulecore.EarlySegment(schedulecore.Frame{}, 600); ok {
		t.Fatal("early on no frame")
	}
}

func TestWfhSpansTheFrameAndOverlapCountsShiftsOnly(t *testing.T) {
	if got, ok := schedulecore.WfhSegment(standard); !ok || got != (schedulecore.WfhSpan{Start: 540, End: 1080, Minutes: 480}) {
		t.Fatal(got)
	}
	if got, ok := schedulecore.WfhSegment(schedulecore.Frame{{480, 720}, {780, 960}, {1020, 1080}}); !ok || got != (schedulecore.WfhSpan{Start: 480, End: 1080, Minutes: 480}) {
		t.Fatal(got)
	}
	if _, ok := schedulecore.WfhSegment(schedulecore.Frame{}); ok {
		t.Fatal("wfh on no frame")
	}
	for _, c := range [][3]int{{0, 1440, 480}, {720, 900, 120}, {780, 840, 0}, {539, 541, 1}} {
		if got := schedulecore.OverlapMinutes(standard, c[0], c[1]); got != c[2] {
			t.Fatalf("%v: %d", c, got)
		}
	}
}

func TestAFrameIsBoundedOnTheGridWithGaps(t *testing.T) {
	for _, c := range []struct {
		frame schedulecore.Frame
		max   int
		valid bool
	}{
		{schedulecore.Frame{}, 480, true},
		{standard, 480, true},
		{standard, 479, false},
		{schedulecore.Frame{{0, 5}, {10, 15}, {1435, 1440}}, 480, true},
		{schedulecore.Frame{{0, 60}, {120, 180}, {240, 300}, {360, 420}}, 720, false},
		{schedulecore.Frame{{540, 783}}, 480, false},
		{schedulecore.Frame{{541, 780}}, 480, false},
		{schedulecore.Frame{{780, 540}}, 480, false},
		{schedulecore.Frame{{540, 540}}, 480, false},
		{schedulecore.Frame{{-5, 60}}, 480, false},
		{schedulecore.Frame{{1400, 1445}}, 480, false},
		{schedulecore.Frame{{840, 1080}, {540, 780}}, 480, false},
		{schedulecore.Frame{{540, 780}, {780, 1020}}, 480, false},
		{schedulecore.Frame{{540, 800}, {780, 1000}}, 720, false},
	} {
		if got := schedulecore.IsValidFrame(c.frame, c.max); got != c.valid {
			t.Fatalf("%v / %d: %v", c.frame, c.max, got)
		}
	}
}

func TestAnEmployeeFrameChangesItsWeekdaysInsideItsRangeOnly(t *testing.T) {
	f := facts(own("2026-11-03", ptr("2026-11-04"), map[int]schedulecore.Frame{2: earlyFrame, 6: earlyFrame}))
	dayIs(t, "2026-11-02", f, workday)
	dayIs(t, "2026-11-03", f, schedulecore.DaySchedule{Kind: schedulecore.DayWorkday, Frame: earlyFrame})
	dayIs(t, "2026-11-04", f, workday)
	dayIs(t, "2026-11-10", f, workday)
	dayIs(t, "2026-11-07", facts(own("2026-11-01", nil, map[int]schedulecore.Frame{6: earlyFrame})), off)
	dayIs(t, "2030-01-01", facts(own("2026-11-01", nil, map[int]schedulecore.Frame{2: earlyFrame})), schedulecore.DaySchedule{Kind: schedulecore.DayWorkday, Frame: earlyFrame})
}

func TestTheCompanyVersionInForceIsTheLatestStartedOne(t *testing.T) {
	later := schedulecore.ScheduleVersion{EffectiveFrom: "2026-11-04", Days: week(schedulecore.Frame{{480, 960}}, schedulecore.Frame{{480, 720}})}
	f := facts(versions(seed, later))
	dayIs(t, "2026-11-03", f, workday)
	dayIs(t, "2026-11-04", f, schedulecore.DaySchedule{Kind: schedulecore.DayWorkday, Frame: schedulecore.Frame{{480, 960}}})
	dayIs(t, "2026-11-07", f, schedulecore.DaySchedule{Kind: schedulecore.DayWorkday, Frame: schedulecore.Frame{{480, 720}}})
	if _, err := schedulecore.FrameOn("2026-11-03", facts(versions(later))); !errors.Is(err, schedulecore.ErrNoScheduleVersion) {
		t.Fatal(err)
	}
	sundayOnly := schedulecore.ScheduleVersion{EffectiveFrom: "2026-11-04", Days: []schedulecore.Frame{{}, {}, {}, {}, {}, {}, standard}}
	g := facts(versions(seed, sundayOnly), own("2026-11-01", nil, map[int]schedulecore.Frame{2: earlyFrame}))
	dayIs(t, "2026-11-10", g, off)
	dayIs(t, "2026-11-08", g, workday)
	if frame, err := schedulecore.CompanyFrameOn("2026-11-07", 6, []schedulecore.ScheduleVersion{seed, later}); err != nil || !reflect.DeepEqual(frame, schedulecore.Frame{{480, 720}}) {
		t.Fatal(frame, err)
	}
}

func TestAPaidHolidayOnlyAffectsDaysTheCompanyWorks(t *testing.T) {
	f := facts(holidays("2026-11-03", "2026-11-07"), own("2026-11-01", nil, map[int]schedulecore.Frame{2: earlyFrame}))
	dayIs(t, "2026-11-03", f, schedulecore.DaySchedule{Kind: schedulecore.DayPaidHoliday, Frame: earlyFrame})
	dayIs(t, "2026-11-07", f, off)
	saturdays := schedulecore.ScheduleVersion{EffectiveFrom: "1900-01-01", Days: week(standard, schedulecore.Frame{{540, 780}})}
	dayIs(t, "2026-11-07", facts(versions(saturdays), holidays("2026-11-03", "2026-11-07")), schedulecore.DaySchedule{Kind: schedulecore.DayPaidHoliday, Frame: schedulecore.Frame{{540, 780}}})
}

func TestAMakeupDayTakesTheHoursOfItsWeekday(t *testing.T) {
	overrides := own("2026-11-01", nil, map[int]schedulecore.Frame{1: earlyFrame})
	dayIs(t, "2026-11-07", facts(overrides, makeup("2026-11-07", 1, schedulecore.FrameSourceCompany)), schedulecore.DaySchedule{Kind: schedulecore.DayMakeupWorkday, Frame: standard})
	dayIs(t, "2026-11-07", facts(overrides, makeup("2026-11-07", 1, schedulecore.FrameSourceEmployee)), schedulecore.DaySchedule{Kind: schedulecore.DayMakeupWorkday, Frame: earlyFrame})
	dayIs(t, "2026-11-07", facts(overrides, makeup("2026-11-07", 2, schedulecore.FrameSourceEmployee)), schedulecore.DaySchedule{Kind: schedulecore.DayMakeupWorkday, Frame: standard})
	dayIs(t, "2026-11-07", facts(makeup("2026-11-07", 7, schedulecore.FrameSourceEmployee)), off)
	// The company is off on Sunday, so the employee's own Sunday frame never turns the makeup day on.
	dayIs(t, "2026-11-07", facts(own("2026-11-01", nil, map[int]schedulecore.Frame{7: earlyFrame}), makeup("2026-11-07", 7, schedulecore.FrameSourceEmployee)), off)
}

func TestInvalidDatesAreRefusedBeforeAnyScheduleLookup(t *testing.T) {
	for _, date := range []string{"2026-02-30", "2026-11-2"} {
		_, err := schedulecore.FrameOn(date, facts(versions()))
		rejectedAs(t, err, schedulecore.RejectInvalidDate)
	}
}

func TestStoredShiftsRoundTripThroughWeekFrames(t *testing.T) {
	days := week(standard, schedulecore.Frame{{540, 780}})
	if got := schedulecore.WeekFrames(schedulecore.StoredShifts(days)); !reflect.DeepEqual(got, days) {
		t.Fatal(got)
	}
	if got := schedulecore.WeekFrames(nil); len(got) != 7 || got[0] == nil {
		t.Fatal(got)
	}
	if _, err := schedulecore.DecodeStored[schedulecore.StoredSchedule]([]byte(`{"frames":[],"holidays":[],"makeupDays":[],"extra":1}`)); !errors.Is(err, schedulecore.ErrStoredSchedule) {
		t.Fatal(err)
	}
}
