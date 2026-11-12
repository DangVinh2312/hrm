package values_test

import (
	"slices"
	"strings"
	"testing"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/values"
)

var invalidTimestamps = map[string]core.FieldValue{
	"nonexistent date 2026-02-30":  core.TextValue("2026-02-30T00:00:00Z"),
	"invalid leap year 2025-02-29": core.TextValue("2025-02-29T00:00:00Z"),
	"century non-leap 1900-02-29":  core.TextValue("1900-02-29T00:00:00Z"),
	"month 0":                      core.TextValue("2026-00-10T00:00:00Z"),
	"day 0":                        core.TextValue("2026-10-00T00:00:00Z"),
	"month 13":                     core.TextValue("2026-13-10T00:00:00Z"),
	"april 31":                     core.TextValue("2026-04-31T00:00:00Z"),
	"june 31":                      core.TextValue("2026-06-31T00:00:00Z"),
	"september 31":                 core.TextValue("2026-09-31T00:00:00Z"),
	"november 31":                  core.TextValue("2026-11-31T00:00:00Z"),
	"hour 24":                      core.TextValue("2026-10-14T24:00:00Z"),
	"hour 24 with minutes":         core.TextValue("2026-10-14T24:00:01Z"),
	"minute 60":                    core.TextValue("2026-10-14T00:60:00Z"),
	"leap second":                  core.TextValue("2026-06-30T23:59:60Z"),
	"missing Z":                    core.TextValue("2026-10-14T00:00:00"),
	"offset +07:00":                core.TextValue("2026-10-14T07:00:00+07:00"),
	"offset +00:00":                core.TextValue("2026-10-14T00:00:00+00:00"),
	"seven fractional digits":      core.TextValue("2026-10-14T00:00:00.1234567Z"),
	"empty fraction":               core.TextValue("2026-10-14T00:00:00.Z"),
	"lowercase z":                  core.TextValue("2026-10-14T00:00:00z"),
	"lowercase t":                  core.TextValue("2026-10-14t00:00:00Z"),
	"space separator":              core.TextValue("2026-10-14 00:00:00Z"),
	"leading whitespace":           core.TextValue(" 2026-10-14T00:00:00Z"),
	"trailing whitespace":          core.TextValue("2026-10-14T00:00:00Z "),
	"trailing newline":             core.TextValue("2026-10-14T00:00:00Z\n"),
	"trailing junk":                core.TextValue("2026-10-14T00:00:00Zjunk"),
	"year 0000":                    core.TextValue("0000-01-01T00:00:00Z"),
	"date only":                    core.TextValue("2026-10-14"),
	"no seconds":                   core.TextValue("2026-10-14T00:00Z"),
	"non-ASCII digits":             core.TextValue(strings.Repeat(string(rune(0xff12)), 4) + "-10-14T00:00:00Z"),
	"empty string":                 core.TextValue(""),
	"boolean":                      core.BoolValue(true),
	"null":                         core.NullValue(),
	"zero value":                   {},
}

func normalizeText(t *testing.T, codec core.ScalarCodec, input string) string {
	t.Helper()
	value, ok := codec.Normalize(core.TextValue(input))
	if !ok {
		t.Fatalf("normalize(%q) was refused", input)
	}
	text, isText := value.AsText()
	if !isText {
		t.Fatalf("normalize(%q) is not text", input)
	}
	return text
}

func compare(t *testing.T, codec core.ScalarCodec, left, right string) core.Comparison {
	t.Helper()
	order, err := codec.Compare(core.Text(left), core.Text(right))
	if err != nil {
		t.Fatalf("compare(%q, %q): %v", left, right, err)
	}
	return order
}

func normalizesTo(codec core.ScalarCodec, input, want string) bool {
	value, ok := codec.Normalize(core.TextValue(input))
	text, isText := value.AsText()
	return ok && isText && text == want
}

func comparesAs(codec core.ScalarCodec, left, right string, want core.Comparison) bool {
	order, err := codec.Compare(core.Text(left), core.Text(right))
	return err == nil && order == want
}

