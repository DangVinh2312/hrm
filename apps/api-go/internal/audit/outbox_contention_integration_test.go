//go:build integration

package audit_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

func TestOutboxSkipsLockedRowsAndIndependentWorkersOwnDisjointBatches(t *testing.T) {
	s, conn, first := deliveryFixture(t, 6, audit.OutboxOptions{BatchSize: 3})
	locked, err := conn.Begin(t.Context())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := locked.Rollback(context.WithoutCancel(t.Context())); err != nil && err != pgx.ErrTxClosed {
			t.Error(test.Redact(err))
		}
	}()
	var lockedID string
	if err := locked.QueryRow(t.Context(), "SELECT event_id::text FROM audit_outbox ORDER BY occurred_at,event_id LIMIT 1 FOR UPDATE").Scan(&lockedID); err != nil {
		t.Fatal(test.Redact(err))
	}
	secondPools, err := database.OpenPools(t.Context(), map[database.Purpose]string{database.PurposeOutbox: s.LoginURL("outbox")}, database.TLSDisabled)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer secondPools.Close()
	runner, err := database.NewRunner(secondPools, database.RunnerOptions{Deadline: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	second, err := audit.NewOutbox(runner, audit.OutboxOptions{BatchSize: 3})
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		claim audit.OutboxClaim
		err   error
	}
	results := make(chan result, 2)
	for _, worker := range []*audit.Outbox{first, second} {
		go func() { c, err := worker.Claim(t.Context()); results <- result{c, err} }()
	}
	var ids []string
	for range 2 {
		r := <-results
		if r.err != nil {
			t.Fatal(test.Redact(r.err))
		}
		for _, e := range r.claim.Events {
			if e.EventID == lockedID || slices.Contains(ids, e.EventID) {
				t.Fatal("locked or duplicate event claimed")
			}
			ids = append(ids, e.EventID)
		}
	}
	if len(ids) != 5 {
		t.Fatalf("claimed %d unlocked events, want 5", len(ids))
	}
	if err := locked.Commit(t.Context()); err != nil {
		t.Fatal(test.Redact(err))
	}
	c := claimOutbox(t, first)
	if len(c.Events) != 1 || c.Events[0].EventID != lockedID {
		t.Fatal("unlocked row not claimable")
	}
}

func TestOutboxSinkFailureDoesNotBlockHealthyEvents(t *testing.T) {
	_, conn, o := deliveryFixture(t, 2, audit.OutboxOptions{MaxAttempts: 2, Backoff: time.Millisecond})
	var poison string
	if err := conn.QueryRow(t.Context(), "SELECT event_id::text FROM audit_outbox ORDER BY occurred_at,event_id LIMIT 1").Scan(&poison); err != nil {
		t.Fatal(test.Redact(err))
	}
	var sent []string
	sink := fixtureSink(func(_ context.Context, e audit.Envelope) error {
		sent = append(sent, e.EventID)
		if e.EventID == poison {
			return context.DeadlineExceeded
		}
		return nil
	})
	got, err := o.Deliver(t.Context(), sink)
	if err != nil || got != (audit.OutboxResult{Claimed: 2, Delivered: 1, Retried: 1}) {
		t.Fatalf("delivery %+v %s", got, test.Redact(err))
	}
	expireOutbox(t, conn)
	got, err = o.Deliver(t.Context(), sink)
	if err != nil || got != (audit.OutboxResult{Claimed: 1, Dead: 1}) || len(sent) != 3 {
		t.Fatalf("retry %+v sends %d %s", got, len(sent), test.Redact(err))
	}
}
