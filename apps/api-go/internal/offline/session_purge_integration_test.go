//go:build integration

package offline_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/offline"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	expireSession = `UPDATE application_session SET created_at=statement_timestamp()-$2::interval-interval '1 hour',
  expires_at=statement_timestamp()-$2::interval WHERE token_hash=$1`
	sessionLeft = `SELECT count(*)::int FROM application_session WHERE token_hash=$1`
	purgeEvents = `SELECT count(*)::int FROM audit_outbox WHERE event_kind=convert_to('identity.session-purge','UTF8')
  AND actor_id=$1 AND permission_key IS NULL AND safe_metadata=$2::jsonb`
)

func superuserConn(t *testing.T, s *test.Stack) *pgx.Conn {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	return conn
}

func connExec(t *testing.T, conn *pgx.Conn, sql string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func superCount(t *testing.T, conn *pgx.Conn, sql string, args ...any) int32 {
	t.Helper()
	var n int32
	if err := conn.QueryRow(t.Context(), sql, args...).Scan(&n); err != nil {
		t.Fatal(test.Redact(err))
	}
	return n
}

func digestOf(secret string) []byte {
	digest := sha256.Sum256([]byte(secret))
	return digest[:]
}

func TestPurgeExpiredSessionsDeletesPastTheRetentionWithItsEvent(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuserConn(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	old := digestOf(fixture.Session(t, s, account.ID, fixture.SessionSpec{}))
	recent := digestOf(fixture.Session(t, s, account.ID, fixture.SessionSpec{}))
	live := digestOf(fixture.Session(t, s, account.ID, fixture.SessionSpec{}))
	connExec(t, conn, expireSession, old, "2 days")
	connExec(t, conn, expireSession, recent, "10 minutes")

	revision := func() string {
		var r string
		if err := conn.QueryRow(t.Context(), `SELECT revision::text FROM authz_state`).Scan(&r); err != nil {
			t.Fatal(test.Redact(err))
		}
		return r
	}
	for _, step := range []struct {
		retention int
		deleted   int
		gone      []byte
	}{
		{1, 1, old},
		{0, 1, recent},
		{0, 0, nil},
	} {
		before := superCount(t, conn, `SELECT count(*)::int FROM audit_outbox`)
		deleted, err := offline.PurgeExpiredSessions(t.Context(), s.Runner, step.retention, 10)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		if deleted != step.deleted {
			t.Errorf("retention %d: deleted %d, want %d", step.retention, deleted, step.deleted)
		}
		if step.gone != nil && superCount(t, conn, sessionLeft, step.gone) != 0 {
			t.Errorf("retention %d: the expired session is left", step.retention)
		}
		metadata := `{"resultingRevision":"` + revision() + `","deleted":"1","retentionDays":"` + strconv.Itoa(step.retention) + `"}`
		wantEvents := int32(step.deleted)
		if got := superCount(t, conn, `SELECT count(*)::int FROM audit_outbox`) - before; got != wantEvents {
			t.Errorf("retention %d: %d new events", step.retention, got)
		}
		if step.deleted > 0 && superCount(t, conn, purgeEvents, offlineActor, metadata) != 1 {
			t.Errorf("retention %d: no event %s", step.retention, metadata)
		}
	}
	if superCount(t, conn, sessionLeft, live) != 1 {
		t.Error("a live session was purged")
	}
}

func TestPurgeExpiredSessionsTakesABatchAndSkipsLockedRows(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuserConn(t, s)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	digests := make([][]byte, 3)
	for i := range digests {
		digests[i] = digestOf(fixture.Session(t, s, account.ID, fixture.SessionSpec{}))
		connExec(t, conn, expireSession, digests[i], "1 day")
	}
	locker, err := conn.Begin(t.Context())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := locker.Rollback(context.WithoutCancel(t.Context())); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := locker.Exec(t.Context(), `SELECT 1 FROM application_session WHERE token_hash=$1 FOR UPDATE`, digests[0]); err != nil {
		t.Fatal(test.Redact(err))
	}
	for _, want := range []int{1, 1, 0} {
		deleted, err := offline.PurgeExpiredSessions(t.Context(), s.Runner, 0, 1)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		if deleted != want {
			t.Errorf("deleted %d, want %d", deleted, want)
		}
	}
	if err := locker.Commit(t.Context()); err != nil {
		t.Fatal(test.Redact(err))
	}
	if deleted, err := offline.PurgeExpiredSessions(t.Context(), s.Runner, 0, 1000); err != nil || deleted != 1 {
		t.Errorf("after the lock: %d, %v", deleted, err)
	}
}
