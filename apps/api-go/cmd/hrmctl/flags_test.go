package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"strings"
	"testing"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/offline"
)

const (
	pairs    = "Expected unique --option value pairs"
	fakeUser = "0f1e2d3c-4b5a-4968-8776-655443322110"
)

func TestFlagsArePairsOfTheCommand(t *testing.T) {
	for _, tc := range []struct {
		command string
		args    []string
		want    map[string]string
		refusal string
	}{
		{"provision", nil, map[string]string{}, ""},
		{"provision", []string{"--"}, map[string]string{}, ""},
		{"sync", []string{"--user", "x"}, nil, "Unexpected option --user"},
		{"migrate", []string{"--", "--"}, nil, pairs},
		{"migrate", []string{"--", "--", "x"}, nil, "Unexpected option"},
		{"purge-sessions", []string{"--retention-days", "7"}, map[string]string{"--retention-days": "7"}, ""},
		{"purge-sessions", []string{"--", "--retention-days", "7"}, map[string]string{"--retention-days": "7"}, ""},
		{"purge-sessions", []string{"--retention-days", "7", "--"}, nil, pairs},
		{"purge-sessions", []string{"--retention-days"}, nil, pairs},
		{"purge-sessions", []string{"--retention-days", ""}, nil, pairs},
		{"purge-sessions", []string{"retention-days", "7"}, nil, pairs},
		{"purge-sessions", []string{"--retention-days", "7", "--retention-days", "8"}, nil, pairs},
		{"enroll", []string{"--user", "u", "--email", "e", "--issuer", "i", "--role", "r"},
			map[string]string{"--user": "u", "--email": "e", "--issuer": "i", "--role": "r"}, ""},
		{"enroll", []string{"--subject", "s"}, nil, "Unexpected option --subject"},
		{"enroll", []string{"--method", "oidc"}, nil, "Unexpected option --method"},
		{"enroll", []string{"--retention-days", "7"}, nil, "Unexpected option --retention-days"},
		{"reset-mfa", []string{"--user", "u", "--operation", "o", "--approval", "a", "--reason", "r"},
			map[string]string{"--user": "u", "--operation": "o", "--approval": "a", "--reason": "r"}, ""},
		{"reset-root-mfa", []string{"--email", "x"}, nil, "Unexpected option --email"},
		{"reset-mfa", []string{"--user=leak@example.test", "x"}, nil, "Unexpected option"},
	} {
		t.Run(tc.command+" "+strings.Join(tc.args, " "), func(t *testing.T) {
			got, err := parseFlags(tc.command, tc.args)
			if tc.refusal == "" {
				if err != nil || !maps.Equal(got, tc.want) {
					t.Fatalf("got %v, %v", got, err)
				}
				return
			}
			var usage *usageError
			if !errors.As(err, &usage) || usage.message != tc.refusal {
				t.Fatalf("got %v, want %q", err, tc.refusal)
			}
		})
	}
}

func TestAnUnknownCommandNamesTheCommands(t *testing.T) {
	err := run(context.Background(), []string{"bootstrap-all", "--user", "x"}, func(string) string { return "" }, io.Discard)
	var usage *usageError
	if !errors.As(err, &usage) || !strings.Contains(usage.message, "purge-sessions|reset-mfa|reset-root-mfa") {
		t.Fatalf("got %v", err)
	}
}

func TestTheFailureLineNamesReasonsAndInputsButNoValue(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{fmt.Errorf("wrapped: %w", &manifest.Rejection{Reason: "collision"}), "collision"},
		{offline.ErrUnknownRole, offline.ErrUnknownRole.Error()},
		{offline.ErrNotIAMAccount, offline.ErrNotIAMAccount.Error()},
		{offline.ErrNotRootAccount, offline.ErrNotRootAccount.Error()},
		{offline.ErrInvalidMFAReset, offline.ErrInvalidMFAReset.Error()},
		{offline.ErrInvalidPurge, offline.ErrInvalidPurge.Error()},
	} {
		if line := failureLine(tc.err); !strings.Contains(line, tc.want) {
			t.Errorf("%q lacks %q", line, tc.want)
		}
	}
	if line := failureLine(errors.New("leak@example.test")); strings.Contains(line, "leak") {
		t.Errorf("an unknown error is printed: %q", line)
	}
}

