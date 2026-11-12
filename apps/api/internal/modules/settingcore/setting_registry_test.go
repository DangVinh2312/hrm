package settingcore_test

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/settingcore"
)

type summary struct {
	group    settingcore.Group
	def      settingcore.Value
	min, max int64
}

func TestTheRegistryHasExactlyTheSettingKeysWithTheirDefaultsAndRanges(t *testing.T) {
	want := map[settingcore.Key]summary{
		"hr.annualLeaveDefaultMinutes": {settingcore.GroupRule, settingcore.IntValue(5760), 5760, 175_680},
		"hr.wfhMonthLimit":             {settingcore.GroupRule, settingcore.IntValue(4), 0, 31},
		"hr.requestWindowPastDays":     {settingcore.GroupRule, settingcore.IntValue(7), 0, 31},
		"hr.requestWindowFutureDays":   {settingcore.GroupRule, settingcore.IntValue(90), 0, 365},
		"hr.requestMaxDays":            {settingcore.GroupRule, settingcore.IntValue(31), 1, 31},
		"hr.workdayMaxMinutes":         {settingcore.GroupRule, settingcore.IntValue(480), 60, 720},
		"report.maxMonths":             {settingcore.GroupRule, settingcore.IntValue(12), 1, 12},
		"export.maxRows":               {settingcore.GroupRule, settingcore.IntValue(5000), 1, 5000},
		"export.maxBytes":              {settingcore.GroupRule, settingcore.IntValue(5_242_880), 1_048_576, 5_242_880},
		"company.name":                 {settingcore.GroupProfile, settingcore.TextValue(""), 0, 0},
		"company.defaultLocale":        {settingcore.GroupProfile, settingcore.TextValue("vi"), 0, 0},
	}
	keys := settingcore.Keys()
	if len(keys) != len(want) {
		t.Fatalf("keys %v", keys)
	}
	for _, key := range keys {
		expected, ok := want[key]
		def, found := settingcore.Lookup(string(key))
		if !ok || !found {
			t.Fatalf("key %q: expected %v found %v", key, ok, found)
		}
		if def.Group != expected.group || def.Default != expected.def || def.Min != expected.min || def.Max != expected.max {
			t.Fatalf("%q: %+v", key, def)
		}
		got, err := settingcore.Validate(string(key), def.Default)
		if err != nil || got != def.Default {
			t.Fatalf("the default of %q is not a value the registry accepts: %+v, %v", key, got, err)
		}
	}
	if len(slices.Compact(slices.Sorted(slices.Values(keys)))) != len(keys) {
		t.Fatalf("duplicate keys %v", keys)
	}
}

func TestTheRegistryKindsAndUnits(t *testing.T) {
	cases := map[string]struct {
		kind settingcore.Kind
		unit settingcore.Unit
	}{
		"hr.wfhMonthLimit":      {settingcore.KindInt, settingcore.UnitDays},
		"hr.workdayMaxMinutes":  {settingcore.KindInt, settingcore.UnitMinutes},
		"report.maxMonths":      {settingcore.KindInt, settingcore.UnitMonths},
		"export.maxRows":        {settingcore.KindInt, settingcore.UnitRows},
		"export.maxBytes":       {settingcore.KindInt, settingcore.UnitBytes},
		"company.name":          {settingcore.KindText, ""},
		"company.defaultLocale": {settingcore.KindEnum, ""},
	}
	for key, want := range cases {
		def, ok := settingcore.Lookup(key)
		if !ok || def.Kind != want.kind || def.Unit != want.unit {
			t.Fatalf("%s: %+v", key, def)
		}
	}
	if def, _ := settingcore.Lookup("company.name"); def.MaxLength != 120 {
		t.Fatalf("name length %d", def.MaxLength)
	}
	if def, _ := settingcore.Lookup("company.defaultLocale"); !slices.Equal(def.Values, []string{"vi", "en"}) {
		t.Fatalf("locales %v", def.Values)
	}
}

