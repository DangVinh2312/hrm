//go:build integration

package authority_test

import (
	"testing"

	"hrm/api/internal/authorization/authority"
	"hrm/api/test/fixture"
)

// replayCommand writes and audits before it finds its key committed, so a replay that kept any of it shows.
func replayCommand() *authority.Command[string, string] {
	return documentCommand(func(c authority.CommandContext, _ string) (string, error) {
		if err := updateDocument(c, "Written before the replay"); err != nil {
			return "", err
		}
		if err := auditDocument(c); err != nil {
			return "", err
		}
		return authority.Replay("stored")
	})
}

func (f *authorityFixture) documentState(t *testing.T) string {
	t.Helper()
	var state string
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT string_agg(title,'|' ORDER BY id) FROM document`).Scan(&state))
	return state
}

func (f *authorityFixture) actorAudits(t *testing.T, actor string) int {
	t.Helper()
	var count int
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT count(*) FROM audit_outbox WHERE actor_id=$1", actor).Scan(&count))
	return count
}

// A replay answers the stored value and keeps nothing run wrote. Root's replay commits exactly one access
// audit of the requested target; an IAM replay rolls back unaudited.
func TestAReplayKeepsNothingButRootsAccessOfTheTarget(t *testing.T) {
	f := newAuthorityFixture(t)
	f.grantUpdate(t)
	root := fixture.Root(t, f.s)
	rootSecret := fixture.Session(t, f.s, root.ID, fixture.SessionSpec{})
	command := replayCommand()
	a := f.authority(t, authority.DefaultCapabilities(), command)
	documents := f.documentState(t)
	for _, run := range []struct {
		name, actor, secret, key string
		audits                   int
	}{{"iam", f.owner.ID, f.secret, docOwn, 0}, {"root", root.ID, rootSecret, docOther, 1}} {
		before := f.actorAudits(t, run.actor)
		result, err := authority.Execute(t.Context(), a, run.secret, command, run.key)
		requireDB(t, err)
		if !result.Found || result.Value != "stored" {
			t.Errorf("%s: replay answered %+v", run.name, result)
		}
		if state := f.documentState(t); state != documents {
			t.Errorf("%s: replay kept a write: %s -> %s", run.name, documents, state)
		}
		if got := f.actorAudits(t, run.actor) - before; got != run.audits {
			t.Errorf("%s: replay audited %d rows, want %d", run.name, got, run.audits)
		}
	}
	var marked bool
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT count(*)=1 AND coalesce(bool_and(object_id IS NULL
      AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok'
      AND safe_metadata->>'resource'='document' AND safe_metadata->>'keyKind'='uuid' AND safe_metadata->>'key'=$2),false)
      FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.document.update','UTF8')`, root.ID, docOther).Scan(&marked))
	if !marked {
		t.Error("root replay audit is not the access of its target")
	}
}

// Root's replay is released only with its audit: a failed append is an error, not the stored value.
func TestARootReplayFailsWithoutItsAudit(t *testing.T) {
	f := newAuthorityFixture(t)
	root := fixture.Root(t, f.s)
	secret := fixture.Session(t, f.s, root.ID, fixture.SessionSpec{})
	command := replayCommand()
	a := f.authority(t, authority.DefaultCapabilities(), command)
	documents, audits := f.documentState(t), f.actorAudits(t, root.ID)
	f.exec(t, `CREATE FUNCTION public.authority_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault'; END $$`)
	f.exec(t, `CREATE TRIGGER reject_root_audit BEFORE INSERT ON audit_outbox FOR EACH ROW
      WHEN (NEW.event_kind=convert_to('access.document.update','UTF8')) EXECUTE FUNCTION public.authority_test_reject_audit()`)
	result, err := authority.Execute(t.Context(), a, secret, command, docOther)
	if err == nil || result.Found || result.Value != "" {
		t.Errorf("replay released without its audit: %+v", result)
	}
	if state := f.documentState(t); state != documents || f.actorAudits(t, root.ID) != audits {
		t.Errorf("failed replay kept a write: %s -> %s", documents, state)
	}
}
