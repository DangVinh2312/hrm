package audit

import (
	"crypto/rand"
	"fmt"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/database"
)

const parkOutboxSQL = `WITH parked AS (UPDATE audit_outbox SET dead_at=statement_timestamp(),lease_token=NULL,lease_until=NULL
  WHERE event_id IN (SELECT event_id FROM audit_outbox
    WHERE delivered_at IS NULL AND dead_at IS NULL AND delivery_attempts>=$1
      AND (lease_until IS NULL OR lease_until<=statement_timestamp())
    ORDER BY occurred_at,event_id LIMIT $2 FOR UPDATE SKIP LOCKED)
  RETURNING 1) SELECT count(*)::int n FROM parked`

const claimOutboxSQL = `WITH claimable AS (SELECT event_id FROM audit_outbox
  WHERE delivered_at IS NULL AND dead_at IS NULL AND delivery_attempts<$4
    AND (lease_until IS NULL OR lease_until<=statement_timestamp())
  ORDER BY occurred_at,event_id LIMIT $1 FOR UPDATE SKIP LOCKED)
, claimed AS (UPDATE audit_outbox o SET lease_token=$2,lease_until=statement_timestamp()+make_interval(secs=>$3::float8/1000),delivery_attempts=o.delivery_attempts+1
FROM claimable c WHERE o.event_id=c.event_id
RETURNING o.event_id,convert_from(o.event_kind,'UTF8') kind,o.actor_id,convert_from(o.permission_key,'UTF8') permission,o.object_id,
  o.policy_revision::text policy_revision,to_char(o.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at,
  o.reason,o.safe_metadata,o.delivery_attempts,o.occurred_at sort_at)
SELECT event_id::text,kind,actor_id::text,permission,object_id::text,policy_revision,occurred_at,reason,safe_metadata,delivery_attempts FROM claimed ORDER BY sort_at,event_id`

const doneOutboxSQL = `WITH done AS (UPDATE audit_outbox SET delivered_at=statement_timestamp(),lease_token=NULL,lease_until=NULL
  WHERE event_id=ANY($1::uuid[]) AND lease_token=$2 AND delivered_at IS NULL RETURNING 1) SELECT count(*)::int n FROM done`

const failedOutboxSQL = `WITH failed AS (UPDATE audit_outbox SET lease_token=NULL,
  dead_at=CASE WHEN delivery_attempts>=$3 THEN statement_timestamp() END,
  lease_until=CASE WHEN delivery_attempts>=$3 THEN NULL
    ELSE statement_timestamp()+make_interval(secs=>LEAST($5::float8,$4::float8*power(2,delivery_attempts-1))/1000) END
  WHERE event_id=ANY($1::uuid[]) AND lease_token=$2 AND delivered_at IS NULL RETURNING dead_at IS NOT NULL dead)
SELECT dead FROM failed`

func outboxToken() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	raw[6] = raw[6]&15 | 64
	raw[8] = raw[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}

func claimOutbox(tx *database.Tx, options OutboxOptions, token string) (OutboxClaim, error) {
	claim := OutboxClaim{token: token, ids: make(map[string]bool)}
	rows, err := tx.Query(parkOutboxSQL, options.MaxAttempts, options.BatchSize)
	if err != nil {
		return OutboxClaim{}, err
	}
	parked, err := pgx.CollectOneRow(rows, pgx.RowTo[int])
	if err != nil {
		return OutboxClaim{}, err
	}
	claim.Parked = parked
	rows, err = tx.Query(claimOutboxSQL, options.BatchSize, token, options.Lease.Milliseconds(), options.MaxAttempts)
	if err != nil {
		return OutboxClaim{}, err
	}
	type storedEvent struct {
		envelope Envelope
		metadata []byte
	}
	events, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (storedEvent, error) {
		var stored storedEvent
		e := &stored.envelope
		err := row.Scan(&e.EventID, &e.Kind, &e.ActorID, &e.Permission, &e.ObjectID, &e.PolicyRevision, &e.OccurredAt, &e.Reason, &stored.metadata, &e.Attempt)
		return stored, err
	})
	if err != nil {
		return OutboxClaim{}, err
	}
	for _, stored := range events {
		e := stored.envelope
		claim.ids[e.EventID] = true
		metadata, ok := outboxMetadata(stored.metadata)
		if !ok {
			claim.Malformed = append(claim.Malformed, e.EventID)
			continue
		}
		e.Metadata = metadata
		claim.Events = append(claim.Events, e)
	}
	return claim, nil
}

func acknowledgeOutbox(tx *database.Tx, options OutboxOptions, token string, done, failed []string) (OutboxOutcome, error) {
	rows, err := tx.Query(doneOutboxSQL, done, token)
	if err != nil {
		return OutboxOutcome{}, err
	}
	delivered, err := pgx.CollectOneRow(rows, pgx.RowTo[int])
	if err != nil {
		return OutboxOutcome{}, err
	}
	rows, err = tx.Query(failedOutboxSQL, failed, token, options.MaxAttempts, options.Backoff.Milliseconds(), options.MaxBackoff.Milliseconds())
	if err != nil {
		return OutboxOutcome{}, err
	}
	dead, err := pgx.CollectRows(rows, pgx.RowTo[bool])
	if err != nil {
		return OutboxOutcome{}, err
	}
	outcome := OutboxOutcome{Delivered: delivered}
	for _, parked := range dead {
		if parked {
			outcome.Dead++
		} else {
			outcome.Retried++
		}
	}
	return outcome, nil
}
