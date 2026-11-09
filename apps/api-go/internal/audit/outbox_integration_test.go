//go:build integration

package audit_test

import (
	"context"
	"errors"
	"reflect"
	"regexp"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

type fixtureSink func(context.Context, audit.Envelope) error

func (f fixtureSink) Deliver(ctx context.Context, event audit.Envelope) error { return f(ctx, event) }

func deliveryFixture(t *testing.T, count int, options audit.OutboxOptions) (*test.Stack, *pgx.Conn, *audit.Outbox) {
	t.Helper()
	s := test.NewDatabase(t)
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	if _, err := conn.Exec(t.Context(), "DELETE FROM audit_outbox"); err != nil {
		t.Fatal(test.Redact(err))
	}
	for range count {
		if _, err := appendIn(t, s, database.ModeIdentity, audit.Event{Kind: audit.KindOIDCLogin, Actor: audit.OfflineActor}, nil); err != nil {
			t.Fatal(test.Redact(err))
		}
	}
	runner, err := database.NewRunner(database.Pools{database.PurposeOutbox: s.Pools[database.PurposeOutbox]}, database.RunnerOptions{Deadline: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	o, err := audit.NewOutbox(runner, options)
	if err != nil {
		t.Fatal(err)
	}
	return s, conn, o
}

func expireOutbox(t *testing.T, conn *pgx.Conn) {
	t.Helper()
	if _, err := conn.Exec(t.Context(), "UPDATE audit_outbox SET lease_until=statement_timestamp()-interval '1 second' WHERE lease_until IS NOT NULL"); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func claimOutbox(t *testing.T, o *audit.Outbox) audit.OutboxClaim {
	t.Helper()
	c, err := o.Claim(t.Context())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return c
}

func TestOutboxDeliveryEnvelopeAndNoOpenTransactionOrFence(t *testing.T) {
	s, conn, o := deliveryFixture(t, 1, audit.OutboxOptions{})
	var events []audit.Envelope
	result, err := o.Deliver(t.Context(), fixtureSink(func(ctx context.Context, e audit.Envelope) error {
		events = append(events, e)
		var open int
		if err := conn.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE usename='product_outbox' AND xact_start IS NOT NULL").Scan(&open); err != nil {
			t.Fatal(test.Redact(err))
		}
		if open != 0 {
			t.Fatal("delivery retained transaction")
		}
		_, err := database.Run(ctx, s.Runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			_, err := tx.Exec("SELECT 1")
			return struct{}{}, err
		}, database.RunOptions{})
		return err
	}))
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if result != (audit.OutboxResult{Claimed: 1, Delivered: 1}) || len(events) != 1 {
		t.Fatalf("result %+v events %d", result, len(events))
	}
	e := events[0]
	if e.Kind != "identity.oidc-login" || e.ActorID != audit.OfflineActor || e.Attempt != 1 || e.Permission != nil || e.ObjectID != nil || e.Reason != nil || e.Metadata["resultingRevision"] != e.PolicyRevision || !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$`).MatchString(e.OccurredAt) {
		t.Fatalf("invalid envelope %+v", e)
	}
	result, err = o.Deliver(t.Context(), fixtureSink(func(context.Context, audit.Envelope) error { t.Fatal("duplicate delivery"); return nil }))
	if err != nil || result != (audit.OutboxResult{}) {
		t.Fatalf("second result %+v %s", result, test.Redact(err))
	}
}

func TestOutboxCrashRedeliveryAndStaleAcknowledgement(t *testing.T) {
	_, conn, o := deliveryFixture(t, 1, audit.OutboxOptions{})
	first := claimOutbox(t, o)
	if len(first.Events) != 1 || len(claimOutbox(t, o).Events) != 0 {
		t.Fatal("live lease reclaimed")
	}
	id := first.Events[0].EventID
	expireOutbox(t, conn)
	second := claimOutbox(t, o)
	if len(second.Events) != 1 || second.Events[0].EventID != id || second.Events[0].Attempt != 2 {
		t.Fatal("crash event lost")
	}
	for _, failed := range []bool{false, true} {
		var done, retry []string
		if failed {
			retry = []string{id}
		} else {
			done = []string{id}
		}
		got, err := o.Acknowledge(t.Context(), first, done, retry)
		if err != nil || got != (audit.OutboxOutcome{}) {
			t.Fatalf("stale ack %+v %s", got, test.Redact(err))
		}
	}
	got, err := o.Acknowledge(t.Context(), second, []string{id}, nil)
	if err != nil || got.Delivered != 1 {
		t.Fatalf("current ack %+v %s", got, test.Redact(err))
	}
	got, err = o.Acknowledge(t.Context(), second, []string{id}, nil)
	if err != nil || got.Delivered != 0 {
		t.Fatal("duplicate success")
	}
}

func TestOutboxPoisonRetryBackoffCapAndPark(t *testing.T) {
	_, conn, o := deliveryFixture(t, 2, audit.OutboxOptions{MaxAttempts: 3, Backoff: time.Second, MaxBackoff: 1500 * time.Millisecond})
	var poison string
	if err := conn.QueryRow(t.Context(), "UPDATE audit_outbox SET safe_metadata='{\"n\":1}' WHERE event_id=(SELECT event_id FROM audit_outbox ORDER BY occurred_at,event_id LIMIT 1) RETURNING event_id::text").Scan(&poison); err != nil {
		t.Fatal(test.Redact(err))
	}
	sends := 0
	sink := fixtureSink(func(context.Context, audit.Envelope) error { sends++; return nil })
	for attempt := 1; attempt <= 3; attempt++ {
		got, err := o.Deliver(t.Context(), sink)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		want := audit.OutboxResult{Claimed: 1, Retried: 1}
		if attempt == 1 {
			want.Claimed = 2
			want.Delivered = 1
		}
		if attempt == 3 {
			want.Retried = 0
			want.Dead = 1
		}
		if got != want {
			t.Fatalf("attempt %d: %+v want %+v", attempt, got, want)
		}
		if attempt < 3 {
			var ms float64
			if err := conn.QueryRow(t.Context(), "SELECT extract(epoch FROM lease_until-statement_timestamp())*1000 FROM audit_outbox WHERE event_id=$1", poison).Scan(&ms); err != nil {
				t.Fatal(test.Redact(err))
			}
			capMS := 1000.0
			if attempt == 2 {
				capMS = 1500
			}
			if ms <= capMS-500 || ms > capMS {
				t.Fatalf("attempt %d backoff %f", attempt, ms)
			}
			if len(claimOutbox(t, o).Events) != 0 {
				t.Fatal("backoff ignored")
			}
		}
		expireOutbox(t, conn)
	}
	if sends != 1 {
		t.Fatalf("poison sent %d times", sends-1)
	}
	if got, err := o.Deliver(t.Context(), sink); err != nil || got != (audit.OutboxResult{}) {
		t.Fatalf("park reclaimed %+v", got)
	}
}

func TestOutboxCrashAtFinalAttemptParksWithoutSending(t *testing.T) {
	_, conn, o := deliveryFixture(t, 1, audit.OutboxOptions{MaxAttempts: 2})
	for range 2 {
		if len(claimOutbox(t, o).Events) != 1 {
			t.Fatal("missing attempt")
		}
		expireOutbox(t, conn)
	}
	got, err := o.Deliver(t.Context(), fixtureSink(func(context.Context, audit.Envelope) error { t.Fatal("parked event sent"); return nil }))
	if err != nil || got != (audit.OutboxResult{Dead: 1}) {
		t.Fatalf("park %+v %s", got, test.Redact(err))
	}
}

func TestOutboxSinkTimeoutFailureAndCancellation(t *testing.T) {
	_, _, o := deliveryFixture(t, 1, audit.OutboxOptions{DeliveryTimeout: time.Millisecond, MaxAttempts: 2})
	got, err := o.Deliver(t.Context(), fixtureSink(func(ctx context.Context, _ audit.Envelope) error { <-ctx.Done(); return ctx.Err() }))
	if err != nil || got != (audit.OutboxResult{Claimed: 1, Retried: 1}) {
		t.Fatalf("timeout %+v %s", got, test.Redact(err))
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := o.Deliver(ctx, fixtureSink(func(context.Context, audit.Envelope) error { t.Fatal("cancelled delivery"); return nil })); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation %s", test.Redact(err))
	}
}

func TestOutboxAcknowledgementRejectsInventedOrRepeatedIDs(t *testing.T) {
	_, _, o := deliveryFixture(t, 1, audit.OutboxOptions{})
	c := claimOutbox(t, o)
	id := c.Events[0].EventID
	for _, v := range []struct {
		claim        audit.OutboxClaim
		done, failed []string
	}{
		{audit.OutboxClaim{}, nil, nil}, {c, []string{audit.OfflineActor}, nil}, {c, []string{id, id}, nil}, {c, []string{id}, []string{id}},
	} {
		if _, err := o.Acknowledge(t.Context(), v.claim, v.done, v.failed); !errors.Is(err, audit.ErrInvalidOutbox) {
			t.Fatal("invalid acknowledgement accepted")
		}
	}
	got, err := o.Acknowledge(t.Context(), c, []string{id}, nil)
	if err != nil || !reflect.DeepEqual(got, audit.OutboxOutcome{Delivered: 1}) {
		t.Fatal("valid claim damaged")
	}
}

func TestOutboxCancellationStopsBatchAndLeavesUnsentLeaseRecoverable(t *testing.T) {
	_, conn, o := deliveryFixture(t, 2, audit.OutboxOptions{MaxAttempts: 1})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sends := 0
	got, err := o.Deliver(ctx, fixtureSink(func(context.Context, audit.Envelope) error { sends++; cancel(); return nil }))
	if !errors.Is(err, context.Canceled) || sends != 1 || got != (audit.OutboxResult{Claimed: 2, Dead: 1}) {
		t.Fatalf("cancel result %+v sends %d error %s", got, sends, test.Redact(err))
	}
	expireOutbox(t, conn)
	claim := claimOutbox(t, o)
	if len(claim.Events) != 0 || claim.Parked != 1 {
		t.Fatal("unsent final-attempt lease not parked after expiry")
	}
}

func TestOutboxSinkNilAfterDeadlineIsStillFailure(t *testing.T) {
	_, _, o := deliveryFixture(t, 1, audit.OutboxOptions{DeliveryTimeout: time.Millisecond, MaxAttempts: 1})
	got, err := o.Deliver(t.Context(), fixtureSink(func(ctx context.Context, _ audit.Envelope) error { <-ctx.Done(); return nil }))
	if err != nil || got != (audit.OutboxResult{Claimed: 1, Dead: 1}) {
		t.Fatalf("late nil %+v %s", got, test.Redact(err))
	}
}
