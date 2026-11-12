package setting

import (
	"encoding/json/v2"
	"errors"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/settingcore"
)

func decodeUpdate(t *testing.T, group settingcore.Group, key, body string) (UpdateInput, error) {
	t.Helper()
	var decoded updateBody
	if err := json.Unmarshal([]byte(body), &decoded, json.RejectUnknownMembers(true)); err != nil {
		return UpdateInput{}, apperror.ErrInvalidRequest
	}
	return parseUpdate(group, key, decoded)
}

func TestAnUpdateIsValueAndExpectedVersionForAKeyOfTheRouteGroup(t *testing.T) {
	got, err := decodeUpdate(t, settingcore.GroupRule, "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"0"}`)
	if err != nil || got != (UpdateInput{Key: settingcore.KeyWfhMonthLimit, Value: settingcore.IntValue(6), ExpectedVersion: "0"}) {
		t.Fatalf("rule update: %+v %v", got, err)
	}
	name := "C" + string(rune(0xf4)) + "ng ty Gi" + string(rune(0x1ea3))
	got, err = decodeUpdate(t, settingcore.GroupProfile, "company.name", `{"value":"`+name+`","expectedVersion":"12"}`)
	if err != nil || got != (UpdateInput{Key: settingcore.KeyCompanyName, Value: settingcore.TextValue(name), ExpectedVersion: "12"}) {
		t.Fatalf("profile update: %+v %v", got, err)
	}
	got, err = decodeUpdate(t, settingcore.GroupProfile, "company.name", `{"value":"  X  ","expectedVersion":"1"}`)
	if err != nil || got.Value != settingcore.TextValue("X") {
		t.Fatalf("text is trimmed: %+v %v", got, err)
	}
	got, err = decodeUpdate(t, settingcore.GroupRule, "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"999999999999999999"}`)
	if err != nil || got.ExpectedVersion != "999999999999999999" {
		t.Fatalf("largest version: %+v %v", got, err)
	}
	refused := map[string][3]string{
		"unknown key":                {"rule", "hr.nope", `{"value":6,"expectedVersion":"1"}`},
		"profile key on rule route":  {"rule", "company.name", `{"value":"x","expectedVersion":"1"}`},
		"rule key on profile route":  {"profile", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"1"}`},
		"range":                      {"rule", "hr.wfhMonthLimit", `{"value":32,"expectedVersion":"1"}`},
		"type":                       {"rule", "hr.wfhMonthLimit", `{"value":"6","expectedVersion":"1"}`},
		"no version":                 {"rule", "hr.wfhMonthLimit", `{"value":6}`},
		"no value":                   {"rule", "hr.wfhMonthLimit", `{"expectedVersion":"1"}`},
		"extra member":               {"rule", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"1","extra":1}`},
		"numeric version":            {"rule", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":1}`},
		"leading zero version":       {"rule", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"01"}`},
		"negative version":           {"rule", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"-1"}`},
		"version past int8":          {"rule", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"` + strings.Repeat("1", 19) + `"}`},
		"null version":               {"rule", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":null}`},
		"fraction":                   {"rule", "hr.wfhMonthLimit", `{"value":1.5,"expectedVersion":"1"}`},
		"integral fraction":          {"rule", "hr.wfhMonthLimit", `{"value":6.0,"expectedVersion":"1"}`},
		"exponent":                   {"rule", "hr.wfhMonthLimit", `{"value":6e0,"expectedVersion":"1"}`},
		"boolean":                    {"rule", "hr.wfhMonthLimit", `{"value":true,"expectedVersion":"1"}`},
		"null value":                 {"rule", "hr.wfhMonthLimit", `{"value":null,"expectedVersion":"1"}`},
		"array value":                {"rule", "hr.wfhMonthLimit", `{"value":[6],"expectedVersion":"1"}`},
		"object value":               {"rule", "hr.wfhMonthLimit", `{"value":{"n":6},"expectedVersion":"1"}`},
		"number past int64":          {"rule", "hr.wfhMonthLimit", `{"value":99999999999999999999,"expectedVersion":"1"}`},
		"number on a text key":       {"profile", "company.name", `{"value":7,"expectedVersion":"1"}`},
		"array on a text key":        {"profile", "company.name", `{"value":["x"],"expectedVersion":"1"}`},
		"control character":          {"profile", "company.name", `{"value":"x\ny","expectedVersion":"1"}`},
		"too long":                   {"profile", "company.name", `{"value":"` + strings.Repeat("a", 121) + `","expectedVersion":"1"}`},
		"enum outside the list":      {"profile", "company.defaultLocale", `{"value":"fr","expectedVersion":"1"}`},
		"enum of another case":       {"profile", "company.defaultLocale", `{"value":"EN","expectedVersion":"1"}`},
		"repeated member":            {"rule", "hr.wfhMonthLimit", `{"value":6,"value":7,"expectedVersion":"1"}`},
		"member of another case":     {"rule", "hr.wfhMonthLimit", `{"Value":6,"expectedVersion":"1"}`},
		"empty key":                  {"rule", "", `{"value":6,"expectedVersion":"1"}`},
		"prototype key":              {"rule", "__proto__", `{"value":6,"expectedVersion":"1"}`},
		"constructor key":            {"rule", "constructor", `{"value":6,"expectedVersion":"1"}`},
		"key with a trailing space":  {"rule", "hr.wfhMonthLimit ", `{"value":6,"expectedVersion":"1"}`},
		"numeric key":                {"rule", "7", `{"value":6,"expectedVersion":"1"}`},
		"security is not a setting":  {"rule", "security.sessionHours", `{"value":1,"expectedVersion":"0"}`},
		"group outside the registry": {"other", "hr.wfhMonthLimit", `{"value":6,"expectedVersion":"1"}`},
	}
	for name, c := range refused {
		if _, err := decodeUpdate(t, settingcore.Group(c[0]), c[1], c[2]); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestAKeyAndAHistoryPageAreValidatedBeforeAnyOperation(t *testing.T) {
	if key, err := parseKey("report.maxMonths"); err != nil || key != settingcore.KeyReportMaxMonths {
		t.Fatalf("known key: %q %v", key, err)
	}
	for _, bad := range []string{"report.nope", "7", "", "toString", "__proto__", "report.maxMonths "} {
		if _, err := parseKey(bad); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("key %q: %v", bad, err)
		}
	}
	for raw, want := range map[string][2]int{"": {20, 0}, "limit=50&offset=10": {50, 10}, "limit=100&offset=10000": {100, 10000}} {
		page, err := parseHistoryQuery(raw)
		if err != nil || page.Limit != want[0] || page.Offset != want[1] {
			t.Errorf("page %q: %+v %v", raw, page, err)
		}
	}
	for _, bad := range []string{"limit=0", "limit=101", "offset=10001", "key=x", "limit=5&limit=5", "limit=-1", "limit=1.5", "%zz"} {
		if _, err := parseHistoryQuery(bad); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("page %q: %v", bad, err)
		}
	}
}

