//go:build integration

package app

import (
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	m8Settings     = "/api/administration/settings"
	m8AuditCount   = `SELECT count(*)::text FROM audit_outbox`
	m8AuditsBeyond = `SELECT convert_from(event_kind,'UTF8'), actor_id::text, coalesce(convert_from(permission_key,'UTF8'),''),
              coalesce(object_id::text,''), safe_metadata::text
         FROM audit_outbox ORDER BY occurred_at, event_id OFFSET CAST($1 AS int)`
	m8SetState        = `UPDATE app_user SET state=$2 WHERE id=$1`
	m8Release         = `DELETE FROM user_role WHERE user_id=$1`
	m8InsertException = `INSERT INTO record_exception(exception_id,object_id,type_key,permission_key,role_key,effect,purpose,starts_at,reason,issued_by)
       SELECT gen_random_uuid(),object_id,convert_to('role','UTF8'),convert_to('role.read','UTF8'),convert_to($1,'UTF8'),'allow','manual',statement_timestamp(),'fixture',$2
         FROM role_anchor`
	m8DeleteException = `DELETE FROM record_exception WHERE role_key=convert_to($1,'UTF8')`
	m8RevokeAudit     = `REVOKE INSERT ON audit_outbox FROM product_authority`
	m8GrantAudit      = `GRANT INSERT ON audit_outbox TO product_authority`
	m8RuleIDs         = `SELECT coalesce(string_agg(rule_id::text,',' ORDER BY rule_id),'') FROM policy_rule WHERE role_key=convert_to($1,'UTF8')`
	m8DropRuntimeKey  = `ALTER TABLE role_definition DROP CONSTRAINT ck_role_runtime_prefix`
	m8InsertCodeRole  = `INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to($1,'UTF8'),'code','Release role')`
	m8InsertCodeGrant = `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to('role.read','UTF8'),convert_to($1,'UTF8'),'allow',convert_to('role','UTF8'),1,'{}','code')`
	m8CodeRoleRow = `SELECT managed_by||':'||label||':'||(SELECT count(*) FROM policy_rule p WHERE p.role_key=d.role_key) FROM role_definition d
       WHERE d.role_key=convert_to($1,'UTF8')`
	m8SeedBoundary = `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version,seed_owner)
      VALUES($1,convert_to($2,'UTF8'),convert_to('accountAdministration','UTF8'),1,convert_to('fixture','UTF8'))`
	m8Unavailable = `{"statusCode":503,"code":"error.unavailable"}`
)

type m8Event struct{ Kind, Actor, Permission, Object, Metadata string }

type m8RootAccess struct {
	PrincipalKind string `json:"principalKind"`
	Outcome       string `json:"outcome"`
	Resource      string `json:"resource"`
	KeyKind       string `json:"keyKind"`
	Key           string `json:"key"`
}

