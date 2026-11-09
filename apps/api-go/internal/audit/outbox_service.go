package audit

import (
	"context"

	"hrm/api-go/internal/database"
)

func (o *Outbox) Claim(ctx context.Context) (OutboxClaim, error) {
	if err := ctx.Err(); err != nil {
		return OutboxClaim{}, err
	}
	token := outboxToken()
	return database.Run(ctx, o.runner, database.ModeOutbox, func(_ context.Context, tx *database.Tx) (OutboxClaim, error) {
		return claimOutbox(tx, o.options, token)
	}, database.RunOptions{})
}

func (o *Outbox) Acknowledge(ctx context.Context, claim OutboxClaim, done, failed []string) (OutboxOutcome, error) {
	if !claim.valid(done, failed) {
		return OutboxOutcome{}, ErrInvalidOutbox
	}
	return database.Run(ctx, o.runner, database.ModeOutbox, func(_ context.Context, tx *database.Tx) (OutboxOutcome, error) {
		return acknowledgeOutbox(tx, o.options, claim.token, done, failed)
	}, database.RunOptions{})
}

func (o *Outbox) Deliver(ctx context.Context, sink Sink) (OutboxResult, error) {
	if sink == nil {
		return OutboxResult{}, ErrInvalidOutbox
	}
	claim, err := o.Claim(ctx)
	if err != nil {
		return OutboxResult{}, err
	}
	result := OutboxResult{Claimed: len(claim.Events) + len(claim.Malformed), Dead: claim.Parked}
	if result.Claimed == 0 {
		return result, nil
	}
	done := make([]string, 0, len(claim.Events))
	failed := append([]string{}, claim.Malformed...)
	for _, event := range claim.Events {
		delivery, cancel := context.WithTimeout(ctx, o.options.DeliveryTimeout)
		err := sink.Deliver(delivery, event)
		if err == nil {
			err = delivery.Err()
		}
		cancel()
		if err != nil {
			failed = append(failed, event.EventID)
		} else {
			done = append(done, event.EventID)
		}
		if ctx.Err() != nil {
			break
		}
	}
	outcome, err := o.Acknowledge(ctx, claim, done, failed)
	if err != nil {
		return result, err
	}
	result.Delivered = outcome.Delivered
	result.Retried = outcome.Retried
	result.Dead += outcome.Dead
	return result, ctx.Err()
}
