package workrequest

import (
	"encoding/json/v2"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/hrbase"
)

const (
	team    = "3a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d"
	someKey = "0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21"
)

func text(points ...rune) string { return string(points) }

func quote(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// object writes {"k1":v1,...} from key and raw JSON value pairs, in order.
func object(pairs ...string) string {
	members := make([]string, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		members = append(members, strconv.Quote(pairs[i])+":"+pairs[i+1])
	}
	return "{" + strings.Join(members, ",") + "}"
}

// parse decodes raw as DecodeCommand does, then validates it with one good key.
func parse(raw string) (SubmitInput, error) {
	var body submitBody
	if err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true)); err != nil {
		return SubmitInput{}, apperror.ErrInvalidRequest
	}
	return parseSubmit([]string{someKey}, body)
}

func invalid(t *testing.T, raw string) {
	t.Helper()
	if got, err := parse(raw); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("accepted %s: %+v, %v", raw, got, err)
	}
}

func TestBodiesPerKindAreParsedIntoOneNormalizedShape(t *testing.T) {
	team := team
	for _, tc := range []struct {
		raw  string
		want SubmitInput
	}{
		{
			object("kind", `"late-arrival"`, "date", `"2026-11-03"`, "expectedMinute", "600", "reason", quote(t, " "+text(0x110, 0x1b0)+"a con ")),
			SubmitInput{Kind: hrbase.RequestLateArrival, Reason: text(0x110, 0x1b0) + "a con", Date: "2026-11-03", ExpectedMinute: 600},
		},
		{
			object("kind", `"wfh"`, "teamId", quote(t, team), "dates", `["2026-11-17","2026-11-16"]`, "reason", `"x"`),
			SubmitInput{Kind: hrbase.RequestWfh, TeamID: &team, Reason: "x", Dates: []string{"2026-11-16", "2026-11-17"}},
		},
		{
			object("kind", `"unpaid-leave"`, "teamId", "null", "reason", `"x"`, "segments",
				`[{"date":"2026-12-01","startMinute":540,"endMinute":1080},{"date":"2026-11-30","startMinute":0,"endMinute":1440}]`),
			SubmitInput{Kind: hrbase.RequestUnpaidLeave, Reason: "x", Segments: []Slot{{"2026-11-30", 0, 1440}, {"2026-12-01", 540, 1080}}},
		},
	} {
		got, err := parse(tc.raw)
		tc.want.IdempotencyKey = someKey
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %+v, %v", tc.raw, got, err)
		}
	}
}

func TestABodyHasExactlyTheKeysOfItsKind(t *testing.T) {
	late := []string{"kind", `"late-arrival"`, "date", `"2026-11-03"`, "expectedMinute", "600", "reason", `"x"`}
	with := func(pairs ...string) string { return object(append(append([]string{}, late...), pairs...)...) }
	for _, extra := range []string{"employeeId", "ownerAccountId", "state", "stage", "version", "Kind"} {
		invalid(t, with(extra, quote(t, team)))
	}
	for _, other := range []string{"dates", "segments"} {
		invalid(t, with(other, "null"))
		invalid(t, with(other, `["2026-11-03"]`))
	}
	invalid(t, object("kind", `"wfh"`, "dates", `["2026-11-03"]`, "reason", `"x"`, "date", "null"))
	invalid(t, object("kind", `"wfh"`, "dates", `["2026-11-03"]`, "reason", `"x"`, "expectedMinute", "600"))
	invalid(t, object("kind", `"annual-leave"`, "segments", `[{"date":"2026-11-03","startMinute":540,"endMinute":660}]`, "reason", `"x"`, "dates", `[]`))
	invalid(t, object("kind", `"late-arrival"`, "date", `"2026-11-03"`, "reason", `"x"`))
	invalid(t, object("date", `"2026-11-03"`, "expectedMinute", "600", "reason", `"x"`))
	invalid(t, object("kind", `"late-arrival"`, "date", `"2026-11-03"`, "expectedMinute", "600"))
	invalid(t, "{}")
	invalid(t, "null")
}

