package authentication

import (
	"context"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
)

const (
	rateLimitLock int64 = 1379171467
	// rateLimitRows bounds the table; one attempt adds at most maxBuckets rows.
	rateLimitRows = 10_000
	maxBuckets    = 3
	// attemptCeiling is what a bucket stops counting at; no row back reads as over every limit.
	attemptCeiling = 1001

	deleteExpired = `DELETE FROM rate_limit WHERE window_start <= statement_timestamp()-interval '15 minutes'`
	// A full table evicts instead of denying every client: the fewest attempts go first, so clearing a bucket
	// at n attempts needs ~10k buckets at >=n attempts. A /64 is one client and a /48 shares 200 attempts,
	// so one routed IPv6 prefix cannot supply them.
	// shortcut: ~500 /48s or ~1000 IPv4 hosts can still clear old buckets; add ingress quotas if that matters.
	evictFewest = `DELETE FROM rate_limit WHERE bucket_key IN (SELECT bucket_key FROM rate_limit ORDER BY attempts,window_start,bucket_key
          LIMIT GREATEST((SELECT count(*) FROM rate_limit)-$1,0))`
	countAttempt = `INSERT INTO rate_limit(bucket_key,window_start,attempts) VALUES($1,statement_timestamp(),1)
          ON CONFLICT(bucket_key) DO UPDATE SET attempts=LEAST(rate_limit.attempts+1,1001) RETURNING attempts`
)

// RateLimit counts one attempt in the database limiter shared by replicas and fails when a bucket is over
// its limit. One advisory key serializes the limiter before the fence, so queued sign-ins hold no fence
// share against a revoke. The digests are computed before the transaction.
func (s *Service) RateLimit(ctx context.Context, clientKey, identifier, purpose string) error {
	buckets, err := credential.RateLimitBuckets(clientKey, identifier, purpose)
	if err != nil {
		return err
	}
	lock := rateLimitLock
	allowed, err := database.Run(ctx, s.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (bool, error) {
		if _, err := tx.Exec(deleteExpired); err != nil {
			return false, err
		}
		if _, err := tx.Exec(evictFewest, rateLimitRows-maxBuckets); err != nil {
			return false, err
		}
		for _, bucket := range buckets {
			rows, err := tx.Query(countAttempt, bucket.Key)
			if err != nil {
				return false, err
			}
			counted, err := pgx.CollectRows(rows, pgx.RowTo[int32])
			if err != nil {
				return false, err
			}
			attempts := int32(attemptCeiling)
			if len(counted) == 1 {
				attempts = counted[0]
			}
			if attempts > bucket.Limit {
				return false, nil
			}
		}
		return true, nil
	}, database.RunOptions{Serialize: &lock})
	if err != nil {
		return err
	}
	if !allowed {
		return apperror.ErrAuthenticationFailed
	}
	return nil
}
