package offline

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/database"
)

const (
	maxRetentionDays = 3650
	maxPurgeBatch    = 1000

	purgeSessions = `WITH purged AS (DELETE FROM application_session WHERE token_hash IN (
        SELECT token_hash FROM application_session WHERE expires_at<=statement_timestamp()-make_interval(days=>$1)
        ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING 1)
      SELECT count(*)::int n FROM purged`
)

// ErrInvalidPurge is a retention outside 0-3650 days or a batch outside 1-1000 sessions.
var ErrInvalidPurge = errors.New("retention must be 0-3650 days and batch 1-1000 sessions")

// PurgeExpiredSessions deletes at most batchSize sessions whose absolute expiry passed more than
// retentionDays ago, with its audit event, in one short identity transaction. Rows locked by live identity
// transactions are skipped, never waited for. An expired session grants nothing, so the purge has no
// authority effect.
func PurgeExpiredSessions(ctx context.Context, runner *database.Runner, retentionDays, batchSize int) (int, error) {
	if retentionDays < 0 || retentionDays > maxRetentionDays || batchSize < 1 || batchSize > maxPurgeBatch {
		return 0, ErrInvalidPurge
	}
	return database.Run(ctx, runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (int, error) {
		rows, err := tx.Query(purgeSessions, retentionDays, batchSize)
		if err != nil {
			return 0, err
		}
		deleted, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[int32])
		if err != nil || deleted == 0 {
			return 0, err
		}
		event := audit.Event{Kind: audit.KindSessionPurge, Actor: audit.OfflineActor, Purge: &audit.SessionPurge{
			Deleted: int(deleted), RetentionDays: retentionDays,
		}}
		return int(deleted), audit.Append(tx, event)
	}, database.RunOptions{})
}
