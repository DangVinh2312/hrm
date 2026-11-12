package workcalendar

import (
	"encoding/json/v2"
	"errors"
	"reflect"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
)

func decodeBody[T any](t *testing.T, raw string) (T, error) {
	t.Helper()
	var body T
	err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true))
	return body, err
}

func TestParseYearIsFourAsciiDigitsBetween1900And2100(t *testing.T) {
	for query, want := range map[string]int{"year=2026": 2026, "year=1900": 1900, "year=2100": 2100} {
		if got, err := parseYear(query); err != nil || got != want {
			t.Errorf("%q: %d, %v", query, got, err)
		}
	}
	for _, query := range []string{
		"", "year=", "year=1899", "year=2101", "year=26", "year=02026", "year=%2B2026", "year=2026.0",
		"year=" + "%D9%A2%D9%A0%D9%A2%D9%A6", "year=2026&year=2027", "year=2026&limit=1", "Year=2026",
	} {
		if _, err := parseYear(query); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("accepted %q: %v", query, err)
		}
	}
}

func TestParseDayIsAHolidayOrAMakeupNeverBoth(t *testing.T) {
	holiday := "Ngay le gia"
	accepted := []struct {
		date, body string
		want       DayInput
	}{
		{"2026-09-01", `{"expectedVersion":"3","holiday":"  Ngay le gia "}`, DayInput{ExpectedVersion: "3", Date: "2026-09-01", Holiday: &holiday}},
		{"2026-09-01", `{"expectedVersion":"3","holiday":null}`, DayInput{ExpectedVersion: "3", Date: "2026-09-01"}},
		{"2026-06-06", `{"expectedVersion":"3","makeup":{"asWeekday":1,"frameSource":"company"}}`, DayInput{ExpectedVersion: "3", Date: "2026-06-06", IsMakeup: true, Makeup: &MakeupHours{AsWeekday: 1, FrameSource: "company"}}},
		{"2026-06-07", `{"makeup":{"frameSource":"employee","asWeekday":7},"expectedVersion":"3"}`, DayInput{ExpectedVersion: "3", Date: "2026-06-07", IsMakeup: true, Makeup: &MakeupHours{AsWeekday: 7, FrameSource: "employee"}}},
		{"2026-06-06", `{"expectedVersion":"3","makeup":null}`, DayInput{ExpectedVersion: "3", Date: "2026-06-06", IsMakeup: true}},
	}
	for _, tc := range accepted {
		body, err := decodeBody[dayBody](t, tc.body)
		if err != nil {
			t.Fatalf("%s: %v", tc.body, err)
		}
		got, err := parseDay(tc.date, body)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %+v, %v", tc.body, got, err)
		}
	}
	refused := map[string]string{
		"both members":            `{"expectedVersion":"3","holiday":"x","makeup":null}`,
		"neither member":          `{"expectedVersion":"3"}`,
		"no version":              `{"holiday":"x"}`,
		"version zero":            `{"expectedVersion":"0","holiday":"x"}`,
		"version number":          `{"expectedVersion":3,"holiday":"x"}`,
		"blank holiday":           `{"expectedVersion":"3","holiday":"   "}`,
		"long holiday":            `{"expectedVersion":"3","holiday":"` + strings.Repeat("a", 201) + `"}`,
		"control in holiday":      `{"expectedVersion":"3","holiday":"a\u0000b"}`,
		"holiday number":          `{"expectedVersion":"3","holiday":5}`,
		"weekday zero":            `{"expectedVersion":"3","makeup":{"asWeekday":0,"frameSource":"company"}}`,
		"weekday eight":           `{"expectedVersion":"3","makeup":{"asWeekday":8,"frameSource":"company"}}`,
		"weekday fraction":        `{"expectedVersion":"3","makeup":{"asWeekday":1.5,"frameSource":"company"}}`,
		"weekday text":            `{"expectedVersion":"3","makeup":{"asWeekday":"1","frameSource":"company"}}`,
		"weekday null":            `{"expectedVersion":"3","makeup":{"asWeekday":null,"frameSource":"company"}}`,
		"weekday missing":         `{"expectedVersion":"3","makeup":{"frameSource":"company"}}`,
		"frame source unknown":    `{"expectedVersion":"3","makeup":{"asWeekday":1,"frameSource":"team"}}`,
		"frame source missing":    `{"expectedVersion":"3","makeup":{"asWeekday":1}}`,
		"frame source case":       `{"expectedVersion":"3","makeup":{"asWeekday":1,"frameSource":"Company"}}`,
		"makeup extra member":     `{"expectedVersion":"3","makeup":{"asWeekday":1,"frameSource":"company","x":1}}`,
		"makeup not an object":    `{"expectedVersion":"3","makeup":1}`,
		"makeup repeated member":  `{"expectedVersion":"3","makeup":{"asWeekday":1,"asWeekday":2,"frameSource":"company"}}`,
		"repeated holiday member": `{"expectedVersion":"3","holiday":"a","holiday":"b"}`,
	}
	for name, raw := range refused {
		body, err := decodeBody[dayBody](t, raw)
		if err == nil {
			_, err = parseDay("2026-09-01", body)
		}
		if err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	body, err := decodeBody[dayBody](t, `{"expectedVersion":"3","holiday":"x"}`)
	if err != nil {
		t.Fatal(err)
	}
	for _, date := range []string{"2026-02-30", "2026-9-01", "1899-12-31", "2101-01-01", "", "2026-09-01x"} {
		if _, err := parseDay(date, body); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("date %q accepted: %v", date, err)
		}
	}
}

func TestParseHolidaysIsAnOrderedRangeOfAtMost31Days(t *testing.T) {
	parse := func(raw string) (HolidaysInput, error) {
		body, err := decodeBody[holidaysBody](t, raw)
		if err != nil {
			return HolidaysInput{}, err
		}
		return parseHolidays(body)
	}
	got, err := parse(`{"expectedVersion":"7","from":"2028-12-28","to":"2029-01-02","name":" Nghi le "}`)
	if err != nil || got != (HolidaysInput{ExpectedVersion: "7", From: "2028-12-28", To: "2029-01-02", Name: "Nghi le"}) {
		t.Fatalf("crossing the year: %+v, %v", got, err)
	}
	for _, raw := range []string{
		`{"expectedVersion":"7","from":"2026-01-01","to":"2026-01-31","name":"x"}`,
		`{"expectedVersion":"7","from":"2026-01-01","to":"2026-01-01","name":"x"}`,
	} {
		if _, err := parse(raw); err != nil {
			t.Errorf("%s: %v", raw, err)
		}
	}
	for _, raw := range []string{
		`{"expectedVersion":"7","from":"2026-01-01","to":"2026-02-01","name":"x"}`,
		`{"expectedVersion":"7","from":"2026-01-02","to":"2026-01-01","name":"x"}`,
		`{"expectedVersion":"7","from":"2026-02-30","to":"2026-03-01","name":"x"}`,
		`{"expectedVersion":"7","from":"2026-01-01","to":"2026-01-02","name":""}`,
		`{"expectedVersion":"7","from":"2026-01-01","to":"2026-01-02"}`,
		`{"from":"2026-01-01","to":"2026-01-02","name":"x"}`,
		`{"expectedVersion":"7","from":"2026-01-01","to":"2026-01-02","name":null}`,
		`{"expectedVersion":"7","from":"2026-01-01","to":"2026-01-02","name":"x","extra":1}`,
	} {
		if _, err := parse(raw); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