// timestampConformance returns the failed cases; any timestamp adapter has to return none.
func timestampConformance(codec core.ScalarCodec) []string {
	var failed []string
	check := func(name string, holds bool) {
		if !holds {
			failed = append(failed, name)
		}
	}
	canonical := map[string]string{
		"2026-10-14T00:00:00.1Z":      "2026-10-14T00:00:00.100000Z",
		"2026-10-14T00:00:00Z":        "2026-10-14T00:00:00.000000Z",
		"2026-10-14T00:00:00.123456Z": "2026-10-14T00:00:00.123456Z",
		"2026-10-14T00:00:00.000001Z": "2026-10-14T00:00:00.000001Z",
		"2024-02-29T12:00:00Z":        "2024-02-29T12:00:00.000000Z",
		"2000-02-29T12:00:00Z":        "2000-02-29T12:00:00.000000Z",
		"2026-10-14T23:59:59.999999Z": "2026-10-14T23:59:59.999999Z",
		"0001-12-31T23:59:59.000001Z": "0001-12-31T23:59:59.000001Z",
		"0001-01-01T00:00:00Z":        "0001-01-01T00:00:00.000000Z",
		"0099-12-31T23:59:59.000001Z": "0099-12-31T23:59:59.000001Z",
		"0100-01-01T00:00:00Z":        "0100-01-01T00:00:00.000000Z",
		"9999-12-31T23:59:59.000001Z": "9999-12-31T23:59:59.000001Z",
		"0004-02-29T00:00:00Z":        "0004-02-29T00:00:00.000000Z",
		"0096-02-29T00:00:00Z":        "0096-02-29T00:00:00.000000Z",
	}
	for input, want := range canonical {
		check("canonical "+input, normalizesTo(codec, input, want))
	}
	for _, input := range []string{"0100-02-29T00:00:00Z", "0001-02-29T00:00:00Z"} {
		_, ok := codec.Normalize(core.TextValue(input))
		check("rejects "+input, !ok)
	}
	for name, input := range invalidTimestamps {
		_, ok := codec.Normalize(input)
		check("rejects "+name, !ok)
	}
	const low, high = "2026-10-14T00:00:00.000001Z", "2026-10-14T00:00:00.000002Z"
	check("microseconds order", comparesAs(codec, low, high, core.Less) && comparesAs(codec, high, low, core.Greater) &&
		comparesAs(codec, low, low, core.Equal))
	const early, late = "0099-12-31T23:59:59.999999Z", "0100-01-01T00:00:00.000000Z"
	check("years order", comparesAs(codec, early, late, core.Less) && comparesAs(codec, late, early, core.Greater))
	check("normalize is idempotent", normalizesTo(codec, "2026-10-14T00:00:00.500000Z", "2026-10-14T00:00:00.500000Z"))
	return failed
}

func TestTimestampCodecPassesConformance(t *testing.T) {
	for _, failed := range timestampConformance(values.Codecs().Timestamp) {
		t.Error(failed)
	}
}

// lenientTimestamp accepts any text; the conformance suite has to notice it.
type lenientTimestamp struct{}

func (lenientTimestamp) Normalize(input core.FieldValue) (core.Scalar, bool) {
	text, ok := input.AsText()
	return core.Text(text), ok
}

func (lenientTimestamp) Compare(core.Scalar, core.Scalar) (core.Comparison, error) {
	return core.Equal, nil
}

func TestConformanceSuiteRefusesALenientTimestampCodec(t *testing.T) {
	failed := timestampConformance(lenientTimestamp{})
	for _, want := range []string{
		"rejects nonexistent date 2026-02-30", "rejects hour 24", "rejects leap second", "rejects offset +07:00",
		"rejects missing Z", "rejects seven fractional digits", "canonical 2026-10-14T00:00:00Z", "microseconds order",
	} {
		if !slices.Contains(failed, want) {
			t.Errorf("a lenient codec passed %q", want)
		}
	}
}

