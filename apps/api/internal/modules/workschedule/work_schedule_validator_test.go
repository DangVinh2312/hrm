package workschedule

import (
	"encoding/json/v2"
	"errors"
	"reflect"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/schedulecore"
)

const (
	testEmployee = "00000000-0000-4000-8000-000000000001"
	standardDay  = `[[540,780],[840,1080]]`
)

var standardWeek = `[` + strings.Repeat(standardDay+`,`, 5) + `[],[]]`

func standardFrames() []schedulecore.Frame {
	week := make([]schedulecore.Frame, 7)
	for i := range week {
		week[i] = schedulecore.Frame{}
		if i < 5 {
			week[i] = schedulecore.Frame{{540, 780}, {840, 1080}}
		}
	}
	return week
}

func decodeBody[T any](raw string) (T, error) {
	var body T
	err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true))
	return body, err
}

func TestAWeekIsSevenListsOfAtMostThreeIntegerMinutePairs(t *testing.T) {
	body, err := decodeBody[companyScheduleBody](`{"days":` + standardWeek + `}`)
	if err != nil {
		t.Fatal(err)
	}
	days, err := parseWeek(body.Days)
	if err != nil || !reflect.DeepEqual(days, standardFrames()) {
		t.Fatalf("%v, %v", days, err)
	}
	rest := strings.Repeat(`,[]`, 6)
	for name, week := range map[string]string{
		"missing":       ``,
		"null":          `null`,
		"object":        `{}`,
		"six days":      `[` + strings.Repeat(`[],`, 5) + `[]]`,
		"eight days":    `[` + strings.Repeat(`[],`, 7) + `[]]`,
		"four shifts":   `[[[540,780],[800,900],[910,1000],[1010,1080]]` + rest + `]`,
		"one minute":    `[[[540]]` + rest + `]`,
		"three minutes": `[[[540,780,900]]` + rest + `]`,
		"negative":      `[[[-5,780]]` + rest + `]`,
		"over the day":  `[[[540,1445]]` + rest + `]`,
		"fraction":      `[[[540.5,780]]` + rest + `]`,
		"integral frac": `[[[540.0,780]]` + rest + `]`,
		"exponent":      `[[[5.4e2,780]]` + rest + `]`,
		"text minute":   `[[["540",780]]` + rest + `]`,
		"object shift":  `[[{"start":540,"end":780}]` + rest + `]`,
		"null frame":    `[null` + rest + `]`,
		"null shift":    `[[null]` + rest + `]`,
		"null minute":   `[[[null,780]]` + rest + `]`,
	} {
		raw := `{"days":` + week + `}`
		if week == "" {
			raw = `{}`
		}
		body, err := decodeBody[companyScheduleBody](raw)
		if err == nil {
			_, err = parseWeek(body.Days)
		}
		if err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestScheduleBodiesAreAllowlistedAndAFrameEndsOnOrAfterItStarts(t *testing.T) {
	company := func(date, raw string) (CompanyScheduleInput, error) {
		body, err := decodeBody[companyScheduleBody](raw)
		if err != nil {
			return CompanyScheduleInput{}, err
		}
		return parseCompanySchedule(date, body)
	}
	got, err := company("2026-12-01", `{"days":`+standardWeek+`}`)
	if err != nil || !reflect.DeepEqual(got, CompanyScheduleInput{EffectiveFrom: "2026-12-01", Days: standardFrames()}) {
		t.Fatalf("%+v, %v", got, err)
	}
	if _, err := company("2026-02-30", `{"days":`+standardWeek+`}`); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("invalid date: %v", err)
	}
	if _, err := company("2026-12-01", `{"days":`+standardWeek+`,"effectiveFrom":"2026-12-02"}`); err == nil {
		t.Error("extra member accepted")
	}

	frame := func(id, raw string) (EmployeeFrameInput, error) {
		body, err := decodeBody[employeeFrameBody](raw)
		if err != nil {
			return EmployeeFrameInput{}, err
		}
		return parseEmployeeFrame(id, body)
	}
	to := "2026-12-01"
	got2, err := frame(testEmployee, `{"validFrom":"2026-12-01","validTo":"2026-12-01","days":`+standardWeek+`}`)
	if err != nil || !reflect.DeepEqual(got2, EmployeeFrameInput{EmployeeID: testEmployee, ValidFrom: "2026-12-01", ValidTo: &to, Days: standardFrames()}) {
		t.Fatalf("%+v, %v", got2, err)
	}
	if got, err := frame(testEmployee, `{"validFrom":"2026-12-01","validTo":null,"days":`+standardWeek+`}`); err != nil || got.ValidTo != nil {
		t.Fatalf("open end: %+v, %v", got, err)
	}
	for name, c := range map[string]struct{ id, raw string }{
		"ends before it starts": {testEmployee, `{"validFrom":"2026-12-02","validTo":"2026-12-01","days":` + standardWeek + `}`},
		"not a uuid":            {"not-a-uuid", `{"validFrom":"2026-12-01","validTo":null,"days":` + standardWeek + `}`},
		"extra member":          {testEmployee, `{"validFrom":"2026-12-01","validTo":null,"days":` + standardWeek + `,"id":"x"}`},
		"validTo missing":       {testEmployee, `{"validFrom":"2026-12-01","days":` + standardWeek + `}`},
		"validTo invalid":       {testEmployee, `{"validFrom":"2026-12-01","validTo":"2026-12-32","days":` + standardWeek + `}`},
		"validFrom null":        {testEmployee, `{"validFrom":null,"validTo":null,"days":` + standardWeek + `}`},
		"days missing":          {testEmployee, `{"validFrom":"2026-12-01","validTo":null}`},
	} {
		if _, err := frame(c.id, c.raw); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if key, err := parseFrameKey(testEmployee, testEmployee); err != nil || key != (FrameKey{EmployeeID: testEmployee, FrameID: testEmployee}) {
		t.Errorf("frame key: %+v, %v", key, err)
	}
	if _, err := parseFrameKey(testEmployee, "x"); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("bad frame id: %v", err)
	}
}

func TestAScheduleRangeIsFromToInclusiveAndAtMost92Days(t *testing.T) {
	if maxScheduleRangeDays != 92 {
		t.Fatal(maxScheduleRangeDays)
	}
	got, err := parseScheduleQuery(testEmployee, "from=2026-11-01&to=2026-11-01")
	if err != nil || got != (ScheduleQuery{EmployeeID: testEmployee, From: "2026-11-01", To: "2026-11-01"}) {
		t.Fatalf("%+v, %v", got, err)
	}
	if _, err := parseScheduleQuery(testEmployee, "from=2026-11-01&to=2027-01-31"); err != nil {
		t.Errorf("92 days: %v", err)
	}
	for _, query := range []string{
		"from=2026-11-01&to=2027-02-01", "from=2026-11-02&to=2026-11-01", "from=2026-11-01",
		"from=2026-11-01&to=2026-11-01&limit=1", "from=2026-11-01&from=2026-11-01&to=2026-11-02", "from=2026-02-30&to=2026-03-01",
	} {
		if _, err := parseScheduleQuery(testEmployee, query); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("accepted %q: %v", query, err)
		}
	}
	if _, err := parseScheduleQuery("bad", "from=2026-11-01&to=2026-11-01"); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("bad employee: %v", err)
	}
}
