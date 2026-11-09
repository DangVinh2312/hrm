//go:build integration

package authority_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/gateway"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const docOwn = "a1000000-0000-4000-8000-000000000001"
const docOther = "a1000000-0000-4000-8000-000000000002"
const objectOwn = "a2000000-0000-4000-8000-000000000001"
const objectOther = "a2000000-0000-4000-8000-000000000002"
const absentDoc = "a1000000-0000-4000-8000-000000000099"

type authorityFixture struct {
	s      *test.Stack
	conn   *pgx.Conn
	a      *authority.Authorization
	owner  fixture.AccountRow
	secret string
}

func newAuthorityFixture(t *testing.T) *authorityFixture {
	t.Helper()
	f := &authorityFixture{s: test.NewDatabase(t)}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	requireDB(t, err)
	t.Cleanup(func() { requireDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	f.owner = fixture.Account(t, f.s, fixture.AccountSpec{Roles: []string{"reviewer"}})
	other := fixture.Account(t, f.s, fixture.AccountSpec{})
	f.secret = fixture.Session(t, f.s, f.owner.ID, fixture.SessionSpec{})
	f.exec(t, `INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,convert_to('document','UTF8'),'uuid',convert_to($2,'UTF8')),($3,convert_to('document','UTF8'),'uuid',convert_to($4,'UTF8'))`, objectOwn, docOwn, objectOther, docOther)
	f.exec(t, `INSERT INTO document(id,object_id,owner_id,title,state) VALUES($1,$2,$3,'Own','draft'),($4,$5,$6,'Other','draft')`, docOwn, objectOwn, f.owner.ID, docOther, objectOther, other.ID)
	f.a = f.authority(t, authority.DefaultCapabilities())
	return f
}

func requireDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(test.Redact(err))
	}
}
func (f *authorityFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.conn.Exec(t.Context(), sql, args...)
	requireDB(t, err)
}
func (f *authorityFixture) authority(t *testing.T, capabilities authority.Capabilities, operations ...authority.Operation) *authority.Authorization {
	return f.authoritySource(t, capabilities, declarations.Source().Declarations, declarations.Bindings(), operations...)
}
func (f *authorityFixture) authoritySource(t *testing.T, capabilities authority.Capabilities, source core.SystemDeclarations, storage compiler.StorageBindings, operations ...authority.Operation) *authority.Authorization {
	t.Helper()
	c, err := declarations.NewCore()
	requireDB(t, err)
	validated, err := c.Validate(source)
	requireDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, storage)
	requireDB(t, err)
	a, err := authority.New(f.s.Runner, bindings, capabilities, []authority.ResourceWrite{{Resource: "document", Action: "update", Fields: []string{"title"}}}, operations...)
	requireDB(t, err)
	return a
}
func (f *authorityFixture) grantUpdate(t *testing.T) {
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('document.update','UTF8'),$1,'allow',convert_to('ownedDocuments','UTF8'),1,'{}','runtime')`, f.owner.ID)
}
func (f *authorityFixture) auditCount(t *testing.T) int {
	t.Helper()
	var count int
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT count(*) FROM audit_outbox WHERE actor_id=$1", f.owner.ID).Scan(&count))
	return count
}

func TestAuthorityScopeProjectionProbesAndRevocation(t *testing.T) {
	f := newAuthorityFixture(t)
	page, err := f.a.List(t.Context(), f.secret, "document", "read", gateway.ListQuery{})
	requireDB(t, err)
	if page.Total != "1" || len(page.Items) != 1 {
		t.Fatal("owned scope not enforced")
	}
	if _, exposed := page.Items[0]["ownerId"]; exposed {
		t.Fatal("non-projected owner exposed")
	}
	for _, key := range []string{docOther, absentDoc} {
		row, err := f.a.Detail(t.Context(), f.secret, "document", "read", key)
		requireDB(t, err)
		if row != nil {
			t.Fatal("foreign or absent record exposed")
		}
	}
	count, err := f.a.Count(t.Context(), f.secret, "document", "read")
	requireDB(t, err)
	if count != "1" {
		t.Fatal("count differs from list")
	}
	answers, err := f.a.PermitsMany(t.Context(), f.secret, []authority.PermitQuery{{{Resource: "document", Action: "read"}}, {{Resource: "missing", Action: "read"}, {Resource: "document", Action: "update"}}})
	requireDB(t, err)
	if len(answers) != 2 || !answers[0] || answers[1] {
		t.Fatal("grouped probes differ from scope")
	}
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('document.read','UTF8'),$1,'deny',convert_to('ownedDocuments','UTF8'),1,'{}','runtime')`, f.owner.ID)
	count, err = f.a.Count(t.Context(), f.secret, "document", "read")
	requireDB(t, err)
	if count != "0" {
		t.Fatal("deny did not beat role allow")
	}
	f.exec(t, `DELETE FROM policy_rule WHERE user_id=$1`, f.owner.ID)
	f.exec(t, `DELETE FROM user_role WHERE user_id=$1`, f.owner.ID)
	count, err = f.a.Count(t.Context(), f.secret, "document", "read")
	requireDB(t, err)
	if count != "0" {
		t.Fatal("revoked grant remained usable")
	}
	for _, secret := range []string{"", "bad", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"} {
		_, err := f.a.Count(t.Context(), secret, "document", "read")
		if !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Fatalf("invalid session not refused: %s", test.Redact(err))
		}
	}
	f.exec(t, `UPDATE application_session SET revoked_at=statement_timestamp() WHERE user_id=$1`, f.owner.ID)
	_, err = f.a.Count(t.Context(), f.secret, "document", "read")
	if !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Fatal("revoked session accepted")
	}
}

