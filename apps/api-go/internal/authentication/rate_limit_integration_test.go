//go:build integration

package authentication_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authentication"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

const (
	rateLimitLock = 1379171467
	countBuckets  = `SELECT count(*)::int FROM rate_limit`
	fillTable     = `INSERT INTO rate_limit(bucket_key,window_start,attempts)
  SELECT sha256(convert_to('filler:'||n,'UTF8')),statement_timestamp(),3 FROM generate_series(1,$1::int) n`
	waitingOnLimiter = `SELECT count(*)::int FROM pg_stat_activity
  WHERE datname=current_database() AND usename='product_identity' AND wait_event_type='Lock' AND wait_event='advisory'`
)

func attempts(t *testing.T, service *authentication.Service, n int, client, identifier string) (allowed int) {
	t.Helper()
	for range n {
		err := service.RateLimit(t.Context(), client, identifier, "oidc")
		switch {
		case err == nil:
			allowed++
		case !refused(err):
			t.Fatalf("attempt from %s: %s", client, test.Redact(err))
		}
	}
	return allowed
}

func TestRateLimitAllowsTwentyAttemptsPerClientAndPerIdentifier(t *testing.T) {
	s := test.NewDatabase(t)
	service := authentication.NewService(s.Runner)
	for i := range 20 {
		if attempts(t, service, 1, "203.0.113.7", fmt.Sprintf("user-%d@example.test", i)) != 1 {
			t.Fatalf("client attempt %d refused", i+1)
		}
	}
	if attempts(t, service, 1, "203.0.113.7", "fresh@example.test") != 0 {
		t.Error("21st attempt of the client allowed")
	}
	for i := range 20 {
		if attempts(t, service, 1, fmt.Sprintf("198.51.100.%d", i+1), "target@example.test") != 1 {
			t.Fatalf("identifier attempt %d refused", i+1)
		}
	}
	if attempts(t, service, 1, "198.51.100.200", "target@example.test") != 0 {
		t.Error("21st attempt at the identifier allowed")
	}
	if attempts(t, service, 1, "198.51.100.201", "other@example.test") != 1 {
		t.Error("another client and identifier refused")
	}
}

func TestRateLimitCountsAnIdentifierThatIsTheClientOnce(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	if attempts(t, service, 20, "[2001:db8:1:2::9]:443", "2001:db8:1:2::/64") != 20 {
		t.Fatal("refused under the limit")
	}
	if n := queryOne[int32](t, conn, countBuckets); n != 2 {
		t.Errorf("%d buckets, want the /48 and the client", n)
	}
	if attempts(t, service, 1, "2001:db8:1:2::10", "2001:db8:1:2::/64") != 0 {
		t.Error("21st attempt of one /64 allowed")
	}
}

func TestRateLimitForgetsAttemptsAfterTheWindow(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	attempts(t, service, 21, "203.0.113.9", "203.0.113.9")
	exec(t, conn, `UPDATE rate_limit SET window_start=statement_timestamp()-interval '14 minutes 50 seconds'`)
	if attempts(t, service, 1, "203.0.113.9", "203.0.113.9") != 0 {
		t.Error("allowed inside the window")
	}
	exec(t, conn, `UPDATE rate_limit SET window_start=statement_timestamp()-interval '15 minutes'`)
	if attempts(t, service, 1, "203.0.113.9", "203.0.113.9") != 1 {
		t.Error("refused after the window")
	}
}

func TestRateLimitSharesTwoHundredAttemptsAcrossAnIPv6Slash48(t *testing.T) {
	s := test.NewDatabase(t)
	service := authentication.NewService(s.Runner)
	allowed := 0
	for subnet := range 10 {
		client := fmt.Sprintf("2001:db8:a:%x::1", subnet)
		allowed += attempts(t, service, 20, client, credential.RateLimitClient(client))
	}
	if allowed != 200 {
		t.Fatalf("%d of 200 allowed", allowed)
	}
	if attempts(t, service, 1, "2001:db8:a:ff::1", "2001:db8:a:ff::/64") != 0 {
		t.Error("201st attempt of the /48 allowed from a new /64")
	}
	if attempts(t, service, 1, "2001:db8:b::1", "2001:db8:b::/64") != 1 {
		t.Error("another /48 refused")
	}
}

func TestRateLimitEvictsTheFewestAttemptsFromAFullTable(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	service := authentication.NewService(s.Runner)
	attempts(t, service, 21, "203.0.113.20", "203.0.113.20")
	exec(t, conn, fillTable, 10_000)
	if attempts(t, service, 1, "203.0.113.21", "203.0.113.21") != 1 {
		t.Error("a new client refused by a full table")
	}
	if n := queryOne[int32](t, conn, countBuckets); n > 10_000 {
		t.Errorf("%d buckets", n)
	}
	if attempts(t, service, 1, "203.0.113.20", "203.0.113.20") != 0 {
		t.Error("eviction cleared a limited client")
	}
}

func TestRateLimitWaitsOutsideTheFence(t *testing.T) {
	s := test.NewDatabase(t)
	service := authentication.NewService(s.Runner)
	holder := superuser(t, s)
	observer := superuser(t, s)
	held, err := holder.Begin(t.Context())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := held.Rollback(context.WithoutCancel(t.Context())); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := held.Exec(t.Context(), `SELECT pg_advisory_xact_lock($1)`, int64(rateLimitLock)); err != nil {
		t.Fatal(test.Redact(err))
	}
	done := make(chan error, 1)
	go func() {
		done <- service.RateLimit(context.WithoutCancel(t.Context()), "203.0.113.30", "203.0.113.30", "oidc")
	}()
	for waiting := int32(0); waiting == 0; {
		select {
		case err := <-done:
			t.Fatalf("the limiter did not wait for the advisory lock: %v", err)
		case <-time.After(5 * time.Millisecond):
		}
		waiting = queryOne[int32](t, observer, waitingOnLimiter)
	}
	_, revokeErr := database.Run(t.Context(), s.Runner, database.ModeRevoke, func(context.Context, *database.Tx) (struct{}, error) {
		return struct{}{}, nil
	}, database.RunOptions{})
	commitErr := held.Commit(t.Context())
	if revokeErr != nil {
		t.Fatalf("a revoke behind a queued limiter: %s", test.Redact(revokeErr))
	}
	if commitErr != nil {
		t.Fatal(test.Redact(commitErr))
	}
	if err := <-done; err != nil {
		t.Fatalf("limiter after the release: %s", test.Redact(err))
	}
}

func TestRateLimitCountsConcurrentAttemptsUpToTheLimit(t *testing.T) {
	s := test.NewDatabase(t)
	service := authentication.NewService(s.Runner)
	var group sync.WaitGroup
	results := make(chan error, 25)
	for range 25 {
		group.Go(func() { results <- service.RateLimit(t.Context(), "203.0.113.40", "203.0.113.40", "oidc") })
	}
	group.Wait()
	close(results)
	allowed := 0
	for err := range results {
		switch {
		case err == nil:
			allowed++
		case !refused(err):
			t.Errorf("attempt: %s", test.Redact(err))
		}
	}
	if allowed != 20 {
		t.Errorf("%d of 25 concurrent attempts allowed", allowed)
	}
}
