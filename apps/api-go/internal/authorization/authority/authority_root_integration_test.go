//go:build integration

package authority_test

import (
	"errors"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/test/fixture"
)

func TestFreshAuthUsesTheSameStatementMicrosecondClock(t *testing.T) {
	f := newAuthorityFixture(t)
	for _, entry := range []struct {
		offset string
		want   bool
	}{{"-299.999999 seconds", true}, {"-300 seconds", false}, {"-300.000001 seconds", false}, {"0.000001 seconds", false}} {
		var fresh bool
		requireDB(t, f.conn.QueryRow(t.Context(), "SELECT "+credential.FreshAuthSQL+" FROM (SELECT statement_timestamp()+CAST($1 AS interval) reauthenticated_at) s", entry.offset).Scan(&fresh))
		if fresh != entry.want {
			t.Fatalf("fresh boundary offset=%s want=%v got=%v", entry.offset, entry.want, fresh)
		}
	}
}

func TestRootBypassesScopesButKeepsFreshProjectionAndAtomicAudit(t *testing.T) {
	f := newAuthorityFixture(t)
	root := fixture.Root(t, f.s)
	secret := fixture.Session(t, f.s, root.ID, fixture.SessionSpec{})
	count, err := f.a.Count(t.Context(), secret, "document", "read")
	requireDB(t, err)
	if count != "2" {
		t.Fatal("root did not bypass scopes")
	}
	var marked bool
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok' FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.document.read','UTF8')`, root.ID).Scan(&marked))
	if !marked {
		t.Fatal("root marker missing")
	}
	_, err = f.a.Count(t.Context(), secret, "account", "suspend")
	if !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("root bypassed action fresh requirement")
	}
	fresh := fixture.Session(t, f.s, root.ID, fixture.SessionSpec{Fresh: true})
	_, err = f.a.Count(t.Context(), fresh, "account", "suspend")
	requireDB(t, err)
	changed, err := f.a.Update(t.Context(), secret, "document", "update", docOther, map[string]core.Scalar{"title": core.Text("Root changed")})
	requireDB(t, err)
	if !changed {
		t.Fatal("root write incorrectly required fresh")
	}
	_, err = f.a.Update(t.Context(), secret, "document", "update", docOther, map[string]core.Scalar{"ownerId": core.Text(root.ID)})
	if !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("root bypassed writable allowlist")
	}
	row, err := f.a.Detail(t.Context(), secret, "document", "read", absentDoc)
	requireDB(t, err)
	if row != nil {
		t.Fatal("absent target exposed")
	}
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='absent' AND safe_metadata->>'key'=$2 FROM audit_outbox WHERE actor_id=$1 AND safe_metadata->>'outcome'='absent'`, root.ID, absentDoc).Scan(&marked))
	if !marked {
		t.Fatal("root absent audit missing")
	}
	answers, err := f.a.PermitsMany(t.Context(), secret, []authority.PermitQuery{{{Resource: "document", Action: "read"}}, {{Resource: "missing", Action: "read"}}})
	requireDB(t, err)
	if !answers[0] || answers[1] {
		t.Fatal("root unknown permission allowed")
	}
	f.exec(t, `DELETE FROM document`)
	answers, err = f.a.PermitsMany(t.Context(), secret, []authority.PermitQuery{{{Resource: "document", Action: "read"}}})
	requireDB(t, err)
	if !answers[0] {
		t.Fatal("empty table hid root menu")
	}
	f.exec(t, `CREATE FUNCTION public.authority_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault'; END $$`)
	f.exec(t, `CREATE TRIGGER reject_root_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION public.authority_test_reject_audit()`)
	_, err = f.a.Count(t.Context(), secret, "document", "read")
	if err == nil {
		t.Fatal("root data released despite audit failure")
	}
	f.exec(t, `INSERT INTO document(id,object_id,owner_id,title,state) VALUES($1,$2,$3,'Before failure','draft')`, docOwn, objectOwn, f.owner.ID)
	_, err = f.a.Update(t.Context(), secret, "document", "update", docOwn, map[string]core.Scalar{"title": core.Text("Lost")})
	if err == nil {
		t.Fatal("root mutation survived failed audit")
	}
	var title string
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT title FROM document WHERE id=$1", docOwn).Scan(&title))
	if title != "Before failure" {
		t.Fatal("root audit failure left a mutation")
	}
}

func TestCapabilitiesAndFactReadErrorsFailClosed(t *testing.T) {
	f := newAuthorityFixture(t)
	root := fixture.Root(t, f.s)
	secret := fixture.Session(t, f.s, root.ID, fixture.SessionSpec{Fresh: true})
	caps := authority.DefaultCapabilities()
	delete(caps.Validators, "fresh@1")
	_, err := f.authority(t, caps).Count(t.Context(), secret, "account", "suspend")
	if !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("missing fresh validator allowed root")
	}
	caps = authority.DefaultCapabilities()
	caps.Validators["fresh@1"] = func(map[string]core.Scalar, core.ValidatorInput) core.ValidatorResult {
		panic("synthetic capability fault")
	}
	_, err = f.authority(t, caps).Count(t.Context(), secret, "account", "suspend")
	if !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("faulty fresh validator allowed root")
	}
	f.exec(t, `REVOKE SELECT ON policy_rule FROM product_data`)
	_, err = f.a.Count(t.Context(), f.secret, "document", "read")
	if err == nil {
		t.Fatal("facts read failure allowed data")
	}
	_, err = f.a.PermitsMany(t.Context(), f.secret, []authority.PermitQuery{{{Resource: "document", Action: "read"}}})
	if err == nil {
		t.Fatal("facts read failure swallowed in probes")
	}
}