func TestIntegerCodecKeepsExactCanonicalInt64(t *testing.T) {
	codec := values.Codecs().Integer
	for _, input := range []string{"0", "42", "9007199254740993", "-9223372036854775808", "9223372036854775807"} {
		if got := normalizeText(t, codec, input); got != input {
			t.Errorf("normalize(%q) = %q", input, got)
		}
	}
	for _, input := range []core.FieldValue{
		core.TextValue("9223372036854775808"), core.TextValue("-9223372036854775809"),
		core.TextValue("01"), core.TextValue("-0"), core.TextValue("+1"), core.TextValue("1.0"),
		core.TextValue(" 1"), core.TextValue("1 "), core.TextValue(""), core.TextValue("1e3"), core.TextValue("0x10"),
		core.TextValue("1_000"), core.BoolValue(true), core.NullValue(), {},
	} {
		if value, ok := codec.Normalize(input); ok {
			t.Errorf("%#v was accepted as %#v", input, value)
		}
	}
	if compare(t, codec, "9007199254740993", "9007199254740992") != core.Greater {
		t.Error("values above 2^53 compare as equal")
	}
	if compare(t, codec, "-9223372036854775808", "9223372036854775807") != core.Less {
		t.Error("int64 bounds do not order")
	}
	if compare(t, codec, "5", "5") != core.Equal {
		t.Error("equal integers do not compare equal")
	}
	if _, err := codec.Compare(core.Text("not a number"), core.Text("1")); err == nil {
		t.Error("compare accepted a value that was never normalized")
	}
	if _, err := codec.Compare(core.Bool(true), core.Text("1")); err == nil {
		t.Error("compare accepted a boolean")
	}
}

func TestDecimalCodecKeepsTheLiteralAndComparesWithoutFloatingPoint(t *testing.T) {
	codec := values.Codecs().Decimal
	for _, input := range []string{"10.0", "10.00", "-0", "0.1"} {
		if got := normalizeText(t, codec, input); got != input {
			t.Errorf("normalize(%q) = %q", input, got)
		}
	}
	for _, input := range []core.FieldValue{
		core.TextValue("1e3"), core.TextValue(".5"), core.TextValue("5."), core.TextValue("+1"), core.TextValue("01"),
		core.TextValue("1,5"), core.TextValue(" 1"), core.TextValue(""), core.TextValue("-"), core.TextValue("NaN"),
		core.BoolValue(true), core.NullValue(), {},
	} {
		if value, ok := codec.Normalize(input); ok {
			t.Errorf("%#v was accepted as %#v", input, value)
		}
	}
	const big = "123456789012345678901234567890.123456789012345678901234567890"
	const bigger = "123456789012345678901234567890.123456789012345678901234567891"
	cases := []struct {
		left, right string
		want        core.Comparison
	}{
		{"10.0", "10.00", core.Equal},
		{"10.0", "10", core.Equal},
		{"10.01", "10.1", core.Less},
		{"9.99", "10", core.Less},
		{"0.1", "0.10000000000000001", core.Less},
		{big, bigger, core.Less},
		{bigger, big, core.Greater},
		{big, big + "000", core.Equal},
		{"99999999999999999999", "100000000000000000000", core.Less},
		{"-1", "-2", core.Greater},
		{"-2.5", "-2.50", core.Equal},
		{"-1", "1", core.Less},
		{"-0", "0", core.Equal},
		{"-0.00", "0", core.Equal},
		{"-0", "0.001", core.Less},
		{"-0.001", "-0", core.Less},
	}
	for _, c := range cases {
		if got := compare(t, codec, c.left, c.right); got != c.want {
			t.Errorf("compare(%q, %q) = %d, want %d", c.left, c.right, got, c.want)
		}
	}
	if _, err := codec.Compare(core.Text("x"), core.Text("1")); err == nil {
		t.Error("compare accepted a value that was never normalized")
	}
}

func TestUUIDCodecLowercasesAndComparesForEqualityOnly(t *testing.T) {
	codec := values.Codecs().UUID
	const lower = "0190a5c2-7b1e-7c3a-8f55-0123456789ab"
	if got := normalizeText(t, codec, strings.ToUpper(lower)); got != lower {
		t.Errorf("uppercase normalized to %q", got)
	}
	if got := normalizeText(t, codec, lower); got != lower {
		t.Errorf("lowercase normalized to %q", got)
	}
	for _, input := range []core.FieldValue{
		core.TextValue(""), core.TextValue("not-a-uuid"), core.TextValue(lower[1:]), core.TextValue(lower + "0"),
		core.TextValue(strings.ReplaceAll(lower, "-", "")), core.TextValue("{" + lower + "}"), core.TextValue(" " + lower),
		core.TextValue(lower + "\n"), core.TextValue(strings.Replace(lower, "a", "g", 1)),
		core.BoolValue(true), core.NullValue(), {},
	} {
		if value, ok := codec.Normalize(input); ok {
			t.Errorf("%#v was accepted as %#v", input, value)
		}
	}
	if compare(t, codec, lower, lower) != core.Equal {
		t.Error("equal uuids do not compare equal")
	}
	if compare(t, codec, lower, "0190a5c2-7b1e-7c3a-8f55-0123456789ac") == core.Equal {
		t.Error("different uuids compare equal")
	}
}

