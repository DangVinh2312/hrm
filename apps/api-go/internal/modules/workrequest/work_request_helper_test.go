package workrequest

import (
	"errors"
	"reflect"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/schedulecore"
)

// Fixture week: 2026-11-02 Mon ... 2026-11-06 Fri, 2026-11-07 Sat, 2026-11-08 Sun.
var standard = schedulecore.Frame{{540, 780}, {840, 1080}}

func schedule() schedulecore.ScheduleFacts {
	return schedulecore.ScheduleFacts{
		Versions: []schedulecore.ScheduleVersion{{
			EffectiveFrom: "1900-01-01",
			Days:          []schedulecore.Frame{standard, standard, standard, standard, standard, {}, {}},
		}},
		PaidHolidays: map[string]bool{},
		MakeupDays:   map[string]schedulecore.MakeupDay{},
	}
}

type employment struct{ from, probationUntil string }

func factsWith(s schedulecore.ScheduleFacts, e employment) submitFacts {
	return submitFacts{
		Earliest: "2026-11-03",
		Latest:   "2027-02-08",
		Schedule: s,
		StatusOn: func(date string) string {
			switch {
			case date < e.from:
				return ""
			case date < e.probationUntil:
				return statusProbation
			default:
				return statusOfficial
			}
		},
	}
}

func facts() submitFacts { return factsWith(schedule(), employment{"2000-01-01", "2000-01-01"}) }

func leaveOf(kind hrbase.RequestKind, date string, start, end int) SubmitInput {
	return SubmitInput{Kind: kind, Reason: "x", Segments: []Slot{{date, start, end}}}
}

func lateOf(kind hrbase.RequestKind, date string, expected int) SubmitInput {
	return SubmitInput{Kind: kind, Reason: "x", Date: date, ExpectedMinute: expected}
}

func wfhOf(dates ...string) SubmitInput {
	return SubmitInput{Kind: hrbase.RequestWfh, Reason: "x", Dates: dates}
}

func mustSegments(t *testing.T, input SubmitInput, f submitFacts) []Segment {
	t.Helper()
	got, err := requestSegments(input, f)
	if err != nil {
		t.Fatalf("%+v: %v", input, err)
	}
	return got
}

func refused(t *testing.T, input SubmitInput, f submitFacts, reason rejection) {
	t.Helper()
	got, err := requestSegments(input, f)
	if r, ok := errors.AsType[rejected](err); !ok || r.reason != reason || got != nil {
		t.Errorf("%+v: %+v, %v, want %s", input, got, err, reason)
	}
}

func TestLeaveSlotsKeepTheirMinutesAndEdgesAreShiftEdgesOrWholeHours(t *testing.T) {
	for _, slot := range [][3]int{{540, 660, 120}, {660, 780, 120}, {840, 960, 120}, {960, 1080, 120}, {540, 780, 240}, {840, 1080, 240}, {540, 1080, 480}, {600, 720, 120}, {720, 840, 60}, {540, 600, 60}} {
		for _, kind := range []hrbase.RequestKind{hrbase.RequestAnnualLeave, hrbase.RequestUnpaidLeave} {
			got := mustSegments(t, leaveOf(kind, "2026-11-03", slot[0], slot[1]), facts())
			if want := []Segment{{"2026-11-03", slot[0], slot[1], slot[2]}}; !reflect.DeepEqual(got, want) {
				t.Errorf("%v: %+v", slot, got)
			}
		}
	}
	for _, slot := range [][2]int{{780, 840}, {570, 660}, {480, 600}, {660, 540}} {
		refused(t, leaveOf(hrbase.RequestAnnualLeave, "2026-11-03", slot[0], slot[1]), facts(), rejectInvalidSlot)
	}
}

func TestTheCalendarRefusesDaysOffAndAMakeupDayTakesNoLeave(t *testing.T) {
	s := schedule()
	s.PaidHolidays["2026-11-04"] = true
	s.MakeupDays["2026-11-07"] = schedulecore.MakeupDay{AsWeekday: 1, FrameSource: schedulecore.FrameSourceCompany}
	holiday := factsWith(s, employment{"2000-01-01", "2000-01-01"})
	for _, input := range []SubmitInput{
		leaveOf(hrbase.RequestUnpaidLeave, "2026-11-08", 540, 660),
		lateOf(hrbase.RequestLateArrival, "2026-11-08", 600),
		wfhOf("2026-11-08"),
		leaveOf(hrbase.RequestAnnualLeave, "2026-11-04", 540, 660),
		lateOf(hrbase.RequestEarlyDeparture, "2026-11-04", 1000),
		wfhOf("2026-11-03", "2026-11-04"),
	} {
		refused(t, input, holiday, rejectNonWorkingDay)
	}
	refused(t, leaveOf(hrbase.RequestAnnualLeave, "2026-11-07", 540, 1080), holiday, rejectMakeupDay)
	if got := mustSegments(t, lateOf(hrbase.RequestLateArrival, "2026-11-07", 600), holiday); len(got) != 1 {
		t.Errorf("late on a makeup day: %+v", got)
	}
	if got := mustSegments(t, wfhOf("2026-11-07"), holiday); !reflect.DeepEqual(got, []Segment{{"2026-11-07", 540, 1080, 480}}) {
		t.Errorf("wfh on a makeup day: %+v", got)
	}
}