// Each refusal happens before any connection: the env is empty, so a later step would name a variable.
func TestInputsAreRefusedBeforeConnectingWithoutTheirValue(t *testing.T) {
	const email = "leak@example.test"
	enroll := map[string]string{"--user": fakeUser, "--email": email, "--issuer": "https://idp.fixture", "--role": "hr.employee"}
	reset := map[string]string{"--user": fakeUser, "--operation": fakeUser, "--approval": "ticket-1", "--reason": "lost phone"}
	for _, tc := range []struct {
		command string
		flags   map[string]string
		change  map[string]string
	}{
		{"enroll", enroll, map[string]string{"--user": strings.ToUpper(fakeUser)}},
		{"enroll", enroll, map[string]string{"--user": audit.OfflineActor}},
		{"enroll", enroll, map[string]string{"--user": "not-a-uuid"}},
		{"enroll", enroll, map[string]string{"--issuer": ""}},
		{"enroll", enroll, map[string]string{"--role": ""}},
		{"enroll", enroll, map[string]string{"--role": strings.Repeat("r", 97)}},
		{"enroll", enroll, map[string]string{"--email": "leak@example"}},
		{"enroll", enroll, map[string]string{"--email": ""}},
		{"enroll", enroll, map[string]string{"--email": "le" + string(rune(0xe4)) + "k@example.test"}},
		{"purge-sessions", map[string]string{"--retention-days": "3651"}, nil},
		{"purge-sessions", map[string]string{"--retention-days": "-1"}, nil},
		{"purge-sessions", map[string]string{"--retention-days": "12345"}, nil},
		{"purge-sessions", map[string]string{"--retention-days": "+7"}, nil},
		{"purge-sessions", map[string]string{}, nil},
		{"reset-mfa", reset, map[string]string{"--user": audit.OfflineActor}},
		{"reset-mfa", reset, map[string]string{"--operation": strings.ToUpper(fakeUser)}},
		{"reset-mfa", reset, map[string]string{"--approval": ""}},
		{"reset-mfa", reset, map[string]string{"--approval": email + "\n"}},
		{"reset-mfa", reset, map[string]string{"--reason": "   "}},
		{"reset-mfa", reset, map[string]string{"--reason": strings.Repeat("r", 1001)}},
		{"reset-root-mfa", reset, map[string]string{"--approval": strings.Repeat("a", 201)}},
		{"reset-root-mfa", reset, map[string]string{"--reason": email + "\x7f"}},
		{"reset-root-mfa", reset, map[string]string{"--user": "leak"}},
	} {
		flags := maps.Clone(tc.flags)
		maps.Copy(flags, tc.change)
		args := []string{tc.command}
		for key, value := range flags {
			if value != "" {
				args = append(args, key, value)
			}
		}
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			err := run(context.Background(), args, func(string) string { return "" }, io.Discard)
			if err == nil {
				t.Fatal("accepted")
			}
			line := failureLine(err)
			if strings.Contains(line, "DATABASE_URL") || strings.Contains(line, "@") || strings.Contains(line, "leak") {
				t.Fatalf("refused late or printed a value: %q", line)
			}
		})
	}
}

func TestLimitsCountUTF16UnitsAsTheTypeScriptCLI(t *testing.T) {
	face := string(rune(0x1f600))
	for _, tc := range []struct {
		approval, reason string
		valid            bool
	}{
		{strings.Repeat(face, 100), "lost phone", true},
		{strings.Repeat(face, 101), "lost phone", false},
		{"ticket-1", strings.Repeat("r", 1000), true},
		{"ticket-1", " " + string(rune(0xfeff)) + " ", false},
		{"ticket-1", string(rune(0x85)) + "lost", false},
		{"ticket-1", "lost\xff", false},
	} {
		args := []string{"reset-mfa", "--user", fakeUser, "--operation", fakeUser, "--approval", tc.approval, "--reason", tc.reason}
		err := run(context.Background(), args, func(string) string { return "" }, io.Discard)
		reached := strings.Contains(failureLine(err), "PRODUCT_IDENTITY_DATABASE_URL is required")
		if reached != tc.valid || !tc.valid && !errors.Is(err, offline.ErrInvalidMFAReset) {
			t.Errorf("%d/%d units: %v", len(tc.approval), len(tc.reason), err)
		}
	}
}

func TestAnInvalidConnectionURLIsNamedNotPrinted(t *testing.T) {
	env := map[string]string{"PRODUCT_IDENTITY_DATABASE_URL": "http://user:hunter2@host/db"}
	err := run(context.Background(), []string{"purge-sessions", "--retention-days", "7"}, func(name string) string { return env[name] }, io.Discard)
	line := failureLine(err)
	if !strings.Contains(line, "PRODUCT_IDENTITY_DATABASE_URL must be a PostgreSQL URL") || strings.Contains(line, "hunter2") {
		t.Fatalf("got %q", line)
	}
}