func TestLookupRefusesWhatIsNotARegisteredKey(t *testing.T) {
	for _, key := range []string{"", "hr.unknown", "toString", "__proto__", "hr.wfhMonthLimit ", "HR.wfhMonthLimit", "constructor"} {
		if def, ok := settingcore.Lookup(key); ok || def.Kind != "" {
			t.Fatalf("%q resolved to %+v", key, def)
		}
	}
}

func TestLookupGivesACopyThatCannotChangeTheRegistry(t *testing.T) {
	def, _ := settingcore.Lookup("company.defaultLocale")
	def.Values[0] = "xx"
	def.Max = 99
	again, _ := settingcore.Lookup("company.defaultLocale")
	if again.Values[0] != "vi" || again.Max != 0 {
		t.Fatalf("the registry changed: %+v", again)
	}
	if _, err := settingcore.Validate("company.defaultLocale", settingcore.TextValue("vi")); err != nil {
		t.Fatal(err)
	}
}

func invalid(t *testing.T, key string, input settingcore.Value) {
	t.Helper()
	if got, err := settingcore.Validate(key, input); !errors.Is(err, apperror.ErrInvalidRequest) || got != (settingcore.Value{}) {
		t.Fatalf("%s accepted %+v: %+v, %v", key, input, got, err)
	}
}

func TestIntegerSettingsTakeExactIntegersInsideMinAndMaxAndNothingElse(t *testing.T) {
	const key = "hr.wfhMonthLimit"
	for _, n := range []int64{0, 31} {
		if got, err := settingcore.Validate(key, settingcore.IntValue(n)); err != nil || got != settingcore.IntValue(n) {
			t.Fatalf("%d: %+v, %v", n, got, err)
		}
	}
	for _, n := range []int64{-1, 32, 1 << 53, -(1 << 53)} {
		invalid(t, key, settingcore.IntValue(n))
	}
	invalid(t, key, settingcore.TextValue("4"))
	invalid(t, key, settingcore.Value{})
	invalid(t, key, settingcore.Value{Kind: settingcore.ValueKind(9), Int: 4})
	invalid(t, "hr.nope", settingcore.IntValue(4))

	ceilings := map[string]int64{"hr.requestMaxDays": 31, "report.maxMonths": 12, "export.maxRows": 5000, "export.maxBytes": 5_242_880}
	for key, ceiling := range ceilings {
		if got, err := settingcore.Validate(key, settingcore.IntValue(ceiling)); err != nil || got.Int != ceiling {
			t.Fatalf("%s at its ceiling: %+v, %v", key, got, err)
		}
		invalid(t, key, settingcore.IntValue(ceiling+1))
		if def, _ := settingcore.Lookup(key); def.Max != ceiling {
			t.Fatalf("%s ceiling is %d, the code still enforces %d", key, def.Max, ceiling)
		}
	}
	if def, _ := settingcore.Lookup("hr.requestMaxDays"); def.Default.Int != 31 {
		t.Fatalf("default %+v", def.Default)
	}
	invalid(t, "export.maxBytes", settingcore.IntValue(1_048_575))
	invalid(t, "hr.requestMaxDays", settingcore.IntValue(0))
	invalid(t, "hr.annualLeaveDefaultMinutes", settingcore.IntValue(5759))
	invalid(t, "hr.annualLeaveDefaultMinutes", settingcore.IntValue(175_681))
}

