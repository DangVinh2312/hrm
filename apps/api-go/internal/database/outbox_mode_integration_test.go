//go:build integration

package database_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/database"
)

func TestOutboxModeHasOnlyItsLoginAndNoFenceOrRevision(t *testing.T) {
	before := revision(t)
	var metrics []database.Metric
	proxy, runner := proxiedWith(t, database.PurposeOutbox, database.RunnerOptions{OnMetric: func(metric database.Metric, _ database.Mode, _ float64) { metrics = append(metrics, metric) }})
	var escaped *database.Tx
	got, err := database.Run(testContext(t), runner, database.ModeOutbox, func(_ context.Context, tx *database.Tx) (string, error) {
		if tx.Revision != "" || tx.Mode != database.ModeOutbox {
			t.Fatal("outbox acquired revision")
		}
		escaped = tx
		rows, err := tx.Query("SELECT current_user")
		if err != nil {
			return "", err
		}
		return pgx.CollectOneRow(rows, pgx.RowTo[string])
	}, database.RunOptions{})
	if err != nil || got != "product_outbox" {
		t.Fatalf("outbox login %s: %v", got, err)
	}
	want := []string{beginSQL, setTimeoutsSQL, "SELECT current_user", commitSQL}
	if !slices.Equal(proxy.Statements(), want) {
		t.Fatalf("statements %q", proxy.Statements())
	}
	if revision(t) != before {
		t.Fatal("outbox bumped revision")
	}
	for _, metric := range []database.Metric{database.MetricLockWait, database.MetricLockHold, database.MetricRevokeCommit} {
		if slices.Contains(metrics, metric) {
			t.Fatalf("outbox emitted %s", metric)
		}
	}
	for _, metric := range []database.Metric{database.MetricPoolWait, database.MetricTransaction} {
		if !slices.Contains(metrics, metric) {
			t.Fatalf("outbox lost %s metric", metric)
		}
	}
	if _, err := escaped.Exec("SELECT 1"); err == nil {
		t.Fatal("transaction survived callback")
	}
	settings, err := database.Run(testContext(t), runner, database.ModeOutbox, func(_ context.Context, tx *database.Tx) (string, error) {
		rows, err := tx.Query("SELECT current_setting('statement_timeout')||','||current_setting('transaction_timeout')||','||current_setting('lock_timeout')")
		if err != nil {
			return "", err
		}
		return pgx.CollectOneRow(rows, pgx.RowTo[string])
	}, database.RunOptions{})
	if err != nil || settings != "2s,2s,1s" {
		t.Fatalf("outbox timeouts %q %v", settings, err)
	}
	key := int64(1)
	if _, err := database.Run(testContext(t), runner, database.ModeOutbox, none(1), database.RunOptions{Serialize: &key}); !errors.Is(err, database.ErrInvalidRunner) {
		t.Fatalf("serialize accepted %v", err)
	}
	_, dataRunner := proxied(t, database.PurposeData)
	if _, err := database.Run(testContext(t), dataRunner, database.ModeOutbox, none(1), database.RunOptions{}); err == nil {
		t.Fatal("fell back to data login")
	}
}
