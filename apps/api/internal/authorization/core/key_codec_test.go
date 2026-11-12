package core_test

import (
	"strings"
	"testing"

	"hrm/api/internal/authorization/core"
)

func parsed(t *testing.T, kind core.KeyKind, input string) core.Key {
	t.Helper()
	key, err := fixtureCore.ParseKey(kind, input)
	if err != nil {
		t.Fatalf("ParseKey(%s, %q): %v", kind, input, err)
	}
	return key
}

func TestIntegerKeysKeepFullPrecisionAsCanonicalDecimalStrings(t *testing.T) {
	for _, input := range []string{"9007199254740993", "-9223372036854775808", "9223372036854775807", "0"} {
		if got := parsed(t, core.KeyInteger, input); got != (core.Key{Kind: core.KeyInteger, Value: input}) {
			t.Errorf("ParseKey(%q) = %#v", input, got)
		}
	}
	if parsed(t, core.KeyInteger, "9007199254740993") == parsed(t, core.KeyInteger, "9007199254740992") {
		t.Error("two integers above 2^53 parsed to the same key")
	}
}

func TestIntegerKeysRejectNonCanonicalOrOutOfRangeSpellings(t *testing.T) {
	for _, input := range []string{
		"042", "+42", "-0", " 42", "42 ", "4.2", "1e3", "", "9223372036854775808", "-9223372036854775809",
		"0x10", "9007199254740993.0",
	} {
		if key, err := fixtureCore.ParseKey(core.KeyInteger, input); err == nil {
			t.Errorf("ParseKey(%q) = %#v", input, key)
		}
	}
}

func TestIntegerAndStringKeysAreDifferentReferences(t *testing.T) {
	integer, text := parsed(t, core.KeyInteger, "42"), parsed(t, core.KeyString, "42")
	if integer == text {
		t.Error("integer:42 equals string:42")
	}
	if integer.String() == text.String() {
		t.Errorf("both print as %q", integer)
	}
	if integer.String() != "integer:42" {
		t.Errorf("printed as %q", integer)
	}
}

func TestUUIDKeysAreNormalizedToLowercaseAndValidated(t *testing.T) {
	const lower = "d97eecc9-8f23-4a76-a9aa-82b9d4ef33ac"
	upper := parsed(t, core.KeyUUID, strings.ToUpper(lower))
	if upper != (core.Key{Kind: core.KeyUUID, Value: lower}) {
		t.Errorf("uppercase parsed to %#v", upper)
	}
	if upper != parsed(t, core.KeyUUID, lower) {
		t.Error("the two spellings differ")
	}
	for _, input := range []string{"d97eecc98f234a76a9aa82b9d4ef33ac", "{" + lower + "}", "not-a-uuid", "1", ""} {
		if key, err := fixtureCore.ParseKey(core.KeyUUID, input); err == nil {
			t.Errorf("ParseKey(%q) = %#v", input, key)
		}
	}
}

func TestStringKeysKeepExactBytes(t *testing.T) {
	upperA := string(rune(0xc5)) + "ngstr" + string(rune(0xf6)) + "m"
	lowerA := string(rune(0xe5)) + "ngstr" + string(rune(0xf6)) + "m"
	composed, decomposed := string(rune(0xe9)), "e"+string(rune(0x301))
	for _, input := range []string{
		"O'Reilly \"x\"", " padded ", upperA, lowerA, composed, decomposed, string(rune(0x1f600)), "'; DROP TABLE x; --",
	} {
		if got := parsed(t, core.KeyString, input); got.Value != input {
			t.Errorf("ParseKey(%q) = %q", input, got.Value)
		}
	}
	if parsed(t, core.KeyString, upperA) == parsed(t, core.KeyString, lowerA) {
		t.Error("keys are case folded")
	}
	if parsed(t, core.KeyString, composed) == parsed(t, core.KeyString, decomposed) {
		t.Error("keys are Unicode normalized")
	}
}

func TestStringKeysRejectEmptyInvalidUTF8AndMoreThan256Bytes(t *testing.T) {
	twoBytes := string(rune(0xe9))
	if got := parsed(t, core.KeyString, strings.Repeat(twoBytes, 128)); len(got.Value) != core.MaxKeyBytes {
		t.Errorf("a key of 256 bytes has %d bytes", len(got.Value))
	}
	for name, input := range map[string]string{
		"empty":        "",
		"surrogate":    "\xed\xa0\x80",
		"invalid byte": "a\xff",
		"257 bytes":    strings.Repeat(twoBytes, 128) + "a",
		"257 ASCII":    strings.Repeat("a", 257),
	} {
		t.Run(name, func(t *testing.T) {
			if key, err := fixtureCore.ParseKey(core.KeyString, input); err == nil {
				t.Fatalf("accepted %#v", key)
			}
		})
	}
}

func TestUnknownKeyKindIsRejected(t *testing.T) {
	for _, kind := range []core.KeyKind{"other", ""} {
		if key, err := fixtureCore.ParseKey(kind, "x"); err == nil {
			t.Errorf("ParseKey(%q) = %#v", kind, key)
		}
	}
}
