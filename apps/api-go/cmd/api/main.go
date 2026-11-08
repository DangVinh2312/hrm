// Command api serves HTTP. Its output never holds a secret or a driver message.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"

	"hrm/api-go/internal/app"
	"hrm/api-go/internal/config"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	err := run(ctx, os.Environ())
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, failureLine(err))
		os.Exit(1)
	}
}

func run(ctx context.Context, environ []string) error {
	env := make(map[string]string, len(environ))
	for _, entry := range environ {
		if name, value, found := strings.Cut(entry, "="); found {
			env[name] = value
		}
	}
	cfg, err := config.Load(env)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel(cfg.LogLevels)}))
	return app.Run(ctx, cfg, logger)
}

func logLevel(levels []string) slog.Level {
	switch {
	case slices.Contains(levels, "debug"):
		return slog.LevelDebug
	case slices.Contains(levels, "log"):
		return slog.LevelInfo
	case slices.Contains(levels, "warn"):
		return slog.LevelWarn
	}
	return slog.LevelError
}

// failureLine prints only what names variables, steps or routes.
func failureLine(err error) string {
	if configuration, ok := errors.AsType[*config.ConfigError](err); ok {
		return configuration.Error()
	}
	if step, ok := errors.AsType[*app.BootError](err); ok {
		return "Application startup failed: " + step.Error()
	}
	if _, ok := errors.AsType[*app.ShutdownError](err); ok {
		return "Application shutdown failed"
	}
	return "Application startup failed"
}
