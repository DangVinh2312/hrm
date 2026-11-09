package httpapi_test

import (
	"errors"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/httpapi"
)

func TestInputTextTrimsLikeJavaScriptAndCountsCodePoints(t *testing.T) {
	r := func(code rune) string { return string(code) }
	emoji := r(0x1f600)
	composed := r(0x00e9)
	decomposed := "e" + r(0x0301)
	accepted := []struct {
		name, in string
		limit    int
		want     string
	}{
		{"plain", "abc", 3, "abc"},
		{"ascii blanks", " \t\n\v\f\rabc \t", 3, "abc"},
		{"bom is trimmed", r(0xfeff) + "abc" + r(0xfeff), 3, "abc"},
		{"nbsp is trimmed", r(0x00a0) + "abc", 3, "abc"},
		{"line separator is trimmed", "abc" + r(0x2028), 3, "abc"},
		{"paragraph separator is trimmed", r(0x2029) + "abc", 3, "abc"},
		{"ideographic space is trimmed", r(0x3000) + "abc" + r(0x3000), 3, "abc"},
		{"en quad is trimmed", r(0x2000) + "abc" + r(0x200a), 3, "abc"},
		{"next line is kept", r(0x0085) + "abc", 4, r(0x0085) + "abc"},
		{"zero width space is kept", r(0x200b) + "abc", 4, r(0x200b) + "abc"},
		{"emoji is one point", emoji + emoji, 2, emoji + emoji},
		{"precomposed is one point", composed + composed, 2, composed + composed},
		{"decomposed is two points", decomposed, 2, decomposed},
		{"inner blanks stay", "a b", 3, "a b"},
	}
	for _, tc := range accepted {
		t.Run(tc.name, func(t *testing.T) {
			got, err := httpapi.InputText(tc.in, tc.limit)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	refused := map[string]struct {
		in    string
		limit int
	}{
		"empty":                 {"", 5},
		"only blanks":           {" \t" + r(0xfeff) + r(0x00a0) + r(0x2028), 5},
		"nul":                   {"a" + r(0), 5},
		"unit separator":        {"a" + r(0x1f), 5},
		"newline inside":        {"a\nb", 5},
		"delete":                {"a" + r(0x7f), 5},
		"over by one":           {"abcd", 3},
		"emoji over":            {emoji + emoji + emoji, 2},
		"decomposed over":       {decomposed + decomposed, 3},
		"invalid utf8":          {"a" + string([]byte{0xff}), 5},
		"limit after trim only": {"  abcd  ", 3},
	}
	for name, tc := range refused {
		t.Run(name, func(t *testing.T) {
			if got, err := httpapi.InputText(tc.in, tc.limit); !errors.Is(err, apperror.ErrInvalidRequest) || got != "" {
				t.Fatalf("accepted %q: %q, %v", tc.in, got, err)
			}
		})
	}
}

func TestInputUUIDIsCanonicalLowercase(t *testing.T) {
	for _, good := range []string{
		"0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b09",
		"0b8d1a4e-5c3f-1a7b-ae21-3f6d8c2a1b09",
		"0b8d1a4e-5c3f-8a7b-be21-3f6d8c2a1b09",
	} {
		if got, err := httpapi.InputUUID(good); err != nil || got != good {
			t.Fatalf("%q: %q, %v", good, got, err)
		}
	}
	for _, bad := range []string{
		"", "0B8D1A4E-5C3F-4A7B-9E21-3F6D8C2A1B09", "0b8d1a4e-5c3f-0a7b-9e21-3f6d8c2a1b09",
		"0b8d1a4e-5c3f-9a7b-9e21-3f6d8c2a1b09", "0b8d1a4e-5c3f-4a7b-ce21-3f6d8c2a1b09",
		"0b8d1a4e5c3f4a7b9e213f6d8c2a1b09", "0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b09\n", "{0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b09}",
	} {
		if got, err := httpapi.InputUUID(bad); !errors.Is(err, apperror.ErrInvalidRequest) || got != "" {
			t.Fatalf("accepted %q: %q, %v", bad, got, err)
		}
	}
}

func TestInputVersionIsAPositiveInt8Decimal(t *testing.T) {
	for _, good := range []string{"1", "9", "10", strings.Repeat("9", 18)} {
		if got, err := httpapi.InputVersion(good); err != nil || got != good {
			t.Fatalf("%q: %q, %v", good, got, err)
		}
	}
	for _, bad := range []string{"", "0", "01", "-1", "+1", "1.0", " 1", "1\n", strings.Repeat("9", 19), "1" + string(rune(0x0663))} {
		if got, err := httpapi.InputVersion(bad); !errors.Is(err, apperror.ErrInvalidRequest) || got != "" {
			t.Fatalf("accepted %q: %q, %v", bad, got, err)
		}
	}
}

func TestInputBooleanNeedsAPresentFlag(t *testing.T) {
	yes, no := true, false
	if got, err := httpapi.InputBoolean(&yes); err != nil || !got {
		t.Fatalf("true: %v, %v", got, err)
	}
	if got, err := httpapi.InputBoolean(&no); err != nil || got {
		t.Fatalf("false: %v, %v", got, err)
	}
	if _, err := httpapi.InputBoolean(nil); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("absent flag: %v", err)
	}
}

func TestInputPageQuery(t *testing.T) {
	accepted := []struct {
		name, query string
		extra       []string
		want        httpapi.Page
	}{
		{"defaults", "", nil, httpapi.Page{Limit: 20, Extra: map[string]string{}}},
		{"explicit", "limit=50&offset=10", nil, httpapi.Page{Limit: 50, Offset: 10, Extra: map[string]string{}}},
		{"bounds", "limit=100&offset=10000", nil, httpapi.Page{Limit: 100, Offset: 10000, Extra: map[string]string{}}},
		{"low bound", "limit=1&offset=0", nil, httpapi.Page{Limit: 1, Extra: map[string]string{}}},
		{"leading zeros", "limit=007", nil, httpapi.Page{Limit: 7, Extra: map[string]string{}}},
		{"extra", "key=hr.x&limit=5", []string{"key", "q"}, httpapi.Page{Limit: 5, Extra: map[string]string{"key": "hr.x"}}},
		{"extra empty value", "q=", []string{"q"}, httpapi.Page{Limit: 20, Extra: map[string]string{"q": ""}}},
		{"escaped", "q=a%20b", []string{"q"}, httpapi.Page{Limit: 20, Extra: map[string]string{"q": "a b"}}},
	}
	for _, tc := range accepted {
		t.Run(tc.name, func(t *testing.T) {
			got, err := httpapi.InputPageQuery(tc.query, tc.extra...)
			if err != nil || got.Limit != tc.want.Limit || got.Offset != tc.want.Offset || len(got.Extra) != len(tc.want.Extra) {
				t.Fatalf("got %+v, %v; want %+v", got, err, tc.want)
			}
			for key, value := range tc.want.Extra {
				if got.Extra[key] != value {
					t.Fatalf("extra %q = %q", key, got.Extra[key])
				}
			}
		})
	}
	refused := map[string]struct {
		query string
		extra []string
	}{
		"repeated limit":      {"limit=1&limit=2", nil},
		"repeated offset":     {"offset=1&offset=1", nil},
		"repeated extra":      {"q=a&q=b", []string{"q"}},
		"unknown key":         {"sort=name", nil},
		"unknown next to ok":  {"limit=5&sort=name", []string{"q"}},
		"key case":            {"Limit=5", nil},
		"limit zero":          {"limit=0", nil},
		"limit over":          {"limit=101", nil},
		"offset over":         {"offset=10001", nil},
		"six digits":          {"limit=000001", nil},
		"empty limit":         {"limit=", nil},
		"no value":            {"limit", nil},
		"negative":            {"offset=-1", nil},
		"sign":                {"limit=%2B5", nil},
		"fraction":            {"limit=5.0", nil},
		"non ascii digit":     {"limit=" + "%D9%A3", nil},
		"semicolon":           {"limit=5;offset=1", nil},
		"bad escape":          {"limit=%zz", nil},
		"extra not declared":  {"q=a", []string{"key"}},
		"repeated via escape": {"%6cimit=1&limit=2", nil},
	}
	for name, tc := range refused {
		t.Run(name, func(t *testing.T) {
			if got, err := httpapi.InputPageQuery(tc.query, tc.extra...); !errors.Is(err, apperror.ErrInvalidRequest) || got.Extra != nil {
				t.Fatalf("accepted %q: %+v, %v", tc.query, got, err)
			}
		})
	}
}