func TestFieldValuesAreChecked(t *testing.T) {
	late := map[string]string{"kind": `"late-arrival"`, "date": `"2026-11-03"`, "expectedMinute": "600", "reason": `"x"`}
	with := func(key, value string) string {
		pairs := []string{}
		for _, name := range []string{"kind", "date", "expectedMinute", "reason"} {
			raw := late[name]
			if name == key {
				raw = value
			}
			pairs = append(pairs, name, raw)
		}
		return object(pairs...)
	}
	for key, values := range map[string][]string{
		"reason":         {`""`, `"  "`, `"a\nb"`, quote(t, "a"+text(0)+"b"), quote(t, strings.Repeat("x", 1001)), "null", "1"},
		"expectedMinute": {"600.5", `"600"`, "-1", "1441", "null", "6e2", "600.0", "true"},
		"date":           {`"2026-02-30"`, `"2026-11-3"`, `"1899-12-31"`, `"2101-01-01"`, "null", `""`},
		"kind":           {`"sick-leave"`, `"WFH"`, "null", `""`},
	} {
		for _, value := range values {
			invalid(t, with(key, value))
		}
	}
	invalid(t, object("kind", `"late-arrival"`, "date", `"2026-11-03"`, "expectedMinute", "600", "reason", `"x"`, "teamId", `"not-a-uuid"`))
	invalid(t, object("kind", `"late-arrival"`, "date", `"2026-11-03"`, "expectedMinute", "600", "reason", `"x"`, "teamId", quote(t, strings.ToUpper(team))))
	for _, edge := range []string{"0", "1440"} {
		if _, err := parse(with("expectedMinute", edge)); err != nil {
			t.Errorf("refused minute %s: %v", edge, err)
		}
	}
	if _, err := parse(with("reason", quote(t, strings.Repeat(text(0x1f44d), 1000)))); err != nil {
		t.Errorf("1000 code points refused: %v", err)
	}
	var body submitBody
	if err := json.Unmarshal([]byte(with("date", `"2026-11-03"`)), &body); err != nil {
		t.Fatal(err)
	}
	for _, keys := range [][]string{nil, {}, {someKey, someKey}, {strings.ToUpper(someKey)}} {
		if _, err := parseSubmit(keys, body); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("key %q accepted: %v", keys, err)
		}
	}
}

func TestMultiDayRequestsAreBoundedSortedAndUnique(t *testing.T) {
	days := func(n int) string {
		dates := make([]string, n)
		for i := range dates {
			day := i%31 + 1
			month := 3 + i/31
			dates[i] = `"2026-0` + strconv.Itoa(month) + "-" + strconv.Itoa(day/10) + strconv.Itoa(day%10) + `"`
		}
		return "[" + strings.Join(dates, ",") + "]"
	}
	wfh := func(dates string) string { return object("kind", `"wfh"`, "dates", dates, "reason", `"x"`) }
	if got, err := parse(wfh(days(31))); err != nil || len(got.Dates) != 31 {
		t.Errorf("31 days: %d, %v", len(got.Dates), err)
	}
	for _, dates := range []string{days(32), `[]`, `null`, `["2026-11-16","2026-11-16"]`, `["2026-11-16",null]`, `["2026-11-16",5]`, `"2026-11-16"`} {
		invalid(t, wfh(dates))
	}
	for _, dates := range []string{`["2026-12-31","2027-01-04"]`, `["2026-11-30","2026-12-01"]`} {
		if _, err := parse(wfh(dates)); err != nil {
			t.Errorf("%s refused: %v", dates, err)
		}
	}
	leave := func(segments string) string {
		return object("kind", `"annual-leave"`, "segments", segments, "reason", `"x"`)
	}
	for _, segments := range []string{
		`[{"date":"2026-11-03","startMinute":540,"endMinute":660},{"date":"2026-11-03","startMinute":840,"endMinute":960}]`,
		`[{"date":"2026-11-03","startMinute":540}]`,
		`[{"date":"2026-11-03","startMinute":540,"endMinute":1441}]`,
		`[{"date":"2026-11-03","startMinute":540,"endMinute":660,"minutes":120}]`,
		`[{"date":"2026-11-03","startMinute":540,"endMinute":null}]`,
		`[null]`,
		`[]`,
		`null`,
	} {
		invalid(t, leave(segments))
	}
}

func TestTheListTakesOnlyAPage(t *testing.T) {
	for raw, want := range map[string]ListQuery{"": {Limit: 20}, "limit=1&offset=1": {Limit: 1, Offset: 1}} {
		if got, err := parseRequestList(raw); err != nil || got != want {
			t.Errorf("%q: %+v, %v", raw, got, err)
		}
	}
	for _, raw := range []string{"limit=101", "state=approved", "limit=1&limit=2"} {
		if _, err := parseRequestList(raw); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%q accepted: %v", raw, err)
		}
	}
}