func TestLateAndEarlyCountFromTheEdgeOfTheirShift(t *testing.T) {
	at := func(kind hrbase.RequestKind, minute int) Segment {
		return mustSegments(t, lateOf(kind, "2026-11-03", minute), facts())[0]
	}
	for _, tc := range []struct {
		kind   hrbase.RequestKind
		minute int
		want   Segment
	}{
		{hrbase.RequestLateArrival, 600, Segment{"2026-11-03", 540, 600, 60}},
		{hrbase.RequestLateArrival, 541, Segment{"2026-11-03", 540, 541, 1}},
		{hrbase.RequestLateArrival, 780, Segment{"2026-11-03", 540, 780, 240}},
		{hrbase.RequestLateArrival, 900, Segment{"2026-11-03", 840, 900, 60}},
		{hrbase.RequestLateArrival, 1079, Segment{"2026-11-03", 840, 1079, 239}},
		{hrbase.RequestEarlyDeparture, 1020, Segment{"2026-11-03", 1020, 1080, 60}},
		{hrbase.RequestEarlyDeparture, 600, Segment{"2026-11-03", 600, 780, 180}},
		{hrbase.RequestEarlyDeparture, 841, Segment{"2026-11-03", 841, 1080, 239}},
	} {
		if got := at(tc.kind, tc.minute); got != tc.want {
			t.Errorf("%s %d: %+v", tc.kind, tc.minute, got)
		}
	}
	for _, minute := range []int{0, 540, 781, 800, 840, 1080, 1440} {
		refused(t, lateOf(hrbase.RequestLateArrival, "2026-11-03", minute), facts(), rejectInvalidTime)
	}
	for _, minute := range []int{540, 780, 800, 840, 1080} {
		refused(t, lateOf(hrbase.RequestEarlyDeparture, "2026-11-03", minute), facts(), rejectInvalidTime)
	}
}

func TestARequestNeverCrossesAYearAndStaysInTheWindow(t *testing.T) {
	refused(t, SubmitInput{Kind: hrbase.RequestUnpaidLeave, Reason: "x", Segments: []Slot{{"2026-12-31", 540, 1080}, {"2027-01-04", 540, 1080}}}, facts(), rejectCrossesYear)
	refused(t, wfhOf("2026-12-31", "2027-01-04"), facts(), rejectCrossesYear)
	if got := mustSegments(t, wfhOf("2026-11-30", "2026-12-01"), facts()); len(got) != 2 {
		t.Errorf("across months: %+v", got)
	}
	for _, date := range []string{"2026-11-03", "2027-02-08"} {
		mustSegments(t, lateOf(hrbase.RequestLateArrival, date, 600), facts())
	}
	for _, date := range []string{"2026-11-02", "2027-02-09"} {
		refused(t, lateOf(hrbase.RequestLateArrival, date, 600), facts(), rejectDateOutOfRange)
	}
}

func TestProbationIsCheckedOnEveryDay(t *testing.T) {
	probation := factsWith(schedule(), employment{"2000-01-01", "2026-11-16"})
	for _, input := range []SubmitInput{
		leaveOf(hrbase.RequestAnnualLeave, "2026-11-10", 540, 1080),
		wfhOf("2026-11-10"),
		wfhOf("2026-11-13", "2026-11-16"),
	} {
		refused(t, input, probation, rejectProbation)
	}
	for _, input := range []SubmitInput{
		lateOf(hrbase.RequestLateArrival, "2026-11-10", 600),
		lateOf(hrbase.RequestEarlyDeparture, "2026-11-10", 1020),
		leaveOf(hrbase.RequestUnpaidLeave, "2026-11-10", 540, 1080),
		leaveOf(hrbase.RequestAnnualLeave, "2026-11-16", 540, 1080),
		wfhOf("2026-11-16", "2026-11-17"),
	} {
		mustSegments(t, input, probation)
	}
	refused(t, lateOf(hrbase.RequestLateArrival, "2026-11-10", 600), factsWith(schedule(), employment{"2026-11-11", "2000-01-01"}), rejectNotEmployed)
}