func (w *m1World) m8Audits(t *testing.T) int {
	t.Helper()
	n, err := strconv.Atoi(w.scalar(t, m8AuditCount))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// m8Since relies on the requests of a test being sequential: a later row never sorts before the first n.
func (w *m1World) m8Since(t *testing.T, n int) []m8Event {
	t.Helper()
	rows, err := w.conn.Query(t.Context(), m8AuditsBeyond, n)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	events, err := pgx.CollectRows(rows, pgx.RowToStructByPos[m8Event])
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return events
}

// m8Person is a new IAM account under name holding roles, with a session that is not fresh.
func m8Person(t *testing.T, w *m1World, name string, roles ...string) string {
	t.Helper()
	w.ids[name] = fixture.Account(t, w.stack, fixture.AccountSpec{Roles: roles}).ID
	w.secrets[name] = fixture.Session(t, w.stack, w.ids[name], fixture.SessionSpec{})
	return w.ids[name]
}

func m8DigestOf(t *testing.T, body string) string {
	t.Helper()
	var written struct {
		Digest string `json:"digest"`
	}
	if err := json.Unmarshal([]byte(body), &written); err != nil || written.Digest == "" {
		t.Fatalf("no digest in %s: %v", body, err)
	}
	return written.Digest
}

// m8Triggerless runs a fixture insert the guards of the release refuse to every login but sync.
func (w *m1World) m8Triggerless(t *testing.T, sql string, args ...any) {
	t.Helper()
	w.exec(t, `SET session_replication_role=replica`)
	w.exec(t, sql, args...)
	w.exec(t, `SET session_replication_role=origin`)
}

// The holder keeps one session for the whole test: what it may read changes only with the rules of its role,
// and the profile it may always read shows the session itself still works.
func TestM8AnUpdateOfARoleReachesItsHolderAtTheNextRequest(t *testing.T) {
	w := newM8World(t)
	key := m8Key(w)
	profile, read := m8Pair("setting.readProfile", "setting"), m8Pair("setting.read", "setting")
	digest := m8Create(t, w, key, profile)
	m8Person(t, w, "holder", key)
	settings := m1Request{target: m8Settings}
	reads := func(stage string, want int) {
		t.Helper()
		status, body := w.send(http.MethodGet, "holder", settings, nil)
		if want == http.StatusOK && (status != want || !strings.HasPrefix(body, `{"settings":[{"key":`)) {
			t.Errorf("%s: settings read by the holder: %d %s", stage, status, body)
		}
		if want != http.StatusOK && !m1Refused(want).answers(status, body) {
			t.Errorf("%s: settings read by the holder: %d %s, want %d", stage, status, body, want)
		}
		if status, body := w.send(http.MethodGet, "holder", m1Request{target: m8Settings + "/profile"}, nil); status != http.StatusOK {
			t.Errorf("%s: the profile read by the holder: %d %s", stage, status, body)
		}
	}

	reads("before the update", http.StatusNotFound)
	widened := m8DigestOf(t, w.asRoot(t, http.MethodPut, m8Update(key, "Matrix role", profile+","+read, digest), http.StatusOK))
	reads("after the update that adds setting.read", http.StatusOK)
	w.asRoot(t, http.MethodPut, m8Update(key, "Matrix role", profile, widened), http.StatusOK)
	reads("after the update that drops setting.read", http.StatusNotFound)
}

func TestM8ARoleStillHeldIsNotDeletedWhateverTheStateOfItsHolder(t *testing.T) {
	w := newM8World(t)
	for _, state := range []string{"active", "pending", "suspended"} {
		key := m8Key(w)
		m8Create(t, w, key, m8RoleRead)
		holder := fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{key}}).ID
		w.exec(t, m8SetState, holder, state)
		remove := m1Request{target: m8Roles + "/" + key}
		w.m8Refused(t, "a Root delete of a role held by an account that is "+state, "root", http.MethodDelete, remove, http.StatusConflict)
		w.m8Refused(t, "an IAM delete of a role held by an account that is "+state, "hr", http.MethodDelete, remove, http.StatusConflict)
		if row := w.scalar(t, m8RoleRow, key); row != "Matrix role:1" {
			t.Errorf("the role held by an account that is %s: %s", state, row)
		}
		w.exec(t, m8Release, holder)
		w.succeed(t, "the same delete once the "+state+" account lost the role", "root", http.MethodDelete, remove, m8Deleted, http.StatusOK, "permission.role-delete")
	}
}

func TestM8ARoleNamedByARecordExceptionIsNotDeleted(t *testing.T) {
	w := newM8World(t)
	key := m8Key(w)
	m8Create(t, w, key, m8RoleRead)
	w.exec(t, m8InsertException, key, w.ids["root"])
	remove := m1Request{target: m8Roles + "/" + key}
	w.m8Refused(t, "a Root delete of a role named by a record exception", "root", http.MethodDelete, remove, http.StatusConflict)
	w.m8Refused(t, "an IAM delete of a role named by a record exception", "hr", http.MethodDelete, remove, http.StatusConflict)
	if row := w.scalar(t, m8RoleRow, key); row != "Matrix role:1" {
		t.Errorf("the role named by a record exception: %s", row)
	}
	w.exec(t, m8DeleteException, key)
	w.succeed(t, "the same delete once the exception is gone", "hr", http.MethodDelete, remove, m8Deleted, http.StatusOK, "permission.role-delete")
}

