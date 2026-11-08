package main

import (
	"errors"
	"log/slog"
	"strings"
	"testing"

	"hrm/api-go/internal/app"
)

func TestRunRefusesABadEnvironmentWithoutItsValues(t *testing.T) {
	const canary = "postgres://u:CANARY@h/d"
	err := run(t.Context(), []string{"NODE_ENV=test", "PRODUCT_DATA_DATABASE_URL=" + canary, "DATABASE_ADMIN_URL=" + canary})
	if err == nil {
		t.Fatal("booted")
	}
	line := failureLine(err)
	if !strings.Contains(line, "DATABASE_ADMIN_URL") || strings.Contains(line, "CANARY") {
		t.Errorf("%s", line)
	}
}

func TestFailureLineHoldsNoDriverText(t *testing.T) {
	const canary = "CANARY"
	for name, c := range map[string]struct {
		err  error
		want string
	}{
		"plain":    {errors.New(canary), "Application startup failed"},
		"step":     {&app.BootError{Step: "pools", Err: errors.New(canary)}, "Application startup failed: boot step failed: pools"},
		"shutdown": {&app.ShutdownError{Err: errors.New(canary)}, "Application shutdown failed"},
	} {
		if line := failureLine(c.err); line != c.want {
			t.Errorf("%s: %s", name, line)
		}
	}
}

func TestLogLevelFollowsLogLevel(t *testing.T) {
	for _, c := range []struct {
		levels []string
		want   slog.Level
	}{
		{[]string{"fatal", "error"}, slog.LevelError},
		{[]string{"fatal", "error", "warn"}, slog.LevelWarn},
		{[]string{"fatal", "error", "warn", "log"}, slog.LevelInfo},
		{[]string{"fatal", "error", "warn", "log", "debug"}, slog.LevelDebug},
	} {
		if got := logLevel(c.levels); got != c.want {
			t.Errorf("%v: %v", c.levels, got)
		}
	}
}
