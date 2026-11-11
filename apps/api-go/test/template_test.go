package test_test

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/testcontainers/testcontainers-go/wait"

	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

func TestRedactKeepsTheCodeAndDropsTheText(t *testing.T) {
	for err, want := range map[error]string{
		&database.UnavailableError{Code: "deadline"}:                             "*database.UnavailableError deadline",
		fmt.Errorf("CANARY: %w", &database.UnavailableError{Code: "connection"}): "*database.UnavailableError connection",
		&pgconn.PgError{Code: "57P03", Message: "CANARY"}:                        "SQLSTATE 57P03",
		errors.New("CANARY"): "*errors.errorString",
	} {
		if got := test.Redact(err); got != want {
			t.Errorf("%s, want %s", got, want)
		}
	}
}

// ForAll(...).WithDeadline only caps the strategies: each one still stops at its own default of 60 s.
func TestEveryWaitOfThePostgresContainerGetsTheWholeStartup(t *testing.T) {
	strategies := test.PostgresReady()
	if len(strategies) == 0 {
		t.Fatal("no strategy")
	}
	for _, strategy := range strategies {
		timed, ok := strategy.(wait.StrategyTimeout)
		if !ok {
			t.Fatalf("%T has no timeout", strategy)
		}
		if got := timed.Timeout(); got == nil || *got != test.ContainerStartup {
			t.Errorf("%T: %v", strategy, got)
		}
	}
}

// countedLogs keeps what a helper logs for its caller.
type countedLogs struct {
	testing.TB
	lines []string
}

func (l *countedLogs) Logf(format string, args ...any) {
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func listen(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
	})
	return listener
}

func poolsAt(address string) map[database.Purpose]string {
	return map[database.Purpose]string{database.PurposeData: "postgres://product_data:CANARY@" + address + "/product"}
}

func TestOpeningPoolsStopsAtTheDeadlineAndSaysWhy(t *testing.T) {
	logs := &countedLogs{TB: t}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	_, err := test.OpenPoolsWaiting(ctx, logs, poolsAt(listen(t).Addr().String()))
	if err == nil {
		t.Fatal("opened")
	}
	if !strings.Contains(err.Error(), "attempts in") || !strings.Contains(err.Error(), "*database.UnavailableError") {
		t.Errorf("%v", err)
	}
	if len(logs.lines) == 0 || strings.Contains(err.Error()+strings.Join(logs.lines, ""), "CANARY") {
		t.Errorf("%v, %q", err, logs.lines)
	}
}

func TestOpeningPoolsDoesNotRetryWhatTheServerRefused(t *testing.T) {
	listener := listen(t)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			startup := make([]byte, 512)
			if _, err := connection.Read(startup); err != nil {
				t.Error(err)
			}
			fields := "SFATAL\x00C28P01\x00MCANARY\x00\x00"
			refusal := append([]byte{'E'}, binary.BigEndian.AppendUint32(nil, uint32(len(fields)+4))...)
			if _, err := connection.Write(append(refusal, fields...)); err != nil {
				t.Error(err)
			}
			if err := connection.Close(); err != nil {
				t.Error(err)
			}
		}
	}()
	logs := &countedLogs{TB: t}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	_, err := test.OpenPoolsWaiting(ctx, logs, poolsAt(listener.Addr().String()))
	if err == nil || !strings.Contains(err.Error(), "28P01") || strings.Contains(err.Error(), "CANARY") {
		t.Errorf("%v", err)
	}
	if len(logs.lines) != 1 {
		t.Errorf("%q", logs.lines)
	}
}