// Each command is valid and passes once the audit can be written again, so the only thing refused here is a
// commit without its audit row.
func TestM8ARoleCommandWhoseAuditFailsLeavesNoTrace(t *testing.T) {
	w := newM8World(t)
	key := m8Key(w)
	digest := m8Create(t, w, key, m8RoleRead)
	rules := w.scalar(t, m8RuleIDs, key)
	create := func() m1Request { return m1Request{m8Roles, m8CreateBody(m8Key(w), m8RoleRead)} }
	update := m8Update(key, "Matrix renamed", m8RoleRead+","+m8Pair("account.readPermissions", "allAccounts"), digest)
	remove := m1Request{target: m8Roles + "/" + key}

	w.exec(t, m8RevokeAudit)
	t.Cleanup(func() {
		if _, err := w.conn.Exec(context.WithoutCancel(t.Context()), m8GrantAudit); err != nil {
			t.Error(test.Redact(err))
		}
	})
	for _, actor := range []string{"root", "hr"} {
		for _, attempt := range []struct {
			name, method string
			r            m1Request
		}{{"create", http.MethodPost, create()}, {"update", http.MethodPut, update}, {"delete", http.MethodDelete, remove}} {
			before := w.state(t)
			status, body := w.send(attempt.method, actor, attempt.r, nil)
			if status != http.StatusServiceUnavailable || body != m8Unavailable {
				t.Errorf("a %s by %s whose audit fails: %d %s", attempt.name, actor, status, body)
			}
			if after := w.state(t); after != before {
				t.Errorf("a %s by %s whose audit fails left a trace: %s -> %s", attempt.name, actor, before, after)
			}
		}
	}
	if row, kept := w.scalar(t, m8RoleRow, key), w.scalar(t, m8RuleIDs, key); row != "Matrix role:1" || kept != rules {
		t.Errorf("the role after six commands whose audit failed: %s, rules %s -> %s", row, rules, kept)
	}

	w.exec(t, m8GrantAudit)
	w.succeed(t, "the same create", "hr", http.MethodPost, create(), m8Written, http.StatusCreated, "permission.role-create")
	w.succeed(t, "the same update", "hr", http.MethodPut, update, m8Written, http.StatusOK, "permission.role-update")
	w.succeed(t, "the same delete", "root", http.MethodDelete, remove, m8Deleted, http.StatusOK, "permission.role-delete")
}

// No such row exists while ck_role_runtime_prefix holds: the fixture drops the constraint in this database to
// put a role of the release under a runtime key, which the route accepts, and the commands must still not
// see it as a role they may write.
func TestM8ARoleOfTheReleaseUnderARuntimeKeyIsNotFound(t *testing.T) {
	w := newM8World(t)
	key := m8Key(w)
	w.exec(t, m8DropRuntimeKey)
	w.m8Triggerless(t, m8InsertCodeRole, key)
	w.m8Triggerless(t, m8InsertCodeGrant, key)
	update := m8Update(key, "Taken", m8RoleRead, w.m8Digest(t, key))
	remove := m1Request{target: m8Roles + "/" + key}
	for _, actor := range []string{"root", "hr"} {
		w.m8Refused(t, "an update by "+actor, actor, http.MethodPut, update, http.StatusNotFound)
		w.m8Refused(t, "a delete by "+actor, actor, http.MethodDelete, remove, http.StatusNotFound)
	}
	if row := w.scalar(t, m8CodeRoleRow, key); row != "code:Release role:1" {
		t.Errorf("the role of the release after four refused writes: %s", row)
	}
}

func TestM8TheMatrixFollowsTheGrantsOfARuntimeRole(t *testing.T) {
	w := newM8World(t)
	person := m8Person(t, w, "person")
	matrix := m1Request{target: m8Roles}
	w.m8Refused(t, "the matrix read without a role", "person", http.MethodGet, matrix, http.StatusNotFound)

	key := m8Key(w)
	w.exec(t, m8InsertRole, key, "Matrix reader")
	w.exec(t, m8InsertGrant, key, "role.read", "allow", "role")
	w.exec(t, m8Hold, person, key)
	var view m8View
	status, body := w.send(http.MethodGet, "person", matrix, nil)
	if err := json.Unmarshal([]byte(body), &view); status != http.StatusOK || err != nil {
		t.Fatalf("the matrix read by a holder of role.read: %d %s", status, body)
	}
	if !slices.ContainsFunc(view.Roles, func(r m8Role) bool { return r.Key == key && r.Holders == 1 }) || len(view.Catalog) != 142 {
		t.Errorf("the matrix read by a holder of role.read: %d roles, %d pairs", len(view.Roles), len(view.Catalog))
	}

	w.exec(t, m8Release, person)
	w.m8Refused(t, "the matrix read after the role was taken back", "person", http.MethodGet, matrix, http.StatusNotFound)
}

