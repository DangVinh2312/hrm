package main

import (
	"context"
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/database"
)

func TestTheActivationFileIsNewPrivateAndKeptOnlyWithASecret(t *testing.T) {
	dir := t.TempDir()
	failed := errors.New("work failed")
	for _, tc := range []struct {
		name   string
		secret string
		err    error
	}{
		{"committed", "proof", nil},
		{"nothing committed", "", nil},
		{"refused", "", failed},
		{"refused after a secret", "proof", failed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name := filepath.Join(dir, strings.ReplaceAll(tc.name, " ", "-"))
			err := withActivationFile(name, func() (string, error) {
				if _, err := os.Stat(name); err != nil {
					t.Errorf("the file is not reserved before the work: %v", err)
				}
				return tc.secret, tc.err
			})
			if !errors.Is(err, tc.err) {
				t.Fatalf("got %v, want %v", err, tc.err)
			}
			info, statErr := os.Stat(name)
			if tc.secret == "" || tc.err != nil {
				if !errors.Is(statErr, os.ErrNotExist) {
					t.Fatalf("the file is left: %v", statErr)
				}
				return
			}
			content, readErr := os.ReadFile(name)
			if statErr != nil || readErr != nil || info.Mode().Perm() != 0o600 || string(content) != tc.secret+"\n" {
				t.Fatalf("mode %v, %d bytes, %v %v", info.Mode().Perm(), len(content), statErr, readErr)
			}
		})
	}
}

func TestAnExistingActivationFileIsRefusedBeforeTheWork(t *testing.T) {
	name := filepath.Join(t.TempDir(), "old")
	if err := os.WriteFile(name, []byte("old proof\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := withActivationFile(name, func() (string, error) {
		t.Error("the work ran")
		return "new proof", nil
	})
	var usage *usageError
	if !errors.As(err, &usage) || strings.Contains(failureLine(err), name) {
		t.Fatalf("got %v", err)
	}
	if content, err := os.ReadFile(name); err != nil || string(content) != "old proof\n" {
		t.Fatalf("the old file changed: %v", err)
	}
	if err := withActivationFile("", func() (string, error) { return "", nil }); !errors.As(err, &usage) {
		t.Fatalf("no file: %v", err)
	}
}

func TestTheFailureLineNamesTheCodeOfADatabaseFailure(t *testing.T) {
	for _, err := range []error{&database.UnavailableError{Code: "deadline"}, &database.ConflictError{Code: "40001"}} {
		var unavailable *database.UnavailableError
		want := "40001"
		if errors.As(err, &unavailable) {
			want = "deadline"
		}
		if line := failureLine(err); !strings.Contains(line, " "+want+";") {
			t.Errorf("%q lacks %q", line, want)
		}
	}
}

// Each refusal happens before any connection and before the activation file is created.
func TestRootInputsAreRefusedBeforeConnectingOrCreatingTheFile(t *testing.T) {
	const email = "leak@example.test"
	dir := t.TempDir()
	file := filepath.Join(dir, "activation")
	boot := map[string]string{"--operation": fakeUser, "--issuer": "https://idp.fixture", "--email": email, "--activation-file": file}
	revoke := map[string]string{"--user": fakeUser, "--operation": fakeUser, "--approval": "ticket-1", "--reason": "left"}
	setEmail := map[string]string{"--user": fakeUser, "--operation": fakeUser, "--email": email}
	for _, tc := range []struct {
		command string
		flags   map[string]string
		change  map[string]string
		reason  string
	}{
		{"bootstrap", boot, map[string]string{"--operation": strings.ToUpper(fakeUser)}, ""},
		{"bootstrap", boot, map[string]string{"--operation": ""}, ""},
		{"bootstrap", boot, map[string]string{"--issuer": ""}, ""},
		{"bootstrap", boot, map[string]string{"--email": ""}, ""},
		{"bootstrap", boot, map[string]string{"--email": "leak@example"}, "invalid_release"},
		{"bootstrap", boot, map[string]string{"--activation-file": ""}, ""},
		{"reissue-root", map[string]string{"--issuer": "https://idp.fixture"}, nil, ""},
		{"reissue-root", map[string]string{"--activation-file": file}, nil, ""},
		{"revoke-root", revoke, map[string]string{"--user": "leak"}, ""},
		{"revoke-root", revoke, map[string]string{"--operation": strings.ToUpper(fakeUser)}, ""},
		{"revoke-root", revoke, map[string]string{"--approval": ""}, ""},
		{"revoke-root", revoke, map[string]string{"--reason": ""}, ""},
		{"revoke-root", revoke, map[string]string{"--approval": email + "\n"}, "invalid_release"},
		{"revoke-root", revoke, map[string]string{"--reason": "   "}, "invalid_release"},
		{"revoke-root", revoke, map[string]string{"--reason": strings.Repeat("r", 1001)}, "invalid_release"},
		{"set-root-email", setEmail, map[string]string{"--user": audit.OfflineActor}, "invalid_release"},
		{"set-root-email", setEmail, map[string]string{"--email": ""}, ""},
		{"set-root-email", setEmail, map[string]string{"--email": "le" + string(rune(0xe4)) + "k@example.test"}, "invalid_release"},
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
			var rejection *manifest.Rejection
			if tc.reason != "" && (!errors.As(err, &rejection) || rejection.Reason != tc.reason) {
				t.Fatalf("got %v, want %s", err, tc.reason)
			}
			line := failureLine(err)
			if strings.Contains(line, "DATABASE_URL") || strings.Contains(line, "@") || strings.Contains(line, "leak") {
				t.Fatalf("refused late or printed a value: %q", line)
			}
			if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("the activation file was created: %v", err)
			}
		})
	}
}

// A valid bootstrap reserves the file, then fails on the missing URL and removes the file.
func TestAFailedConnectionLeavesNoActivationFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "activation")
	for _, args := range [][]string{
		{"bootstrap", "--operation", fakeUser, "--issuer", "https://idp.fixture", "--email", "leak@example.test", "--activation-file", file},
		{"reissue-root", "--issuer", "https://idp.fixture", "--activation-file", file},
	} {
		err := run(context.Background(), args, func(string) string { return "" }, io.Discard)
		if !strings.Contains(failureLine(err), bootstrapURL+" is required") {
			t.Fatalf("%s: got %q", args[0], failureLine(err))
		}
		if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s: the activation file is left: %v", args[0], err)
		}
	}
}
