package attendance

import (
	"encoding/json/v2"
	"errors"
	"reflect"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/attendancecore"
)

const (
	employee = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"
	key      = "0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21"
)

func text(points ...rune) string { return string(points) }

func refusedInput(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("accepted %s: %v", what, err)
	}
}

// decode reads raw as DecodeCommand does.
func decode[T any](raw string) (T, error) {
	var body T
	err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true))
	return body, err
}

var badMonths = []string{
	"2026-13", "2026-00", "1899-12", "2101-01", "", "2026-1", "26-11", "2026-11-01", "2026/11", " 2026-11",
	"+2026-11", text(0x662, 0x660, 0x662, 0x666, '-', '1', '1'),
}

func TestParseMonthIsTheBoundedYearMonthOnly(t *testing.T) {
	for _, month := range []string{"2026-11", "1900-01", "2100-12"} {
		if got, err := parseMonth(month); err != nil || got != month {
			t.Errorf("%s: %q, %v", month, got, err)
		}
	}
	for _, month := range badMonths {
		_, err := parseMonth(month)
		refusedInput(t, month, err)
	}
}

func TestParseSheetQueryTakesAnOptionalMonthOnly(t *testing.T) {
	got, err := parseSheetQuery(employee, "")
	if err != nil || got.EmployeeID != employee || got.Month != nil {
		t.Fatalf("no query: %+v, %v", got, err)
	}
	got, err = parseSheetQuery(employee, "month=2026-11")
	if err != nil || got.Month == nil || *got.Month != "2026-11" {
		t.Fatalf("month: %+v, %v", got, err)
	}
	for _, query := range []string{
		"month=2026-13", "month=1899-12", "month=2101-01", "month=", "month", "month=2026-11&month=2026-11",
		"%6Donth=2026-11&month=2026-11", "x=1", "Month=2026-11", "month=%zz", "month=2026-1", "month=2026-11&x=1",
		"month=2026-11&limit=5", "month=2026-11-01",
	} {
		_, err := parseSheetQuery(employee, query)
		refusedInput(t, query, err)
	}
	for _, id := range []string{"not-a-uuid", strings.ToUpper(employee), ""} {
		_, err := parseSheetQuery(id, "")
		refusedInput(t, "id "+id, err)
	}
}

func TestParseReopenNeedsATrimmedReason(t *testing.T) {
	long := strings.Repeat(text(0x1ec7), 1000)
	for raw, want := range map[string]string{
		`{"reason":"  S` + text(0x1eed) + `a l` + text(0x1ecb) + `ch  "}`: "S" + text(0x1eed) + "a l" + text(0x1ecb) + "ch",
		`{"reason":"` + text(0xfeff) + `x` + text(0x2028) + `"}`:          "x",
		`{"reason":"` + long + `"}`:                                       long,
	} {
		body, err := decode[reopenBody](raw)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := parseReopen("2026-11", body); err != nil || got != (ReopenInput{Month: "2026-11", Reason: want}) {
			t.Errorf("%s: %+v, %v", raw, got, err)
		}
	}
	for _, raw := range []string{
		`{}`, `{"reason":null}`, `{"reason":""}`, `{"reason":"   "}`, `{"reason":1}`, `{"reason":"a\u0000b"}`,
		`{"reason":"a\u0007b"}`, `{"reason":"` + long + `x"}`, `null`,
	} {
		body, err := decode[reopenBody](raw)
		if err != nil {
			continue
		}
		_, err = parseReopen("2026-11", body)
		refusedInput(t, raw, err)
	}
	for _, raw := range []string{
		`{"reason":"x","expectedVersion":"1"}`, `{"reason":"x","reason":"y"}`, `{"Reason":"x"}`, `[]`,
	} {
		if _, err := decode[reopenBody](raw); err == nil {
			t.Errorf("decoded %s", raw)
		}
	}
	body, err := decode[reopenBody](`{"reason":"x"}`)
	if err != nil {
		t.Fatal(err)
	}
	for _, month := range badMonths {
		_, err := parseReopen(month, body)
		refusedInput(t, "month "+month, err)
	}
}

