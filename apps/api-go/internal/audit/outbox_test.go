package audit

import (
	"errors"
	"testing"
	"time"

	"hrm/api-go/internal/database"
)

func TestOutboxOptionsBoundEveryResource(t *testing.T) {
	runner, err := database.NewRunner(nil, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, options := range []OutboxOptions{
		{BatchSize: -1}, {BatchSize: 101}, {MaxAttempts: -1}, {MaxAttempts: 21},
		{Lease: 999 * time.Millisecond}, {Lease: time.Hour + time.Millisecond},
		{Backoff: -1}, {MaxBackoff: 24*time.Hour + time.Millisecond},
		{Backoff: time.Second, MaxBackoff: time.Millisecond},
		{DeliveryTimeout: 601 * time.Second}, {DeliveryTimeout: -1},
		{BatchSize: 10, Lease: time.Second, DeliveryTimeout: 200 * time.Millisecond},
		{DeliveryTimeout: time.Nanosecond},
	} {
		if _, err := NewOutbox(runner, options); !errors.Is(err, ErrInvalidOutbox) {
			t.Errorf("accepted %+v", options)
		}
	}
	if _, err := NewOutbox(nil, OutboxOptions{}); !errors.Is(err, ErrInvalidOutbox) {
		t.Fatal("nil runner accepted")
	}
	if _, err := NewOutbox(runner, OutboxOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestOutboxMetadataRejectsNonStringValues(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"n":1}`, `{"n":null}`, `{"n":{}}`, `{"n":true}`} {
		if _, ok := outboxMetadata([]byte(raw)); ok {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, raw := range []string{`{}`, `{"resultingRevision":"9007199254740993"}`} {
		if _, ok := outboxMetadata([]byte(raw)); !ok {
			t.Errorf("rejected %s", raw)
		}
	}
}

func TestOutboxTransactionCannotAppendAudit(t *testing.T) {
	for _, event := range []Event{
		{Kind: KindOIDCLogin, Actor: OfflineActor},
		{Kind: "access.document.read", Actor: OfflineActor, Detail: Access{Permission: "document.read"}},
	} {
		if _, err := describe(&database.Tx{Mode: database.ModeOutbox, Revision: "1"}, event); !errors.Is(err, ErrInvalidEvent) {
			t.Fatal("outbox accepted writer")
		}
	}
}
