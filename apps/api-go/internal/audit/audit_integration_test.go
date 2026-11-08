//go:build integration

package audit_test

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

type outboxRow struct {
	Kind              string
	Actor             string
	NoPermission      bool
	NoObject          bool
	PolicyRevision    string
	NoReason          bool
	MetadataMatches   bool
	OccurredInTxClock bool
}

const readOutbox = `SELECT convert_from(event_kind,'UTF8'),actor_id::text,permission_key IS NULL,object_id IS NULL,
  policy_revision::text,reason IS NULL,safe_metadata=$1::jsonb,occurred_at<=statement_timestamp()
  FROM audit_outbox WHERE event_kind LIKE 'identity.%' ORDER BY occurred_at,event_id`

func appendIn(t *testing.T, s *test.Stack, mode database.Mode, event audit.Event, fail error) (string, error) {
	t.Helper()
	return database.Run(t.Context(), s.Runner, mode, func(_ context.Context, tx *database.Tx) (string, error) {
		if err := audit.Append(tx, event); err != nil {
			return "", err
		}
		return tx.Revision, fail
	}, database.RunOptions{})
}

func outbox(t *testing.T, s *test.Stack, metadata string) []outboxRow {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	rows, err := conn.Query(t.Context(), readOutbox, metadata)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	got, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (outboxRow, error) {
		var r outboxRow
		err := row.Scan(&r.Kind, &r.Actor, &r.NoPermission, &r.NoObject, &r.PolicyRevision, &r.NoReason, &r.MetadataMatches, &r.OccurredInTxClock)
		return r, err
	})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return got
}

func plusOne(t *testing.T, revision string) string {
	t.Helper()
	n, err := strconv.ParseInt(revision, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return strconv.FormatInt(n+1, 10)
}

func TestAppendWritesTheIdentityEventWithTheRevisionTheTransactionLeaves(t *testing.T) {
	s := test.NewDatabase(t)
	account := fixture.Account(t, s, fixture.AccountSpec{Email: "audit@example.test"})
	for _, c := range []struct {
		mode   database.Mode
		kind   audit.Kind
		bumped bool
	}{
		{database.ModeIdentity, audit.KindOIDCLogin, false},
		{database.ModeRevoke, audit.KindLogoutAll, true},
	} {
		revision, err := appendIn(t, s, c.mode, audit.Event{Kind: c.kind, Actor: account.ID}, nil)
		if err != nil {
			t.Fatalf("%s: %s", c.mode, test.Redact(err))
		}
		resulting := revision
		if c.bumped {
			resulting = plusOne(t, revision)
		}
		rows := outbox(t, s, `{"resultingRevision":"`+resulting+`"}`)
		if len(rows) == 0 {
			t.Fatalf("%s: no event", c.mode)
		}
		last := rows[len(rows)-1]
		want := outboxRow{string(c.kind), account.ID, true, true, revision, true, true, true}
		if last != want {
			t.Errorf("%s: %+v, want %+v", c.mode, last, want)
		}
	}
}

func TestAppendWritesTheCountsOfASessionPurge(t *testing.T) {
	s := test.NewDatabase(t)
	event := audit.Event{Kind: audit.KindSessionPurge, Actor: audit.OfflineActor, Purge: &audit.SessionPurge{Deleted: 3, RetentionDays: 0}}
	revision, err := appendIn(t, s, database.ModeIdentity, event, nil)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	rows := outbox(t, s, `{"resultingRevision":"`+revision+`","deleted":"3","retentionDays":"0"}`)
	want := outboxRow{"identity.session-purge", audit.OfflineActor, true, true, revision, true, true, true}
	if len(rows) != 1 || rows[0] != want {
		t.Errorf("%+v, want one %+v", rows, want)
	}
}

func TestAnEventRollsBackWithItsTransaction(t *testing.T) {
	s := test.NewDatabase(t)
	account := fixture.Account(t, s, fixture.AccountSpec{})
	failure := errors.New("effect failed")
	if _, err := appendIn(t, s, database.ModeIdentity, audit.Event{Kind: audit.KindMFAVerifyFailed, Actor: account.ID}, failure); !errors.Is(err, failure) {
		t.Fatalf("got %v", err)
	}
	if rows := outbox(t, s, `{}`); len(rows) != 0 {
		t.Errorf("%d events after a rollback", len(rows))
	}
}
