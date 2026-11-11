//go:build integration

package authority_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

func documentCommand(run func(authority.CommandContext, string) (string, error)) *authority.Command[string, string] {
	return authority.NewCommand("document", "update", database.ModeWrite, func(key string) string { return key }, run)
}
func auditDocument(c authority.CommandContext) error {
	return c.Audit(audit.KindHREmployeeUpdate, authority.AuditTarget{Resource: "document", Key: c.Target.Key, ObjectID: c.Target.ObjectID}, nil)
}
func updateDocument(c authority.CommandContext, title string) error {
	_, err := c.Tx.Exec("UPDATE document SET title=$1 WHERE id=$2", title, c.Target.Key)
	return err
}

func TestCommandAuditIsMandatoryAndCancellationCannotSplitMutation(t *testing.T) {
	f := newAuthorityFixture(t)
	f.grantUpdate(t)
	for _, emit := range []bool{false, true} {
		failure := errors.New("synthetic command failure")
		command := documentCommand(func(c authority.CommandContext, _ string) (string, error) {
			if err := updateDocument(c, "Rolled back"); err != nil {
				return "", err
			}
			if emit {
				if err := auditDocument(c); err != nil {
					return "", err
				}
				return "", failure
			}
			return "uncommitted", nil
		})
		a := f.authority(t, authority.DefaultCapabilities(), command)
		before := f.auditCount(t)
		if _, err := authority.Execute(t.Context(), a, f.secret, command, docOwn); err == nil {
			t.Fatal("unaudited or failed command committed")
		}
		var title string
		requireDB(t, f.conn.QueryRow(t.Context(), "SELECT title FROM document WHERE id=$1", docOwn).Scan(&title))
		if title != "Own" || f.auditCount(t) != before {
			t.Fatal("failed command left mutation or audit")
		}
	}
	started := make(chan struct{})
	release := make(chan struct{})
	command := documentCommand(func(c authority.CommandContext, _ string) (string, error) {
		if err := updateDocument(c, "Committed after disconnect"); err != nil {
			return "", err
		}
		for _, probe := range []struct {
			key  string
			want bool
		}{{docOwn, true}, {docOther, false}} {
			reaches, err := c.Reaches("document", "read", probe.key)
			if err != nil {
				return "", err
			}
			if reaches != probe.want {
				return "", errors.New("secondary permission did not share scope")
			}
		}
		close(started)
		<-release
		if err := auditDocument(c); err != nil {
			return "", err
		}
		return "committed", nil
	})
	a := f.authority(t, authority.DefaultCapabilities(), command)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		result, err := authority.Execute(ctx, a, f.secret, command, docOwn)
		if err == nil && (!result.Found || result.Value != "committed") {
			err = errors.New("command result missing")
		}
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("mutation did not start")
	}
	cancel()
	close(release)
	requireDB(t, <-done)
	var complete bool
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT title='Committed after disconnect' AND EXISTS(SELECT 1 FROM audit_outbox WHERE actor_id=$2 AND event_kind=convert_to('hr.employee.update','UTF8')) FROM document WHERE id=$1`, docOwn, f.owner.ID).Scan(&complete))
	if !complete {
		t.Fatal("disconnect split mutation and audit")
	}
}

type commandOutcome struct {
	result authority.CommandResult[string]
	err    error
}

func waitAuthorityLock(t *testing.T, f *authorityFixture, done <-chan commandOutcome) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		var blocked bool
		requireDB(t, f.conn.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='product_data' AND cardinality(pg_blocking_pids(pid))>0)`).Scan(&blocked))
		if blocked {
			return
		}
		select {
		case result := <-done:
			t.Fatalf("command ended before lock observation: found=%v error=%s", result.result.Found, test.Redact(result.err))
		case <-deadline:
			t.Fatal("authority did not wait on target row lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestLockingReadRechecksPredicateAfterConcurrentChange(t *testing.T) {
	f := newAuthorityFixture(t)
	f.grantUpdate(t)
	locker, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	requireDB(t, err)
	t.Cleanup(func() { requireDB(t, locker.Close(context.WithoutCancel(t.Context()))) })
	tx, err := locker.Begin(t.Context())
	requireDB(t, err)
	defer func() {
		err := tx.Rollback(context.WithoutCancel(t.Context()))
		if err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error(test.Redact(err))
		}
	}()
	_, err = tx.Exec(t.Context(), "UPDATE document SET state='published' WHERE id=$1", docOwn)
	requireDB(t, err)
	command := documentCommand(func(authority.CommandContext, string) (string, error) {
		return "", errors.New("command ran on a row that no longer matches its policy")
	})
	a := f.authority(t, authority.DefaultCapabilities(), command)
	done := make(chan commandOutcome, 1)
	go func() {
		result, err := authority.Execute(t.Context(), a, f.secret, command, docOwn)
		done <- commandOutcome{result, err}
	}()
	waitAuthorityLock(t, f, done)
	requireDB(t, tx.Commit(t.Context()))
	result := <-done
	requireDB(t, result.err)
	if result.result.Found {
		t.Fatal("stale predicate authorized changed row")
	}
}

// The event is refused before any statement, so the transaction is still usable when the append fails: only
// the error of the append keeps the command from committing.
func TestAnAuditRefusedBeforeItsStatementRollsTheCommandBack(t *testing.T) {
	f := newAuthorityFixture(t)
	f.grantUpdate(t)
	command := documentCommand(func(c authority.CommandContext, _ string) (string, error) {
		if err := updateDocument(c, "No audit"); err != nil {
			return "", err
		}
		return "done", c.Audit(audit.Kind("hr.not-a-kind"), authority.AuditTarget{Resource: "document", Key: c.Target.Key, ObjectID: c.Target.ObjectID}, nil)
	})
	a := f.authority(t, authority.DefaultCapabilities(), command)
	before := f.auditCount(t)
	_, err := authority.Execute(t.Context(), a, f.secret, command, docOwn)
	var title string
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT title FROM document WHERE id=$1", docOwn).Scan(&title))
	if after := f.auditCount(t); !errors.Is(err, audit.ErrInvalidEvent) || title != "Own" || after != before {
		t.Fatalf("err %v, title %q, audits %d -> %d", err, title, before, after)
	}
}
