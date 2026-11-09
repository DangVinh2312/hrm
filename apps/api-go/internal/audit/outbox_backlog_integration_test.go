//go:build integration

package audit_test

import (
	"testing"

	"hrm/api-go/internal/audit"
	"hrm/api-go/test"
)

func TestOutboxParkingIsBoundedAndHealthyClaimProgresses(t *testing.T) {
	_, conn, o := deliveryFixture(t, 6, audit.OutboxOptions{BatchSize: 2, MaxAttempts: 2})
	if _, err := conn.Exec(t.Context(), `UPDATE audit_outbox SET delivery_attempts=2,lease_until=statement_timestamp()-interval '1 second'
WHERE event_id IN (SELECT event_id FROM audit_outbox ORDER BY occurred_at,event_id LIMIT 5)`); err != nil {
		t.Fatal(test.Redact(err))
	}
	first := claimOutbox(t, o)
	if first.Parked != 2 || len(first.Events) != 1 || first.Events[0].Attempt != 1 {
		t.Fatalf("first batch parked %d healthy %d, want 2 and 1", first.Parked, len(first.Events))
	}
	var oldestParked bool
	if err := conn.QueryRow(t.Context(), `SELECT bool_and(dead_at IS NOT NULL) FROM
(SELECT dead_at FROM audit_outbox ORDER BY occurred_at,event_id LIMIT 2) oldest`).Scan(&oldestParked); err != nil {
		t.Fatal(test.Redact(err))
	}
	if !oldestParked {
		t.Fatal("oldest expired events were not parked first")
	}
	for _, want := range []int{2, 1, 0} {
		claim := claimOutbox(t, o)
		if claim.Parked != want || len(claim.Events) != 0 {
			t.Fatalf("next batch parked %d healthy %d, want %d and 0", claim.Parked, len(claim.Events), want)
		}
	}
	var dead, pending int
	if err := conn.QueryRow(t.Context(), "SELECT count(*) FILTER (WHERE dead_at IS NOT NULL),count(*) FILTER (WHERE delivery_attempts>=2 AND dead_at IS NULL) FROM audit_outbox").Scan(&dead, &pending); err != nil {
		t.Fatal(test.Redact(err))
	}
	if dead != 5 || pending != 0 {
		t.Fatalf("backlog dead %d pending %d", dead, pending)
	}
	got, err := o.Acknowledge(t.Context(), first, []string{first.Events[0].EventID}, nil)
	if err != nil || got.Delivered != 1 {
		t.Fatalf("healthy acknowledgement %+v %s", got, test.Redact(err))
	}
}
