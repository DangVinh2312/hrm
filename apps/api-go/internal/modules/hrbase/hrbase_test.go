package hrbase_test

import (
	"errors"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/modules/hrbase"
)

func TestCurrentWindowBuildsTheStatementClockRule(t *testing.T) {
	got, err := hrbase.CurrentWindow("r")
	if err != nil {
		t.Fatal(err)
	}
	want := "r.starts_at <= statement_timestamp() AND (r.ends_at IS NULL OR r.ends_at > statement_timestamp())"
	if got != want {
		t.Fatalf("got %q", got)
	}
	if hrbase.BusinessToday != "(statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date" {
		t.Fatalf("business today %q", hrbase.BusinessToday)
	}
}

func TestCurrentWindowRefusesAnAliasThatIsNotAnIdentifier(t *testing.T) {
	for name, alias := range map[string]string{
		"empty":          "",
		"injection":      "r; DROP TABLE x",
		"qualified":      "r.x",
		"upper":          "R",
		"digit first":    "1a",
		"quoted":         `"r"`,
		"trailing blank": "r ",
		"trailing LF":    "r\n",
		"too long":       strings.Repeat("a", 64),
		"non ascii":      "r" + string(rune(0x00e9)),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := hrbase.CurrentWindow(alias)
			if !errors.Is(err, hrbase.ErrInvalidAlias) || got != "" {
				t.Fatalf("accepted %q: %q, %v", alias, got, err)
			}
		})
	}
	for _, alias := range []string{"r", "_r", "emp_1", strings.Repeat("a", 63)} {
		if _, err := hrbase.CurrentWindow(alias); err != nil {
			t.Fatalf("refused %q: %v", alias, err)
		}
	}
}

func TestReplayAnswersOnlyTheSamePayload(t *testing.T) {
	prior := hrbase.Claim[string]{Hash: "h1", Result: "stored"}
	got, err := hrbase.Replay(prior, "h1")
	if err != nil || got != "stored" {
		t.Fatalf("same hash: %q, %v", got, err)
	}
	got, err = hrbase.Replay(prior, "h2")
	var rejection apperror.Rejection
	if !errors.As(err, &rejection) || rejection.Code != "error.idempotencyKeyReused" || got != "" {
		t.Fatalf("other hash: %q, %v", got, err)
	}
	if _, code, known := apperror.Response(err); !known || code != "error.idempotencyKeyReused" {
		t.Fatalf("not a planned answer: %v %v", code, known)
	}
}

func TestParseIdempotencyKey(t *testing.T) {
	const good = "0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b09"
	if got, err := hrbase.ParseIdempotencyKey([]string{good}); err != nil || got != good {
		t.Fatalf("good: %q, %v", got, err)
	}
	for name, values := range map[string][]string{
		"absent":    nil,
		"empty":     {""},
		"repeated":  {good, good},
		"upper":     {strings.ToUpper(good)},
		"version 1": {"0b8d1a4e-5c3f-1a7b-9e21-3f6d8c2a1b09"},
		"variant c": {"0b8d1a4e-5c3f-4a7b-ce21-3f6d8c2a1b09"},
		"trailing":  {good + "\n"},
		"leading":   {" " + good},
		"short":     {good[:35]},
		"not hex":   {"0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b0g"},
	} {
		t.Run(name, func(t *testing.T) {
			if got, err := hrbase.ParseIdempotencyKey(values); !errors.Is(err, apperror.ErrInvalidRequest) || got != "" {
				t.Fatalf("accepted %q: %q, %v", values, got, err)
			}
		})
	}
}