func TestStringCodecKeepsExactBytesAndOrdersByCodePoint(t *testing.T) {
	codec := values.Codecs().String
	composed := string(rune(0xe9))
	decomposed := "e" + string(rune(0x301))
	for _, input := range []string{"  padded  ", composed, decomposed, "", string(rune(0x1f600))} {
		if got := normalizeText(t, codec, input); got != input {
			t.Errorf("normalize(%q) = %q", input, got)
		}
	}
	if compare(t, codec, composed, decomposed) == core.Equal {
		t.Error("Unicode normalization forms compare equal")
	}
	for _, input := range []core.FieldValue{
		core.TextValue("\xed\xa0\x80"), core.TextValue("a\xffb"), core.BoolValue(true), core.NullValue(), {},
	} {
		if value, ok := codec.Normalize(input); ok {
			t.Errorf("%#v was accepted as %#v", input, value)
		}
	}
	astral, lastBMP := string(rune(0x10000)), string(rune(0xffff))
	cases := []struct {
		left, right string
		want        core.Comparison
	}{
		{astral, lastBMP, core.Greater},
		{lastBMP, astral, core.Less},
		{"a", "ab", core.Less},
		{"ab", "a", core.Greater},
		{"same", "same", core.Equal},
		{"Z", "a", core.Less},
	}
	for _, c := range cases {
		if got := compare(t, codec, c.left, c.right); got != c.want {
			t.Errorf("compare(%q, %q) = %d, want %d", c.left, c.right, got, c.want)
		}
	}
	long := strings.Repeat("a", 257)
	if normalizeText(t, codec, long) != long {
		t.Error("the string codec applied the key limit")
	}
}

func TestBooleanCodecAcceptsOnlyBooleans(t *testing.T) {
	codec := values.Codecs().Boolean
	for _, input := range []bool{true, false} {
		value, ok := codec.Normalize(core.BoolValue(input))
		got, isBool := value.AsBool()
		if !ok || !isBool || got != input {
			t.Errorf("normalize(%v) = %#v, %v", input, value, ok)
		}
	}
	for _, input := range []core.FieldValue{core.TextValue("true"), core.TextValue("1"), core.NullValue(), {}} {
		if value, ok := codec.Normalize(input); ok {
			t.Errorf("%#v was accepted as %#v", input, value)
		}
	}
	same, err := codec.Compare(core.Bool(true), core.Bool(true))
	if err != nil || same != core.Equal {
		t.Errorf("true vs true = %d, %v", same, err)
	}
	different, err := codec.Compare(core.Bool(true), core.Bool(false))
	if err != nil || different == core.Equal {
		t.Errorf("true vs false = %d, %v", different, err)
	}
	if _, err := codec.Compare(core.Text("true"), core.Bool(true)); err == nil {
		t.Error("compare accepted text")
	}
}

func TestEveryCodecRefusesTheZeroScalarOnCompare(t *testing.T) {
	codecs := values.Codecs()
	for name, codec := range map[string]core.ScalarCodec{
		"timestamp": codecs.Timestamp, "integer": codecs.Integer, "decimal": codecs.Decimal,
		"uuid": codecs.UUID, "string": codecs.String, "boolean": codecs.Boolean,
	} {
		if _, err := codec.Compare(core.Scalar{}, core.Scalar{}); err == nil {
			t.Errorf("%s compared two zero scalars", name)
		}
	}
}

func TestCodecsBuildACoreThatKeepsTheirContracts(t *testing.T) {
	c, err := core.New(values.Codecs())
	if err != nil {
		t.Fatal(err)
	}
	const lower = "0190a5c2-7b1e-7c3a-8f55-0123456789ab"
	if c.IsCanonicalUUID(strings.ToUpper(lower)) {
		t.Error("an uppercase uuid is canonical")
	}
	if !c.IsCanonicalUUID(lower) {
		t.Error("a lowercase uuid is not canonical")
	}
	if _, err := c.ParseKey(core.KeyString, strings.Repeat("a", 257)); err == nil {
		t.Error("a key above 256 bytes was accepted")
	}
	key, err := c.ParseKey(core.KeyString, strings.Repeat("a", 256))
	if err != nil || key.Kind != core.KeyString {
		t.Errorf("a key of 256 bytes: %#v, %v", key, err)
	}
}