func TestProfileSettingsAreBoundedTextWithoutControlsAndAnEnumOfTwoLocales(t *testing.T) {
	const name = "company.name"
	r := func(code rune) string { return string(code) }
	company := "C" + r(0x00f4) + "ng ty Gi" + r(0x1ea3)
	trimmed := map[string]string{
		"  " + company + "  ":                  company,
		"":                                     "",
		"   ":                                  "",
		r(0xfeff) + "x" + r(0xfeff):            "x",
		r(0x00a0) + "x" + r(0x2028):            "x",
		strings.Repeat("a", 120):               strings.Repeat("a", 120),
		strings.Repeat(r(0x1f600), 120):        strings.Repeat(r(0x1f600), 120),
		"  " + strings.Repeat("a", 120) + "  ": strings.Repeat("a", 120),
		r(0x0085) + "x":                        r(0x0085) + "x",
	}
	for in, want := range trimmed {
		if got, err := settingcore.Validate(name, settingcore.TextValue(in)); err != nil || got != settingcore.TextValue(want) {
			t.Fatalf("%q: %+v, %v", in, got, err)
		}
	}
	for _, bad := range []string{
		strings.Repeat("a", 121), strings.Repeat(r(0x1f600), 121), "x\ny", "x" + r(0) + "y", "x" + r(0x7f) + "y", "x\ty", "x" + string([]byte{0xff}),
	} {
		invalid(t, name, settingcore.TextValue(bad))
	}
	invalid(t, name, settingcore.IntValue(7))
	invalid(t, name, settingcore.Value{})

	const locale = "company.defaultLocale"
	for _, ok := range []string{"vi", "en"} {
		if got, err := settingcore.Validate(locale, settingcore.TextValue(ok)); err != nil || got.Text != ok {
			t.Fatalf("%s: %+v, %v", ok, got, err)
		}
	}
	for _, bad := range []string{"fr", "EN", "", " vi", "vi "} {
		invalid(t, locale, settingcore.TextValue(bad))
	}
	invalid(t, locale, settingcore.IntValue(1))
}

func TestStoredReadsAJsonbValueAndFailsClosedOnAnythingElse(t *testing.T) {
	good := []struct {
		key  settingcore.Key
		raw  string
		want settingcore.Value
	}{
		{"hr.requestMaxDays", "10", settingcore.IntValue(10)},
		{"hr.requestMaxDays", "10.0", settingcore.IntValue(10)},
		{"hr.requestMaxDays", "1E1", settingcore.IntValue(10)},
		{"company.name", `"` + string(rune(0x00e9)) + `"`, settingcore.TextValue(string(rune(0x00e9)))},
		{"company.name", `"  padded "`, settingcore.TextValue("padded")},
		{"company.name", `""`, settingcore.TextValue("")},
		{"company.defaultLocale", `"en"`, settingcore.TextValue("en")},
	}
	for _, tc := range good {
		if got, err := settingcore.Stored(tc.key, []byte(tc.raw)); err != nil || got != tc.want {
			t.Fatalf("%s %s: %+v, %v", tc.key, tc.raw, got, err)
		}
	}
	bad := []struct {
		key settingcore.Key
		raw string
	}{
		{"hr.requestMaxDays", "99"},
		{"hr.requestMaxDays", "0"},
		{"hr.requestMaxDays", "10.5"},
		{"hr.requestMaxDays", "10.0000000000000001"},
		{"hr.requestMaxDays", "9007199254740993"},
		{"hr.requestMaxDays", `"10"`},
		{"hr.requestMaxDays", "true"},
		{"hr.requestMaxDays", "null"},
		{"hr.requestMaxDays", "[10]"},
		{"hr.requestMaxDays", ""},
		{"hr.requestMaxDays", "1e999"},
		{"hr.requestMaxDays", "0x1p3"},
		{"hr.requestMaxDays", "NaN"},
		{"company.defaultLocale", `"fr"`},
		{"company.defaultLocale", "1"},
		{"company.name", `"` + strings.Repeat("a", 121) + `"`},
		{"company.name", `"a\nb"`},
		{"company.name", "{}"},
		{"hr.unknown", "1"},
	}
	for _, tc := range bad {
		got, err := settingcore.Stored(tc.key, []byte(tc.raw))
		if !errors.Is(err, settingcore.ErrStoredInvalid) || errors.Is(err, apperror.ErrInvalidRequest) || got != (settingcore.Value{}) {
			t.Fatalf("%s %s accepted: %+v, %v", tc.key, tc.raw, got, err)
		}
	}
}