func TestAnEmployeeFrameMovesEveryKindToItsOwnHours(t *testing.T) {
	s := schedule()
	s.Overrides = []schedulecore.EmployeeFrames{{ValidFrom: "2026-11-01", Days: map[int]schedulecore.Frame{2: {{510, 780}, {840, 1050}}}}}
	custom := factsWith(s, employment{"2000-01-01", "2000-01-01"})
	if got := mustSegments(t, wfhOf("2026-11-03"), custom); !reflect.DeepEqual(got, []Segment{{"2026-11-03", 510, 1050, 480}}) {
		t.Errorf("wfh: %+v", got)
	}
	if got := mustSegments(t, leaveOf(hrbase.RequestAnnualLeave, "2026-11-03", 510, 600), custom); got[0].Minutes != 90 {
		t.Errorf("leave: %+v", got)
	}
	refused(t, leaveOf(hrbase.RequestAnnualLeave, "2026-11-03", 540, 1080), custom, rejectInvalidSlot)
	if got := mustSegments(t, lateOf(hrbase.RequestLateArrival, "2026-11-03", 530), custom); got[0] != (Segment{"2026-11-03", 510, 530, 20}) {
		t.Errorf("late: %+v", got)
	}
	refused(t, lateOf(hrbase.RequestEarlyDeparture, "2026-11-03", 1060), custom, rejectInvalidTime)
	if got := mustSegments(t, wfhOf("2026-11-04"), custom); !reflect.DeepEqual(got, []Segment{{"2026-11-04", 540, 1080, 480}}) {
		t.Errorf("company day: %+v", got)
	}
}

func TestAScheduleWithoutAVersionIsAFaultNotADayOff(t *testing.T) {
	s := schedule()
	s.Versions[0].EffectiveFrom = "2027-01-01"
	_, err := requestSegments(wfhOf("2026-11-03"), factsWith(s, employment{"2000-01-01", "2000-01-01"}))
	if !errors.Is(err, schedulecore.ErrNoScheduleVersion) {
		t.Fatalf("got %v", err)
	}
}

func TestOverlapAllowsOnlyLateOrEarlyOnAWfhDayAndOnePerKindPerDay(t *testing.T) {
	booked := func(kind hrbase.RequestKind, date string, start, end int) []bookedSegment {
		return []bookedSegment{{Kind: kind, Date: date, StartMinute: start, EndMinute: end}}
	}
	check := func(input SubmitInput, b []bookedSegment, want bool) {
		t.Helper()
		if got := conflicts(input.Kind, mustSegments(t, input, facts()), b); got != want {
			t.Errorf("%+v against %+v: %v", input, b, got)
		}
	}
	morning := booked(hrbase.RequestAnnualLeave, "2026-11-03", 540, 780)
	check(leaveOf(hrbase.RequestUnpaidLeave, "2026-11-03", 660, 780), morning, true)
	check(leaveOf(hrbase.RequestUnpaidLeave, "2026-11-03", 840, 960), morning, false)
	check(leaveOf(hrbase.RequestUnpaidLeave, "2026-11-04", 540, 780), morning, false)
	check(lateOf(hrbase.RequestLateArrival, "2026-11-03", 600), morning, true)
	check(lateOf(hrbase.RequestLateArrival, "2026-11-03", 870), morning, false)
	home := booked(hrbase.RequestWfh, "2026-11-12", 540, 1080)
	check(lateOf(hrbase.RequestLateArrival, "2026-11-12", 600), home, false)
	check(lateOf(hrbase.RequestEarlyDeparture, "2026-11-12", 1020), home, false)
	check(leaveOf(hrbase.RequestAnnualLeave, "2026-11-12", 540, 780), home, true)
	check(wfhOf("2026-11-11", "2026-11-12"), home, true)
	check(wfhOf("2026-11-12"), booked(hrbase.RequestLateArrival, "2026-11-12", 540, 600), false)
	lateMorning := booked(hrbase.RequestLateArrival, "2026-11-13", 540, 600)
	check(lateOf(hrbase.RequestLateArrival, "2026-11-13", 900), lateMorning, true)
	check(lateOf(hrbase.RequestEarlyDeparture, "2026-11-13", 1020), lateMorning, false)
	check(lateOf(hrbase.RequestLateArrival, "2026-11-13", 900), nil, false)
}

func TestTheInitialStateFollowsCooThenLeadThenEveryoneElse(t *testing.T) {
	for _, leads := range []bool{true, false} {
		if got := initialState(true, leads); got != (start{stateApproved, systemCooSelfApproved}) {
			t.Errorf("coo, leads %v: %+v", leads, got)
		}
	}
	if got := initialState(false, true); got != (start{statePendingFinal, systemLeadSkipped}) {
		t.Errorf("lead: %+v", got)
	}
	if got := initialState(false, false); got != (start{statePendingLead, ""}) {
		t.Errorf("member: %+v", got)
	}
}

func TestOnlyRulesOverFactsTheSubmitterKnowsHaveTheirOwnKey(t *testing.T) {
	for reason, code := range map[rejection]apperror.Code{
		rejectCrossesYear:    "error.crossesYear",
		rejectDateOutOfRange: "error.dateOutOfRange",
		rejectProbation:      "error.kindNotAllowedInProbation",
		rejectNonWorkingDay:  "error.nonWorkingDay",
		rejectMakeupDay:      "error.makeupDay",
	} {
		if got, ok := errors.AsType[apperror.Rejection](ruleError(reason)); !ok || got.Code != code {
			t.Errorf("%s: %v", reason, got)
		}
	}
	for _, reason := range []rejection{rejectNotEmployed, rejectInvalidTime, rejectInvalidSlot} {
		if got := ruleError(reason); !errors.Is(got, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", reason, got)
		}
	}
}
