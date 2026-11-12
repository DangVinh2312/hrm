package report

import (
	"errors"
	"testing"
)

func TestSeniorityCountsTheHireDayAndTheCutoffDay(t *testing.T) {
	for _, c := range []struct {
		hiredOn, asOn string
		want          Seniority
	}{
		{"2025-01-01", "2026-12-31", Seniority{Years: 2, TotalDays: 730}},
		{"2025-01-01", "2025-01-01", Seniority{Days: 1, TotalDays: 1}},
		{"2025-01-15", "2026-03-14", Seniority{Years: 1, Months: 2, TotalDays: 424}},
		{"2025-01-15", "2026-03-20", Seniority{Years: 1, Months: 2, Days: 6, TotalDays: 430}},
		{"2024-01-31", "2024-03-01", Seniority{Months: 1, Days: 2, TotalDays: 31}},
		{"2024-02-29", "2025-02-28", Seniority{Years: 1, Days: 1, TotalDays: 366}},
		{"2024-02-29", "2028-02-29", Seniority{Years: 4, Days: 1, TotalDays: 1462}},
		{"2024-01-31", "2024-02-28", Seniority{Months: 1, TotalDays: 29}},
		{"2024-01-31", "2024-02-29", Seniority{Months: 1, Days: 1, TotalDays: 30}},
		{"2025-01-31", "2025-02-27", Seniority{Months: 1, TotalDays: 28}},
		{"2025-12-31", "2026-01-30", Seniority{Months: 1, TotalDays: 31}},
		{"1900-02-28", "1900-03-01", Seniority{Days: 2, TotalDays: 2}},
		{"1900-01-01", "2100-12-31", Seniority{Years: 201, TotalDays: 73414}},
	} {
		got, err := seniorityOf(c.hiredOn, c.asOn)
		if err != nil || got != c.want {
			t.Errorf("%s to %s: %+v, %v, want %+v", c.hiredOn, c.asOn, got, err, c.want)
		}
	}
}

func TestSeniorityIsRefusedBeforeTheHireDateOrOnABadDate(t *testing.T) {
	if _, err := seniorityOf("2026-01-02", "2026-01-01"); !errors.Is(err, errNotEmployed) {
		t.Errorf("cutoff before the hire date: %v", err)
	}
	for _, pair := range [][2]string{{"2026-02-30", "2026-03-01"}, {"2026-01-01", "2026-13-01"}, {"", "2026-01-01"}, {"2026-01-01", "2026-01-01T00:00"}} {
		if _, err := seniorityOf(pair[0], pair[1]); err == nil {
			t.Errorf("%q to %q accepted", pair[0], pair[1])
		}
	}
}