func TestM8AReadOfPermissionsIsAuditedWithItsTargetOnlyForRoot(t *testing.T) {
	w := newM8World(t)
	m8Holder(t, w, "reader", [2]string{"account.readPermissions", "allAccounts"})
	target := fixture.Account(t, w.stack, fixture.AccountSpec{}).ID
	read := m1Request{target: m8Path(target, "/permissions")}

	before := w.m8Audits(t)
	if status, body := w.send(http.MethodGet, "reader", read, nil); status != http.StatusOK {
		t.Fatalf("the read by an IAM account: %d %s", status, body)
	}
	byIAM := w.m8Since(t, before)
	if want := (m8Event{Kind: m8ObligationKind, Actor: w.ids["reader"], Permission: "account.readPermissions", Metadata: "{}"}); len(byIAM) != 1 || byIAM[0] != want {
		t.Errorf("the audit of the read by an IAM account: %+v, want %+v", byIAM, want)
	}

	before = w.m8Audits(t)
	w.asRoot(t, http.MethodGet, read, http.StatusOK)
	byRoot := w.m8Since(t, before)
	if len(byRoot) != 1 {
		t.Fatalf("the audit of the read by Root: %+v", byRoot)
	}
	var access m8RootAccess
	if err := json.Unmarshal([]byte(byRoot[0].Metadata), &access, json.RejectUnknownMembers(true)); err != nil {
		t.Fatalf("the metadata of the read by Root: %v", err)
	}
	wantEvent := m8Event{Kind: "access.account.readPermissions", Actor: w.ids["root"], Permission: "account.readPermissions", Metadata: byRoot[0].Metadata}
	wantAccess := m8RootAccess{PrincipalKind: "root", Outcome: "ok", Resource: "account", KeyKind: "uuid", Key: target}
	if byRoot[0] != wantEvent || access != wantAccess {
		t.Errorf("the audit of the read by Root: %+v with %+v, want %+v with %+v", byRoot[0], access, wantEvent, wantAccess)
	}
}

// A refusal the engine decides writes its one obligation row and nothing else; a refusal before the engine
// writes nothing.
func TestM8ARefusedReadOfPermissionsWritesExactlyOneObligation(t *testing.T) {
	w := newM8World(t)
	target := m1Request{target: m8Path(w.ids["scoped"], "/permissions")}
	absent := m1Request{target: m8Path(m1Absent, "/permissions")}
	ofRoot := m1Request{target: m8Path(w.ids["root"], "/permissions")}
	for _, refusal := range []struct {
		name, actor string
		r           m1Request
		status      int
		audited     bool
	}{
		{"no grant", "none", target, http.StatusNotFound, true},
		{"no grant, absent target", "none", absent, http.StatusNotFound, true},
		{"deny", "denied", target, http.StatusNotFound, true},
		{"absent target", "hr", absent, http.StatusNotFound, true},
		{"Root target", "hr", ofRoot, http.StatusNotFound, true},
		{"signed out", "", target, http.StatusUnauthorized, false},
		{"expired", "expired", target, http.StatusUnauthorized, false},
		{"suspended", "suspended", target, http.StatusUnauthorized, false},
		{"malformed id", "hr", m1Request{target: m8Path("not-a-uuid", "/permissions")}, http.StatusBadRequest, false},
	} {
		state, before := m8ReadAudited(t, w), w.m8Audits(t)
		status, body := w.send(http.MethodGet, refusal.actor, refusal.r, nil)
		if !m1Refused(refusal.status).answers(status, body) {
			t.Errorf("%s: %d %s, want %d", refusal.name, status, body, refusal.status)
		}
		written := w.m8Since(t, before)
		want := []m8Event{}
		if refusal.audited {
			want = append(want, m8Event{Kind: m8ObligationKind, Actor: w.ids[refusal.actor], Permission: "account.readPermissions", Metadata: "{}"})
		}
		if !slices.Equal(written, want) {
			t.Errorf("%s wrote %+v, want %+v", refusal.name, written, want)
		}
		if after := m8ReadAudited(t, w); after != state {
			t.Errorf("%s changed another row: %s -> %s", refusal.name, state, after)
		}
	}
}