func TestUpdateObligationAuditAndRollback(t *testing.T) {
	f := newAuthorityFixture(t)
	f.grantUpdate(t)
	before := f.auditCount(t)
	updated, err := f.a.Update(t.Context(), f.secret, "document", "update", docOwn, map[string]core.Scalar{"title": core.Text("Changed")})
	requireDB(t, err)
	if !updated || f.auditCount(t) != before+2 {
		t.Fatal("effect and obligation audits missing")
	}
	for _, changes := range []map[string]core.Scalar{{"ownerId": core.Text(f.owner.ID)}, {"title": core.Bool(true)}, {"title": core.Text(string([]byte{0xff}))}, {}} {
		if _, err := f.a.Update(t.Context(), f.secret, "document", "update", docOwn, changes); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Fatal("invalid update accepted")
		}
	}
	if _, err := f.a.Update(t.Context(), f.secret, "document", "read", docOwn, map[string]core.Scalar{"title": core.Text("Read is not write")}); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("read action used for update")
	}
	for _, key := range []string{docOther, absentDoc} {
		changed, err := f.a.Update(t.Context(), f.secret, "document", "update", key, map[string]core.Scalar{"title": core.Text("Leak")})
		requireDB(t, err)
		if changed {
			t.Fatal("hidden target updated")
		}
	}
	before = f.auditCount(t)
	failed := errors.New("obligation fault")
	caps := authority.DefaultCapabilities()
	caps.Obligations["audit@1"] = func(tx *database.Tx, plan *core.AuthorizedPlan) error { return failed }
	faulty := f.authority(t, caps)
	_, err = faulty.Update(t.Context(), f.secret, "document", "update", docOwn, map[string]core.Scalar{"title": core.Text("Lost")})
	if !errors.Is(err, failed) {
		t.Fatal("obligation failure swallowed")
	}
	var title string
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT title FROM document WHERE id=$1", docOwn).Scan(&title))
	if title != "Changed" || f.auditCount(t) != before {
		t.Fatal("obligation failure left data or audit")
	}
	caps = authority.DefaultCapabilities()
	delete(caps.Obligations, "audit@1")
	_, err = f.authority(t, caps).Update(t.Context(), f.secret, "document", "update", docOwn, map[string]core.Scalar{"title": core.Text("Lost")})
	if !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("missing handler allowed")
	}
	f.exec(t, `UPDATE document SET state='published' WHERE id=$1`, docOwn)
	changed, err := f.a.Update(t.Context(), f.secret, "document", "update", docOwn, map[string]core.Scalar{"title": core.Text("Lost")})
	requireDB(t, err)
	if changed {
		t.Fatal("policy scope bypassed")
	}
}