func TestAValueIsWrittenAsTheJSONOfItsKind(t *testing.T) {
	for want, value := range map[string]settingcore.Value{
		`6`: settingcore.IntValue(6), `-3`: settingcore.IntValue(-3), `"vi"`: settingcore.TextValue("vi"), `"a\"b"`: settingcore.TextValue(`a"b`),
	} {
		raw, err := json.Marshal(jsonValue(value))
		if err != nil || string(raw) != want {
			t.Errorf("%s: %s %v", want, raw, err)
		}
	}
	if _, err := json.Marshal(jsonValue{}); err == nil {
		t.Fatal("a value of no kind was written")
	}
}

func TestEveryKeyHasAViewWithTheDefaultAtVersionZeroUntilARowExists(t *testing.T) {
	updated := "2026-11-09T01:02:03.000004Z"
	views, err := settingViews([]storedSetting{
		{Key: "hr.wfhMonthLimit", Value: []byte(`8`), Version: "2", UpdatedAt: updated},
		{Key: "hr.removedLongAgo", Value: []byte(`1`), Version: "1", UpdatedAt: updated},
	})
	if err != nil || len(views) != len(settingcore.Keys()) {
		t.Fatalf("views: %d %v", len(views), err)
	}
	for i, key := range settingcore.Keys() {
		if views[i].Key != key {
			t.Fatalf("order %d: %s", i, views[i].Key)
		}
	}
	raw, err := json.Marshal(views)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`{"key":"hr.wfhMonthLimit","group":"rule","default":4,"value":8,"version":"2","isDefault":false,"updatedAt":"` + updated + `","kind":"int","unit":"days","min":0,"max":31}`,
		`{"key":"hr.requestMaxDays","group":"rule","default":31,"value":31,"version":"0","isDefault":true,"updatedAt":null,"kind":"int","unit":"days","min":1,"max":31}`,
		`{"key":"company.name","group":"profile","default":"","value":"","version":"0","isDefault":true,"updatedAt":null,"kind":"text","maxLength":120}`,
		`{"key":"company.defaultLocale","group":"profile","default":"vi","value":"vi","version":"0","isDefault":true,"updatedAt":null,"kind":"enum","values":["vi","en"]}`,
	} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("missing %s in %s", want, raw)
		}
	}
	if strings.Contains(string(raw), "removedLongAgo") {
		t.Fatal("a row outside the registry was shown")
	}
	if _, err := settingViews([]storedSetting{{Key: "hr.wfhMonthLimit", Value: []byte(`99`), Version: "1", UpdatedAt: updated}}); !errors.Is(err, settingcore.ErrStoredInvalid) {
		t.Fatalf("corrupt row: %v", err)
	}
}
