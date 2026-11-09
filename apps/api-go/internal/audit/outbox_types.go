package audit

import (
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"time"

	"hrm/api-go/internal/database"
)

var ErrInvalidOutbox = errors.New("audit: invalid outbox input")

type Envelope struct {
	EventID        string            `json:"eventId"`
	Kind           string            `json:"kind"`
	ActorID        string            `json:"actorId"`
	Permission     *string           `json:"permission"`
	ObjectID       *string           `json:"objectId"`
	PolicyRevision string            `json:"policyRevision"`
	OccurredAt     string            `json:"occurredAt"`
	Reason         *string           `json:"reason"`
	Metadata       map[string]string `json:"metadata"`
	Attempt        int               `json:"attempt"`
}

// Sink must honor cancellation and return only after durable acceptance; delivery can repeat EventID.
type Sink interface {
	Deliver(context.Context, Envelope) error
}

type OutboxOptions struct {
	BatchSize       int
	Lease           time.Duration
	MaxAttempts     int
	Backoff         time.Duration
	MaxBackoff      time.Duration
	DeliveryTimeout time.Duration
}

type Outbox struct {
	runner  *database.Runner
	options OutboxOptions
}

type OutboxClaim struct {
	Events    []Envelope
	Malformed []string
	Parked    int
	token     string
	ids       map[string]bool
}

type OutboxOutcome struct{ Delivered, Retried, Dead int }
type OutboxResult struct{ Claimed, Delivered, Retried, Dead int }

func NewOutbox(runner *database.Runner, options OutboxOptions) (*Outbox, error) {
	if options.BatchSize == 0 {
		options.BatchSize = 20
	}
	if options.MaxAttempts == 0 {
		options.MaxAttempts = 8
	}
	if options.Lease == 0 {
		options.Lease = 300 * time.Second
	}
	if options.Backoff == 0 {
		options.Backoff = time.Second
	}
	if options.MaxBackoff == 0 {
		options.MaxBackoff = 300 * time.Second
	}
	if options.DeliveryTimeout == 0 {
		options.DeliveryTimeout = 10 * time.Second
	}
	if runner == nil || options.BatchSize < 1 || options.BatchSize > 100 || options.MaxAttempts < 1 || options.MaxAttempts > 20 ||
		!outboxDuration(options.Lease, time.Second, time.Hour) || !outboxDuration(options.Backoff, time.Millisecond, time.Hour) ||
		!outboxDuration(options.MaxBackoff, options.Backoff, 24*time.Hour) || !outboxDuration(options.DeliveryTimeout, time.Millisecond, 600*time.Second) ||
		options.DeliveryTimeout*time.Duration(options.BatchSize) > options.Lease {
		return nil, ErrInvalidOutbox
	}
	return &Outbox{runner: runner, options: options}, nil
}

func outboxDuration(value, low, high time.Duration) bool {
	return value >= low && value <= high && value%time.Millisecond == 0
}

func outboxMetadata(raw []byte) (map[string]string, bool) {
	var fields map[string]jsontext.Value
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, false
	}
	metadata := make(map[string]string, len(fields))
	for key, value := range fields {
		var text string
		if len(value) == 0 || value[0] != '"' {
			return nil, false
		}
		if err := json.Unmarshal(value, &text); err != nil {
			return nil, false
		}
		metadata[key] = text
	}
	return metadata, true
}

func (c OutboxClaim) valid(done, failed []string) bool {
	if c.token == "" || len(c.ids) > 100 || len(done)+len(failed) > len(c.ids) {
		return false
	}
	seen := make(map[string]bool, len(done)+len(failed))
	for _, group := range [][]string{done, failed} {
		for _, id := range group {
			if !c.ids[id] || seen[id] {
				return false
			}
			seen[id] = true
		}
	}
	return true
}
