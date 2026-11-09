package schedulecore_test

import (
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"hrm/api-go/internal/modules/schedulecore"
)

func rejectedAs(t *testing.T, err error, reason schedulecore.WorkingTimeRejection) {
	t.Helper()
	var rejected schedulecore.WorkingTimeRejected
	if !errors.As(err, &rejected) || rejected.Reason != reason {
		t.Fatalf("want %s, got %v", reason, err)
	}
}

func TestIsoWeekdayMondayOneToSundaySeven(t *testing.T) {
	for date, want := range map[string]int{"2026-11-02": 1, "2026-11-06": 5, "2026-11-07": 6, "2026-11-08": 7, "2028-02-29": 2} {
		if got, err := schedulecore.IsoWeekday(date); err != nil || got != want {
			t.Fatalf("%s: %d %v", date, got, err)
		}
	}
}

func TestInvalidDatesAreRejectedNeverCorrected(t *testing.T) {
	arabic := string([]rune{0x0661, 0x0662, 0x0663, 0x0664}) + "-11-02"
	for _, date := range []string{"2026-02-30", "2026-13-01", "2026-1-2", "2026-00-10", "2026-11-31", "2026-11-02T00:00",
		" 2026-11-02", arabic, "1899-12-31", "2101-01-01", "2027-02-29", "", "2026-11-02\n"} {
		_, err := schedulecore.IsoWeekday(date)
		rejectedAs(t, err, schedulecore.RejectInvalidDate)
	}
}

func TestDatesBetweenListsEveryDayAtMostTheBoundNeverReversed(t *testing.T) {
	if got := schedulecore.DatesBetween("2026-11-06", "2026-11-09", 31); !slices.Equal(got, []string{"2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"}) {
		t.Fatal(got)
	}
	if got := schedulecore.DatesBetween("2026-12-31", "2027-01-01", 31); !slices.Equal(got, []string{"2026-12-31", "2027-01-01"}) {
		t.Fatal(got)
	}
	if got := schedulecore.DatesBetween("2026-01-01", "2026-01-31", 31); len(got) != 31 {
		t.Fatal(len(got))
	}
	for _, r := range [][2]string{{"2026-01-01", "2026-02-01"}, {"2026-11-09", "2026-11-08"}, {"2026-02-30", "2026-03-01"}} {
		if got := schedulecore.DatesBetween(r[0], r[1], 31); got == nil || len(got) != 0 {
			t.Fatalf("%v: %v", r, got)
		}
	}
	if got := schedulecore.DatesBetween("2026-01-01", "2026-04-02", 92); len(got) != 92 {
		t.Fatal(len(got))
	}
}

func TestResultsDoNotDependOnTheHostTimezone(t *testing.T) {
	original := time.Local
	t.Cleanup(func() { time.Local = original })
	facts := schedulecore.ScheduleFacts{
		Versions:     []schedulecore.ScheduleVersion{{EffectiveFrom: "1900-01-01", Days: week(standard, schedulecore.Frame{})}},
		PaidHolidays: map[string]bool{"2026-11-02": true},
		MakeupDays:   map[string]schedulecore.MakeupDay{"2026-11-08": {AsWeekday: 1, FrameSource: schedulecore.FrameSourceCompany}},
	}
	var outputs []string
	for _, zone := range []string{"UTC", "Asia/Ho_Chi_Minh", "Pacific/Kiritimati", "America/Los_Angeles"} {
		location, err := time.LoadLocation(zone)
		if err != nil {
			t.Fatal(err)
		}
		time.Local = location
		out := ""
		for _, date := range []string{"2026-11-01", "2026-11-02", "2026-11-07", "2026-11-08", "2026-12-31", "2027-01-01"} {
			weekday, err := schedulecore.IsoWeekday(date)
			if err != nil {
				t.Fatal(err)
			}
			day, err := schedulecore.FrameOn(date, facts)
			if err != nil {
				t.Fatal(err)
			}
			out += fmt.Sprintf("[%d %s %d]", weekday, day.Kind, schedulecore.FrameMinutes(day.Frame))
		}
		outputs = append(outputs, out+fmt.Sprint(schedulecore.DatesBetween("2026-03-28", "2026-03-30", 31)))
	}
	want := "[7 off 0][1 paid_holiday 480][6 off 0][7 makeup_workday 480][4 workday 480][5 workday 480][2026-03-28 2026-03-29 2026-03-30]"
	for _, out := range outputs {
		if out != want {
			t.Fatalf("got %s", out)
		}
	}
}