func adjustment(t *testing.T, raw string) (AdjustmentInput, error) {
	t.Helper()
	body, err := decode[adjustmentBody](raw)
	if err != nil {
		return AdjustmentInput{}, apperror.ErrInvalidRequest
	}
	return parseAdjustment(employee, []string{key}, body)
}

func adjustmentWith(member, value string) string {
	members := map[string]string{"workDate": `"2026-11-03"`, "minutes": `-60`, "reason": `"x"`}
	members[member] = value
	parts := []string{}
	for _, name := range []string{"workDate", "minutes", "reason", "reference"} {
		if value, ok := members[name]; ok && value != "" {
			parts = append(parts, `"`+name+`":`+value)
		}
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func TestParseAdjustmentReadsTheBodyThePathAndTheKey(t *testing.T) {
	reference := "Q" + text(0x110) + "-2026/11"
	got, err := adjustment(t, `{"workDate":"2026-11-03","minutes":-60,"reason":" Qu`+text(0xea)+`n ","reference":"`+reference+`"}`)
	want := AdjustmentInput{
		EmployeeID: employee, IdempotencyKey: key, WorkDate: "2026-11-03", Minutes: -60, Reason: "Qu" + text(0xea) + "n",
		Reference: &reference,
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v, %v", got, err)
	}
	got, err = adjustment(t, `{"workDate":"2026-11-03","minutes":1,"reason":"x"}`)
	if err != nil || got.Reference != nil || got.Minutes != 1 {
		t.Fatalf("omitted reference: %+v, %v", got, err)
	}
	for _, raw := range []string{`null`, `{}`} {
		_, err := adjustment(t, raw)
		refusedInput(t, raw, err)
	}
	valid, err := decode[adjustmentBody](adjustmentWith("", ""))
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"not-a-uuid", strings.ToUpper(employee), ""} {
		_, err := parseAdjustment(id, []string{key}, valid)
		refusedInput(t, "id "+id, err)
	}
	for _, keys := range [][]string{nil, {key, key}, {strings.ToUpper(key)}, {"0b9c7a8e-2f3d-1c1b-9a8e-7d6c5b4a3f21"}, {""}} {
		_, err := parseAdjustment(employee, keys, valid)
		refusedInput(t, "key "+strings.Join(keys, ","), err)
	}
	for _, raw := range []string{
		`{"workDate":"2026-11-03","minutes":-60,"reason":"x","employeeId":"` + employee + `"}`,
		`{"workDate":"2026-11-03","minutes":-60,"reason":"x","idempotencyKey":"` + key + `"}`,
		`{"workDate":"2026-11-03","minutes":-60,"reason":"x","hash":"00"}`,
		`{"workDate":"2026-11-03","minutes":-60,"minutes":60,"reason":"x"}`,
		`{"workDate":"2026-11-03","Minutes":-60,"reason":"x"}`,
		`{"workDate":"2026-11-03","minutes":-60,"reason":"x","reference":"a","reference":"b"}`,
		`[]`,
	} {
		if _, err := decode[adjustmentBody](raw); err == nil {
			t.Errorf("decoded %s", raw)
		}
	}
}

func TestAdjustmentMinutesAreASignedNonZeroIntegerWithinADay(t *testing.T) {
	for _, minutes := range []string{"1440", "-1440", "1", "-1", "480"} {
		if _, err := adjustment(t, adjustmentWith("minutes", minutes)); err != nil {
			t.Errorf("refused %s: %v", minutes, err)
		}
	}
	for _, minutes := range []string{
		"0", "-0", "1441", "-1441", "1.0", "1e2", "-6e1", "60.5", `"60"`, "null", "true", "01", "+60",
		"9223372036854775808", "99999999999999999999", "[60]",
	} {
		_, err := adjustment(t, adjustmentWith("minutes", minutes))
		refusedInput(t, minutes, err)
	}
	_, err := adjustment(t, `{"workDate":"2026-11-03","reason":"x"}`)
	refusedInput(t, "no minutes", err)
}

func TestAdjustmentWorkDateIsACalendarDateOfTheBoundedYears(t *testing.T) {
	for _, date := range []string{"2024-02-29", "1900-01-01", "2100-12-31", "2026-11-30"} {
		if got, err := adjustment(t, adjustmentWith("workDate", `"`+date+`"`)); err != nil || got.WorkDate != date {
			t.Errorf("%s: %+v, %v", date, got, err)
		}
	}
	for _, date := range []string{
		`"2026-02-29"`, `"2100-02-29"`, `"2026-11-31"`, `"2026-13-01"`, `"1899-12-31"`, `"2101-01-01"`, `"2026-11-3"`,
		`"2026/11/03"`, `"20261103"`, `"2026-11-03T00:00:00Z"`, `" 2026-11-03"`, `""`, `null`, `20261103`, `"2026-11"`,
	} {
		_, err := adjustment(t, adjustmentWith("workDate", date))
		refusedInput(t, date, err)
	}
	_, err := adjustment(t, `{"minutes":-60,"reason":"x"}`)
	refusedInput(t, "no workDate", err)
}

func TestAdjustmentReasonIsTrimmedTextOfAtMost300CodePoints(t *testing.T) {
	long := strings.Repeat(text(0x1ec7), 300)
	family := text(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
	for value, want := range map[string]string{
		`"` + long + `"`: long,
		`"  ` + strings.Repeat(family, 60) + `  "`:                   strings.Repeat(family, 60),
		`"Nghi` + text(0x302, 0x300) + ` <a>&` + text(0x2028) + `b"`: "Nghi" + text(0x302, 0x300) + " <a>&" + text(0x2028) + "b",
	} {
		if got, err := adjustment(t, adjustmentWith("reason", value)); err != nil || got.Reason != want {
			t.Errorf("%s: %q, %v", value, got.Reason, err)
		}
	}
	for _, value := range []string{
		`"` + long + `x"`, `"` + strings.Repeat(family, 60) + `x"`, `""`, `"   "`, `null`, `1`, `"a\u0000b"`, `"a\u001fb"`,
		`"a\u007fb"`, `"a\nb"`,
	} {
		_, err := adjustment(t, adjustmentWith("reason", value))
		refusedInput(t, value, err)
	}
	_, err := adjustment(t, `{"workDate":"2026-11-03","minutes":-60}`)
	refusedInput(t, "no reason", err)
}

func TestAdjustmentReferenceIsAnUntrimmedIdentifierOrOmitted(t *testing.T) {
	for _, reference := range []string{
		"Q" + text(0x110) + "-2026/11", "S" + text(0x1ed1) + " 12#A:b_c.d", "QD ", strings.Repeat(text(0x110), 64),
		"1", text(0x661, 0x662), text(0x6c49, 0x5b57),
	} {
		raw, err := json.Marshal(reference)
		if err != nil {
			t.Fatal(err)
		}
		got, err := adjustment(t, adjustmentWith("reference", string(raw)))
		if err != nil || got.Reference == nil || *got.Reference != reference {
			t.Errorf("%q: %+v, %v", reference, got.Reference, err)
		}
	}
	for _, value := range []string{
		`null`, `""`, `" QD"`, `"-12"`, `".a"`, `"Q<1>"`, `"a&b"`, `"a` + text(0x301) + `"`, `"a\tb"`, `"a\u0000"`,
		`"` + text(0x1f44d) + `"`, `"a` + text(0x1f44d) + `"`, `"` + strings.Repeat("x", 65) + `"`, `12`, `["a"]`,
		`"a\nb"`, `"a` + text(0x2028) + `"`,
	} {
		_, err := adjustment(t, adjustmentWith("reference", value))
		refusedInput(t, value, err)
	}
}

func TestParseAdjustmentQueryNeedsAMonthAndPages(t *testing.T) {
	got, err := parseAdjustmentQuery(employee, "month=2026-11")
	if err != nil || got != (AdjustmentQuery{EmployeeID: employee, Month: "2026-11", Limit: 20}) {
		t.Fatalf("defaults: %+v, %v", got, err)
	}
	got, err = parseAdjustmentQuery(employee, "month=2026-11&limit=100&offset=10000")
	if err != nil || got != (AdjustmentQuery{EmployeeID: employee, Month: "2026-11", Limit: 100, Offset: 10000}) {
		t.Fatalf("explicit: %+v, %v", got, err)
	}
	for _, query := range []string{
		"", "limit=5", "month=2026-13", "month=", "month=2026-11&month=2026-12", "month=2026-11&x=1",
		"month=2026-11&limit=101", "month=2026-11&limit=0", "month=2026-11&offset=10001", "month=2026-11&limit=1.0",
		"month=2026-11&employeeId=" + employee, "month=2026-11&limit=5&limit=5", "Month=2026-11", "month=%zz",
	} {
		_, err := parseAdjustmentQuery(employee, query)
		refusedInput(t, query, err)
	}
	_, err = parseAdjustmentQuery("not-a-uuid", "month=2026-11")
	refusedInput(t, "id", err)
}

func TestTheViewsKeepTheShapeOfTheWebClient(t *testing.T) {
	sheet := SheetView{
		EmployeeID: employee, Month: "2026-11", PeriodState: attendancecore.PeriodOpen,
		Totals: attendancecore.Totals{ScheduledMinutes: 1, PaidMinutes: -5, AdjustmentMinutes: -6},
	}
	got, err := json.Marshal(sheet)
	want := `{"employeeId":"` + employee + `","month":"2026-11","periodState":"open","scheduledMinutes":1,` +
		`"paidHolidayMinutes":0,"unpaidMinutes":0,"annualLeaveMinutes":0,"paidMinutes":-5,"wfhDays":0,"lateCount":0,` +
		`"lateMinutes":0,"earlyCount":0,"earlyMinutes":0,"adjustmentMinutes":-6}`
	if err != nil || string(got) != want {
		t.Errorf("sheet: %s, %v", got, err)
	}
	got, err = json.Marshal(PeriodHistory{Month: "2026-11", State: attendancecore.PeriodOpen, Version: "1"})
	if err != nil || string(got) != `{"month":"2026-11","state":"open","version":"1","events":[]}` {
		t.Errorf("history: %s, %v", got, err)
	}
	got, err = json.Marshal(AdjustmentList{EmployeeID: employee, Month: "2026-11", PeriodState: attendancecore.PeriodClosed, Total: "0"})
	if err != nil || string(got) != `{"employeeId":"`+employee+`","month":"2026-11","periodState":"closed","adjustmentMinutes":0,"total":"0","items":[]}` {
		t.Errorf("list: %s, %v", got, err)
	}
	got, err = json.Marshal(AdjustmentItem{ID: key, WorkDate: "2026-11-03", Minutes: -60, Reason: "x", CreatedAt: "t"})
	if err != nil || string(got) != `{"id":"`+key+`","workDate":"2026-11-03","minutes":-60,"reason":"x","reference":null,"createdAt":"t"}` {
		t.Errorf("item: %s, %v", got, err)
	}
	got, err = json.Marshal(PeriodEvent{Event: "close", Version: "2", OccurredAt: "t"})
	if err != nil || string(got) != `{"event":"close","version":"2","reason":null,"occurredAt":"t"}` {
		t.Errorf("event: %s, %v", got, err)
	}
}
