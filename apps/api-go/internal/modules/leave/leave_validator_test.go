package leave

import (
	"encoding/json/v2"
	"errors"
	"reflect"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
)

const (
	employee = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b"
	key      = "0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21"
)

func refusedInput(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("accepted %s: %v", what, err)
	}
}

func TestParseBalanceQueryTakesAnOptionalDateOnly(t *testing.T) {
	got, err := parseBalanceQuery(employee, "")
	if err != nil || got.EmployeeID != employee || got.AsOn != nil {
		t.Fatalf("no query: %+v, %v", got, err)
	}
	got, err = parseBalanceQuery(employee, "date=2026-11-30")
	if err != nil || got.AsOn == nil || *got.AsOn != "2026-11-30" {
		t.Fatalf("date: %+v, %v", got, err)
	}
	for _, query := range []string{
		"date=2026-02-30", "date=30/11/2026", "date=2026-11-30&date=2026-11-30", "year=2026", "date=1899-12-31",
		"date=2101-01-01", "date=", "date", "date=2026-11-30&x=1", "Date=2026-11-30", "date=%zz", "date=2026-1-30",
	} {
		_, err := parseBalanceQuery(employee, query)
		refusedInput(t, query, err)
	}
	for _, id := range []string{"not-a-uuid", strings.ToUpper(employee), ""} {
		_, err := parseBalanceQuery(id, "")
		refusedInput(t, "id "+id, err)
	}
}

func TestParseReconciliationQueryPagesAnOptionalYear(t *testing.T) {
	got, err := parseReconciliationQuery("")
	if err != nil || got.Year != nil || got.Limit != 20 || got.Offset != 0 {
		t.Fatalf("defaults: %+v, %v", got, err)
	}
	got, err = parseReconciliationQuery("year=2026&limit=5&offset=10")
	if err != nil || got.Year == nil || *got.Year != 2026 || got.Limit != 5 || got.Offset != 10 {
		t.Fatalf("explicit: %+v, %v", got, err)
	}
	for _, bound := range []string{"year=1900", "year=2100"} {
		if _, err := parseReconciliationQuery(bound); err != nil {
			t.Errorf("refused %s: %v", bound, err)
		}
	}
	for _, query := range []string{
		"year=26", "year=2101", "year=1899", "limit=101", "x=1", "year=", "year=02026", "year=2026&year=2027",
		"year=%D9%A2%D9%A0%D9%A2%D9%A6", "limit=0", "offset=10001", "year=+2026",
	} {
		_, err := parseReconciliationQuery(query)
		refusedInput(t, query, err)
	}
}

func decodeAdjustment(t *testing.T, raw string) (adjustmentBody, error) {
	t.Helper()
	var body adjustmentBody
	err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true))
	return body, err
}

func TestParseAdjustmentNeedsSignedMinutesADateAReferenceAndAKey(t *testing.T) {
	body, err := decodeAdjustment(t, `{"minutes":-480,"effectiveOn":"2026-03-10","reference":" Q`+string(rune(0x0110))+`-12/2026 "}`)
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseAdjustment(employee, []string{key}, body)
	want := AdjustmentInput{EmployeeID: employee, IdempotencyKey: key, Minutes: -480, EffectiveOn: "2026-03-10", Reference: "Q" + string(rune(0x0110)) + "-12/2026"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v, %v", got, err)
	}
	for _, bound := range []string{`175680`, `-175680`, `1`, `-1`} {
		body, err := decodeAdjustment(t, `{"minutes":`+bound+`,"effectiveOn":"2026-03-10","reference":"x"}`)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseAdjustment(employee, []string{key}, body); err != nil {
			t.Errorf("refused %s: %v", bound, err)
		}
	}
	refused := []string{
		`{"minutes":0,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":-0,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":175681,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":-175681,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":1.5,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":480.0,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":"480","effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":null,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":99999999999999999999,"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"effectiveOn":"2026-03-10","reference":"x"}`,
		`{"minutes":480,"effectiveOn":"2026-02-30","reference":"x"}`,
		`{"minutes":480,"effectiveOn":"10/03/2026","reference":"x"}`,
		`{"minutes":480,"effectiveOn":"1899-12-31","reference":"x"}`,
		`{"minutes":480,"effectiveOn":null,"reference":"x"}`,
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":""}`,
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":"   "}`,
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":"` + strings.Repeat("x", 201) + `"}`,
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":"a\u0000b"}`,
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":"a\u007fb"}`,
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":null}`,
		`{"minutes":480,"effectiveOn":"2026-03-10"}`,
		`null`,
	}
	for _, raw := range refused {
		body, err := decodeAdjustment(t, raw)
		if err != nil {
			continue
		}
		_, err = parseAdjustment(employee, []string{key}, body)
		refusedInput(t, raw, err)
	}
	for _, raw := range []string{
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":"x","kind":"opening"}`,
		`{"minutes":480,"effectiveOn":"2026-03-10","reference":"x","employeeId":"` + employee + `"}`,
		`{"minutes":480,"Minutes":480,"effectiveOn":"2026-03-10","reference":"x"}`,
		`[]`,
	} {
		if _, err := decodeAdjustment(t, raw); err == nil {
			t.Errorf("decoded %s", raw)
		}
	}
	long := `{"minutes":480,"effectiveOn":"2026-03-10","reference":"` + strings.Repeat(string(rune(0x1f44d)), 200) + `"}`
	if body, err := decodeAdjustment(t, long); err != nil {
		t.Fatal(err)
	} else if _, err := parseAdjustment(employee, []string{key}, body); err != nil {
		t.Errorf("200 code points refused: %v", err)
	}
	ok, err := decodeAdjustment(t, `{"minutes":480,"effectiveOn":"2026-03-10","reference":"x"}`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = parseAdjustment("nope", []string{key}, ok)
	refusedInput(t, "path id", err)
	for _, keys := range [][]string{nil, {}, {""}, {key, key}, {strings.ToUpper(key)}, {"0b9c7a8e-2f3d-1c1b-9a8e-7d6c5b4a3f21"}} {
		_, err := parseAdjustment(employee, keys, ok)
		refusedInput(t, "key "+strings.Join(keys, ","), err)
	}
}