func TestM8ThePermissionsOfAnAccountListItsBoundaryBindings(t *testing.T) {
	w := newM8World(t)
	m8Holder(t, w, "reader", [2]string{"account.readPermissions", "allAccounts"})
	target := fixture.Account(t, w.stack, fixture.AccountSpec{}).ID
	bare := fixture.Account(t, w.stack, fixture.AccountSpec{}).ID
	boundaries := func(account string) string {
		t.Helper()
		var view struct {
			Roles      jsontext.Value `json:"roles"`
			Grants     jsontext.Value `json:"grants"`
			Boundaries jsontext.Value `json:"boundaries"`
			Truncated  bool           `json:"truncated"`
		}
		status, body := w.send(http.MethodGet, "reader", m1Request{target: m8Path(account, "/permissions")}, nil)
		if err := json.Unmarshal([]byte(body), &view, json.RejectUnknownMembers(true)); status != http.StatusOK || err != nil || view.Truncated {
			t.Fatalf("the permissions of an account: %d %s", status, body)
		}
		return string(view.Boundaries)
	}
	if got := boundaries(bare); got != `[]` {
		t.Errorf("the boundaries of an account bound to nothing: %s", got)
	}

	for _, permission := range []string{"role.update", "account.suspend"} {
		w.exec(t, m8Bind, target, permission)
	}
	w.m8Triggerless(t, m8SeedBoundary, target, "account.provision")
	want := `[{"permission":"account.provision","key":"accountAdministration","version":1,"seeded":true},` +
		`{"permission":"account.suspend","key":"accountAdministration","version":1,"seeded":false},` +
		`{"permission":"role.update","key":"accountAdministration","version":1,"seeded":false}]`
	if got := boundaries(target); got != want {
		t.Errorf("the boundaries of the bound account:\n got %s\nwant %s", got, want)
	}
	if got := boundaries(bare); got != `[]` {
		t.Errorf("the bindings of another account leaked: %s", got)
	}
	state := m8ReadAudited(t, w)
	status, body := w.send(http.MethodGet, "scoped", m1Request{target: m8Path(target, "/permissions")}, nil)
	if !m1Refused(http.StatusNotFound).answers(status, body) || m8ReadAudited(t, w) != state {
		t.Errorf("the permissions of the bound account read without the grant: %d %s", status, body)
	}
}

// The denied role stores the same two pairs under the same label as a role the route wrote, so its digest
// must be that role's: the digest reads every stored rule, the capabilities only the ones that allow.
func TestM8CapabilitiesComeFromAllowRulesAndTheDigestFromEveryRule(t *testing.T) {
	w := newM8World(t)
	approvals, final := m8Pair("hrCompany.approvals", "company"), m8Pair("workRequest.decideFinal", "finalQueue")
	edit := m8Pair("employee.update", "allEmployees")
	both, allowed, denied, plain := m8Key(w), m8Key(w), m8Key(w), m8Key(w)
	bothDigest := m8Create(t, w, both, approvals+","+final+","+edit)
	allowedDigest := m8Create(t, w, allowed, final+","+edit)
	m8Create(t, w, plain, m8RoleRead)
	w.exec(t, m8InsertRole, denied, "Matrix role")
	w.exec(t, m8InsertGrant, denied, "workRequest.decideFinal", "deny", "finalQueue")
	w.exec(t, m8InsertGrant, denied, "employee.update", "deny", "allEmployees")

	var view m8View
	status, body := w.send(http.MethodGet, "hr", m1Request{target: m8Roles}, nil)
	if err := json.Unmarshal([]byte(body), &view); status != http.StatusOK || err != nil {
		t.Fatalf("the matrix: %d %s", status, body)
	}
	for key, want := range map[string]m8Role{
		both:    {Digest: bothDigest, Capabilities: []string{"selfApproval", "requestDecision", "employeeWrite"}},
		allowed: {Digest: allowedDigest, Capabilities: []string{"requestDecision", "employeeWrite"}},
		denied:  {Digest: allowedDigest, Capabilities: []string{}},
		plain:   {Digest: w.m8Digest(t, plain), Capabilities: []string{}},
	} {
		found := slices.IndexFunc(view.Roles, func(r m8Role) bool { return r.Key == key })
		if found < 0 {
			t.Errorf("role %s is not in the matrix", key)
			continue
		}
		if got := view.Roles[found]; got.Digest != want.Digest || got.Capabilities == nil || !slices.Equal(got.Capabilities, want.Capabilities) {
			t.Errorf("role %s: digest %s capabilities %v, want %s %v", key, got.Digest, got.Capabilities, want.Digest, want.Capabilities)
		}
	}
	if bothDigest == allowedDigest {
		t.Error("two different rule sets have one digest")
	}
}
