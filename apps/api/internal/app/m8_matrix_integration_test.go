//go:build integration

package app

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"hrm/api/internal/config"
	"hrm/api/internal/httpapi"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	m8Writer      = "custom.m8_writer"
	m8RoleRead    = `{"permission":"role.read","template":{"key":"role","version":1}}`
	m8Suspend     = `{"permission":"account.suspend","template":{"key":"allAccounts","version":1}}`
	m8NoRoleKey   = "one role anchor of constant scope: no role is outside the scope of a grant"
	m8AllAccounts = "account.readPermissions has only allAccounts: no scope narrower than every IAM account"
	m8InsertRole  = `INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to($1,'UTF8'),'runtime',$2)`
	m8InsertGrant = `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to($2,'UTF8'),convert_to($1,'UTF8'),$3,convert_to($4,'UTF8'),1,'{}','runtime')`
	m8Hold  = `INSERT INTO user_role(user_id,role_key) VALUES($1,convert_to($2,'UTF8'))`
	m8Bind  = `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to($2,'UTF8'),convert_to('accountAdministration','UTF8'),1)`
	m8State = `SELECT concat_ws('|',
      (SELECT count(*)||':'||coalesce(md5(string_agg(encode(role_key,'hex')||':'||label,',' ORDER BY role_key)),'') FROM role_definition),
      (SELECT count(*)||':'||coalesce(md5(string_agg(rule_id::text,',' ORDER BY rule_id)),'') FROM policy_rule),
      (SELECT count(*)||':'||coalesce(md5(string_agg(id::text||':'||state||':'||auth_epoch||':'||coalesce(email_canonical,'')||':'||email_verified,',' ORDER BY id)),'') FROM app_user),
      (SELECT count(*)||':'||coalesce(md5(string_agg(user_id::text||':'||encode(role_key,'hex'),',' ORDER BY user_id, role_key)),'') FROM user_role),
      (SELECT count(*)||':'||coalesce(md5(string_agg(user_id::text||':'||email_canonical,',' ORDER BY user_id)),'') FROM oidc_email_enrollment),
      (SELECT count(*)||':'||coalesce(md5(string_agg(user_id::text||':'||encode(permission_key,'hex')||':'||encode(boundary_key,'hex')||':'||boundary_version,',' ORDER BY user_id, permission_key)),'') FROM user_boundary),
      (SELECT count(*)||':'||coalesce(md5(string_agg(user_id::text||':'||enabled||':'||binding_version,',' ORDER BY user_id, binding_version, enabled)),'') FROM external_identity),
      (SELECT count(*)::text FROM mfa_totp), (SELECT count(*)::text FROM mfa_recovery_code))`
	m8ObligationKind = "access.readPermissions"
	m8ReadState      = `SELECT concat_ws('|', (SELECT revision::text FROM authz_state WHERE singleton),
      (SELECT count(*)::text FROM user_role), (SELECT count(*)::text FROM user_boundary), (SELECT count(*)::text FROM app_user),
      (SELECT count(*)::text FROM audit_outbox WHERE event_kind <> convert_to($1,'UTF8')))`
)

// m8Audited is the state of a read whose policy is auditedRead@1: the obligation commits one access.<action>
// for every read that reaches the engine, refused or not, as every other row stays.
func m8Audited(kind string) func(*testing.T, *m1World) string {
	return func(t *testing.T, w *m1World) string {
		t.Helper()
		return w.scalar(t, m8State) + "|" + w.scalar(t, m8ReadState, kind)
	}
}

func m8ReadAudited(t *testing.T, w *m1World) string {
	t.Helper()
	return m8Audited(m8ObligationKind)(t, w)
}

// m8WriterGrants are what the writer role gives hr, unbound and denied; each is also a deny of denied.
var m8WriterGrants = [][2]string{
	{"role.read", "role"}, {"role.create", "role"}, {"role.update", "role"}, {"role.delete", "role"},
	{"account.readPermissions", "allAccounts"},
}

var (
	m8Written = regexp.MustCompile(`^\{"key":"custom\.m8_[0-9]+","digest":"[0-9a-f]{64}"\}$`)
	m8Pair    = func(permission, template string) string {
		return `{"permission":"` + permission + `","template":{"key":"` + template + `","version":1}}`
	}
)

func m8Key(w *m1World) string {
	w.name()
	return "custom.m8_" + strconv.Itoa(w.names)
}

func m8CreateBody(key, grants string) string {
	return `{"key":"` + key + `","label":"Matrix role","grants":[` + grants + `]}`
}

// m8Create is a runtime role written by Root through the route; it returns the digest of the answer.
func m8Create(t *testing.T, w *m1World, key, grants string) string {
	t.Helper()
	var written struct {
		Digest string `json:"digest"`
	}
	if err := json.Unmarshal([]byte(w.asRoot(t, http.MethodPost, m1Request{"/api/administration/roles", m8CreateBody(key, grants)}, http.StatusCreated)), &written); err != nil {
		t.Fatal(err)
	}
	return written.Digest
}

func m8Write(noBoundary m1Cell) m1Cells {
	return m1With(m1Write(), func(c *m1Cells) {
		c.noGrant, c.boundary, c.deny, c.fresh = m1Refused(403), noBoundary, m1Refused(403), m1Refused(403)
		c.foreign, c.absentEmployee = m1NA(m8NoRoleKey), m1NA("no employee in the path")
		c.invalid, c.extra = m1Refused(400), m1Refused(400)
		c.idempotency = m1NA("a role write takes no idempotency key")
	})
}

func m8Read() m1Cells {
	return m1With(m1Read(), func(c *m1Cells) {
		c.noGrant, c.deny = m1Refused(404), m1Refused(404)
		c.boundary = m1NA("the permission is boundary optional")
		c.absentEmployee = m1NA("no employee in the path")
		c.idempotency = m1NA("a read takes no idempotency key")
	})
}

var m8Matrix = map[httpapi.Route]m1Row{
	{Method: http.MethodGet, Path: "/api/administration/roles"}: {
		cells: m1With(m8Read(), func(c *m1Cells) {
			c.foreign, c.absent = m1NA(m8NoRoleKey), m1NA("no key in the path")
			c.invalid = m1NA("the route reads no parameter, query or body")
		}),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/administration/roles"} },
		shape:     regexp.MustCompile(`^\{"roles":\[\{"key":"hr\.[a-z]+","label":.*\}\],"catalog":\[\{"permission":.*\}\],"truncated":false\}$`),
		rootAudit: "access.role.read",
	},
	{Method: http.MethodGet, Path: "/api/administration/accounts/:id/permissions"}: {
		cells: m1With(m8Read(), func(c *m1Cells) {
			c.foreign = m1NA(m8AllAccounts)
			c.absent, c.invalid = m1Refused(404), m1Refused(400)
		}),
		prepare: func(_ *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/administration/accounts/" + w.ids["scoped"] + "/permissions"}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m1Segment(4, "not-a-uuid"), m1Segment(4, "1")},
		shape:     regexp.MustCompile(`^\{"roles":\[\{"key":"hr\.employee".*\],"grants":\[\{"permission":.*\],"boundaries":\[.*\],"truncated":false\}$`),
		audit:     m8ObligationKind,
		rootAudit: "access.account.readPermissions",
		state:     m8ReadAudited,
	},
	{Method: http.MethodPost, Path: "/api/administration/roles"}: {
		cells: m1With(m8Write(m1NA("role.create is boundary optional: a new role has no holder")), func(c *m1Cells) {
			c.absent = m1NA("a create names no existing role")
		}),
		prepare: func(_ *testing.T, w *m1World) m1Request {
			return m1Request{"/api/administration/roles", m8CreateBody(m8Key(w), m8RoleRead)}
		},
		invalid: []m1Edit{
			m1Replace(`"key":"custom.`, `"key":"hr.`), m1Replace(`"label":"Matrix role"`, `"label":""`),
			m1Replace(m8RoleRead, m8Pair("role.read", "allEmployees")), m1Replace(m8RoleRead, m8RoleRead+","+m8RoleRead),
			m1Replace(m8RoleRead, m8Pair("document.read", "ownedDocuments")), m1Replace(m8RoleRead, m8Pair("hrCompany.approvals", "company")),
			m1Replace(`[`+m8RoleRead+`]`, `null`),
		},
		extra:     m1Extra,
		shape:     m8Written,
		audit:     "permission.role-create",
		rootAudit: "permission.role-create",
	},
	{Method: http.MethodPut, Path: "/api/administration/roles/:key"}: {
		cells: m1With(m8Write(m1Refused(403)), func(c *m1Cells) { c.absent = m1Refused(404) }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			key := m8Key(w)
			digest := m8Create(t, w, key, m8RoleRead)
			return m1Request{"/api/administration/roles/" + key, `{"label":"Matrix renamed","grants":[` + m8RoleRead + `],"expectedDigest":"` + digest + `"}`}
		},
		absent: m1Segment(4, "custom.m8_absent"),
		invalid: []m1Edit{
			m1Segment(4, "hr.admin"), m1Segment(4, "custom.A"), m1Replace(`"expectedDigest":"`, `"expectedDigest":"0`),
			m1Replace(`"label":"Matrix renamed"`, `"label":""`), m1Replace(m8RoleRead, m8Pair("role.read", "allEmployees")),
		},
		extra:     m1Extra,
		shape:     m8Written,
		audit:     "permission.role-update",
		rootAudit: "permission.role-update",
	},
	{Method: http.MethodDelete, Path: "/api/administration/roles/:key"}: {
		cells: m1With(m8Write(m1Refused(403)), func(c *m1Cells) {
			c.absent, c.extra = m1Refused(404), m1NA("the route reads no body")
		}),
		prepare: func(t *testing.T, w *m1World) m1Request {
			key := m8Key(w)
			m8Create(t, w, key, m8RoleRead)
			return m1Request{target: "/api/administration/roles/" + key}
		},
		absent:    m1Segment(4, "custom.m8_absent"),
		invalid:   []m1Edit{m1Segment(4, "hr.admin"), m1Segment(4, "custom.A")},
		shape:     regexp.MustCompile(`^\{"status":"deleted"\}$`),
		audit:     "permission.role-delete",
		rootAudit: "permission.role-delete",
	},
}

func TestEveryM8RoleRouteIsMigratedWithAFullMatrix(t *testing.T) {
	if len(m8Matrix) != 5 {
		t.Errorf("%d role routes in the matrix, want 5", len(m8Matrix))
	}
	for route, row := range m8Matrix {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s: role route is not migrated", route)
		}
		checkMatrixRow(t, route, row)
	}
}

// newM8World: hr, unbound and denied hold the writer role; hr and denied are bound to accountAdministration@1
// for role.update and role.delete; denied also holds a deny of every permission of the writer role.
func newM8World(t *testing.T) *m1World {
	w := newM1World(t)
	w.exec(t, m8InsertRole, m8Writer, "Matrix writer")
	for _, grant := range m8WriterGrants {
		w.exec(t, m8InsertGrant, m8Writer, grant[0], "allow", grant[1])
		w.exec(t, m1InsertRule, w.ids["denied"], grant[0], "deny", grant[1])
	}
	for _, name := range []string{"hr", "unbound", "denied"} {
		w.exec(t, m8Hold, w.ids[name], m8Writer)
	}
	for _, name := range []string{"hr", "denied"} {
		for _, permission := range []string{"role.update", "role.delete"} {
			w.exec(t, m8Bind, w.ids[name], permission)
		}
	}
	return w
}

func TestTheM8RoleRoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM8World(t)
	statuses := m1ContractStatuses(t)
	for route, row := range m8Matrix {
		t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, row, statuses[route]) })
	}
}

type m8Role struct {
	Key          string   `json:"key"`
	Source       string   `json:"source"`
	Holders      int      `json:"holders"`
	Digest       string   `json:"digest"`
	Capabilities []string `json:"capabilities"`
}

type m8View struct {
	Roles   []m8Role         `json:"roles"`
	Catalog []jsontext.Value `json:"catalog"`
}

func (w *m1World) m8Refused(t *testing.T, name, actor, method string, r m1Request, status int) {
	t.Helper()
	before := w.state(t)
	got, body := w.send(method, actor, r, nil)
	if !m1Refused(status).answers(got, body) {
		t.Errorf("%s: %d %s, want %d", name, got, body, status)
	}
	if after := w.state(t); after != before {
		t.Errorf("%s changed the state: %s -> %s", name, before, after)
	}
}

// Root creates, reads (the digest of the read is the one an update needs), updates and deletes a role; each
// invariant of the role commands refuses one request without a trace: a role the release owns, a grant
// outside the IAM actor's own set, a pair the catalog does not register, a stale digest, a deny the API
// does not write, a role still held, an audit that cannot be written.
func TestM8RolesOverHTTP(t *testing.T) {
	w := newM8World(t)
	w.signIn(t)
	key := m8Key(w)
	digest := m8Create(t, w, key, m8RoleRead+","+m8Pair("account.read", "allAccounts"))
	var view m8View
	if err := json.Unmarshal([]byte(w.asRoot(t, http.MethodGet, m1Request{target: "/api/administration/roles"}, http.StatusOK)), &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Catalog) != 142 {
		t.Errorf("catalog of %d pairs", len(view.Catalog))
	}
	found := slices.IndexFunc(view.Roles, func(r m8Role) bool { return r.Key == key })
	if found < 0 {
		t.Fatalf("role %s not in the matrix", key)
	}
	if role := view.Roles[found]; role.Digest != digest || role.Source != "runtime" || role.Holders != 0 || !slices.Equal(role.Capabilities, []string{"accountAdministration"}) {
		t.Errorf("read of the created role: %+v, create gave %s", role, digest)
	}
	update := func(label, grants, expected string) m1Request {
		return m1Request{"/api/administration/roles/" + key, `{"label":"` + label + `","grants":[` + grants + `],"expectedDigest":"` + expected + `"}`}
	}
	w.asRoot(t, http.MethodPut, update("Renamed", m8RoleRead, digest), http.StatusOK)
	w.m8Refused(t, "stale digest", "root", http.MethodPut, update("Again", m8RoleRead, digest), http.StatusConflict)

	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		r := m1Request{target: "/api/administration/roles/hr.admin"}
		if method == http.MethodPut {
			r = m1Request{"/api/administration/roles/hr.admin", `{"label":"Taken","grants":[],"expectedDigest":"` + strings.Repeat("0", 64) + `"}`}
		}
		w.m8Refused(t, method+" of a code-owned role", "root", method, r, http.StatusBadRequest)
	}

	w.m8Refused(t, "an IAM create outside the actor's set", "hr", http.MethodPost, m1Request{"/api/administration/roles", m8CreateBody(m8Key(w), m8Suspend)}, http.StatusForbidden)
	larger := m8Key(w)
	largerDigest := m8Create(t, w, larger, m8Suspend)
	w.m8Refused(t, "an IAM update of a role outside the actor's set", "hr", http.MethodPut,
		m1Request{"/api/administration/roles/" + larger, `{"label":"Matrix role","grants":[` + m8RoleRead + `],"expectedDigest":"` + largerDigest + `"}`}, http.StatusNotFound)
	w.m8Refused(t, "an IAM delete of a role outside the actor's set", "hr", http.MethodDelete, m1Request{target: "/api/administration/roles/" + larger}, http.StatusNotFound)
	w.m8Refused(t, "an IAM update adding a grant outside the actor's set", "hr", http.MethodPut,
		update("Renamed", m8RoleRead+","+m8Suspend, w.m8Digest(t, key)), http.StatusForbidden)

	for name, grants := range map[string]string{
		"a template of another resource": m8Pair("role.read", "allEmployees"),
		"an unknown permission":          m8Pair("role.approve", "role"),
		"a document permission":          m8Pair("document.read", "ownedDocuments"),
		"approvals without decideFinal":  m8Pair("hrCompany.approvals", "company"),
	} {
		w.m8Refused(t, name, "root", http.MethodPost, m1Request{"/api/administration/roles", m8CreateBody(m8Key(w), grants)}, http.StatusBadRequest)
	}

	denied := m8Key(w)
	m8Create(t, w, denied, m8RoleRead)
	w.exec(t, m8InsertGrant, denied, "setting.read", "deny", "setting")
	w.m8Refused(t, "an update of a role holding a deny", "root", http.MethodPut,
		m1Request{"/api/administration/roles/" + denied, `{"label":"Matrix role","grants":[` + m8RoleRead + `],"expectedDigest":"` + w.m8Digest(t, denied) + `"}`}, http.StatusConflict)

	w.exec(t, m8Hold, w.ids["none"], key)
	w.m8Refused(t, "a delete of a held role", "root", http.MethodDelete, m1Request{target: "/api/administration/roles/" + key}, http.StatusConflict)

	for _, actor := range []string{"hr", "none"} {
		before, audits := m8ReadAudited(t, w), w.scalar(t, m1Audits, w.ids[actor], m8ObligationKind)
		status, body := w.send(http.MethodGet, actor, m1Request{target: "/api/administration/accounts/" + w.ids["root"] + "/permissions"}, nil)
		if !m1Refused(http.StatusNotFound).answers(status, body) {
			t.Errorf("permissions of Root read by %s: %d %s", actor, status, body)
		}
		n, err := strconv.Atoi(audits)
		if err != nil {
			t.Fatal(err)
		}
		if after := w.scalar(t, m1Audits, w.ids[actor], m8ObligationKind); after != strconv.Itoa(n+1) || m8ReadAudited(t, w) != before {
			t.Errorf("permissions of Root read by %s: %s audits %s -> %s, or another row changed", actor, m8ObligationKind, audits, after)
		}
	}
	var permissions struct {
		Roles []struct {
			Key string `json:"key"`
		} `json:"roles"`
		Boundaries []struct {
			Permission string `json:"permission"`
			Key        string `json:"key"`
		} `json:"boundaries"`
	}
	_, body := w.send(http.MethodGet, "hr", m1Request{target: "/api/administration/accounts/" + w.ids["none"] + "/permissions"}, nil)
	if err := json.Unmarshal([]byte(body), &permissions); err != nil || len(permissions.Roles) != 1 || permissions.Roles[0].Key != key {
		t.Errorf("permissions of an account holding %s: %s", key, body)
	}

	w.exec(t, `REVOKE INSERT ON audit_outbox FROM product_authority`)
	before := w.state(t)
	status, body := w.send(http.MethodPost, "root", m1Request{"/api/administration/roles", m8CreateBody(m8Key(w), m8RoleRead)}, nil)
	w.exec(t, `GRANT INSERT ON audit_outbox TO product_authority`)
	if status != http.StatusServiceUnavailable || body != `{"statusCode":503,"code":"error.unavailable"}` {
		t.Errorf("a create whose audit fails: %d %s", status, body)
	}
	if after := w.state(t); after != before {
		t.Errorf("a create whose audit fails left a trace: %s -> %s", before, after)
	}
}

// m8Digest is the digest role.read gives the role now.
func (w *m1World) m8Digest(t *testing.T, key string) string {
	t.Helper()
	var view m8View
	if err := json.Unmarshal([]byte(w.asRoot(t, http.MethodGet, m1Request{target: "/api/administration/roles"}, http.StatusOK)), &view); err != nil {
		t.Fatal(err)
	}
	for _, role := range view.Roles {
		if role.Key == key {
			return role.Digest
		}
	}
	t.Fatalf("role %s not in the matrix", key)
	return ""
}

const (
	m8Accounts     = "custom.m8_accounts"
	m8Larger       = "custom.m8_larger"
	m8AccountScope = "every account permission has only allAccounts: no scope narrower than every IAM account"
	m8AfterFence   = "refused inside the exclusive transaction, which commits the revision and the access obligation: TestM8AccountsOverHTTP"
	m8Epoch        = `SELECT state||':'||auth_epoch FROM app_user WHERE id=$1`
	m8Email        = "custom.m8_email"
	m8Mfa          = "custom.m8_mfa"
	m8Google       = "custom.m8_google"
	m8IdentityRef  = `{"key":"identityAdministration","version":1}`
	m8BindIdentity = `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version)
      SELECT $1, permission_key, boundary_key, boundary_version FROM permission_boundary_entry
       WHERE boundary_key=convert_to('identityAdministration','UTF8') AND boundary_version=1`
	m8RecoveryCode = `INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,sha256(convert_to(gen_random_uuid()::text,'UTF8')))`
	m8HoldOnly     = `DELETE FROM user_role WHERE role_key IN (convert_to($1,'UTF8'),convert_to($2,'UTF8'),convert_to($3,'UTF8'))`
)

// m8AccountGrants are what the accounts role gives hr, unbound and denied over allAccounts; denied also holds a
// deny of each. Every one but account.read is boundary required, so hr and denied are bound for those.
var m8AccountGrants = []string{"account.read", "account.provision", "account.suspend", "account.reactivate", "account.assignRole", "account.revokeRole", "account.bindBoundary", "account.unbindBoundary"}

// m8IdentityRoles each give one of the three account.* identity permissions (ADR-15): no one holds two of them
// at once, so hr, unbound and denied hold the one role of the route under test (holdIdentity).
var m8IdentityRoles = map[string]string{m8Email: "account.changeEmail", m8Mfa: "account.resetMfa", m8Google: "account.resetGoogleBinding"}

var m8IdentityRoutes = map[httpapi.Route]string{
	{Method: http.MethodPut, Path: "/api/administration/accounts/:id/email"}:         m8Email,
	{Method: http.MethodPost, Path: "/api/administration/accounts/:id/mfa/reset"}:    m8Mfa,
	{Method: http.MethodPost, Path: "/api/administration/accounts/:id/google/reset"}: m8Google,
}

// holdIdentity leaves hr, unbound and denied holding role ("" for none) and no other identity role.
func (w *m1World) holdIdentity(t *testing.T, role string) {
	t.Helper()
	w.exec(t, m8HoldOnly, m8Email, m8Mfa, m8Google)
	if role == "" {
		return
	}
	for _, name := range []string{"hr", "unbound", "denied"} {
		w.exec(t, m8Hold, w.ids[name], role)
	}
}

// m8Mailed is a new IAM account with an email, whose grants are within hr's.
func m8Mailed(t *testing.T, w *m1World) string {
	t.Helper()
	w.name()
	return fixture.Account(t, w.stack, fixture.AccountSpec{Email: "m8-mailed-" + strconv.Itoa(w.names) + "@example.test", Roles: []string{m1Employee}}).ID
}

func m8Path(target, rest string) string { return "/api/administration/accounts/" + target + rest }

var (
	m8NoAccounts = m1Cell{status: http.StatusOK, body: `{"items":[],"total":"0"}`}
	m8LongKey    = strings.Repeat("a", 97)
)

func m8Upper(index int) m1Edit {
	return func(r m1Request) m1Request {
		parts := strings.Split(r.target, "/")
		parts[index] = strings.ToUpper(parts[index])
		r.target = strings.Join(parts, "/")
		return r
	}
}

// m8Target is a new IAM account whose grants are within hr's.
func m8Target(t *testing.T, w *m1World, roles ...string) string {
	t.Helper()
	return fixture.Account(t, w.stack, fixture.AccountSpec{Roles: append([]string{m1Employee}, roles...)}).ID
}

func m8AccountWrite() m1Cells {
	return m1With(m1Write(), func(c *m1Cells) {
		c.noGrant, c.boundary, c.deny, c.fresh = m1Refused(403), m1Refused(403), m1Refused(404), m1Refused(403)
		c.foreign, c.absentEmployee = m1NA(m8AccountScope), m1NA("no employee in the path")
		c.absent, c.invalid, c.extra = m1Refused(404), m1Refused(400), m1Refused(400)
		c.idempotency = m1NA("an account command takes no idempotency key")
	})
}

var m8AccountMatrix = map[httpapi.Route]m1Row{
	{Method: http.MethodGet, Path: "/api/administration/accounts"}: {
		cells: m1With(m8Read(), func(c *m1Cells) {
			c.noGrant, c.deny = m8NoAccounts, m8NoAccounts
			c.foreign = m1NA("no id in the path: the list is filtered by the scope in SQL")
			c.absent, c.invalid = m1NA("no id in the path"), m1Refused(400)
		}),
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: "/api/administration/accounts"} },
		invalid:   []m1Edit{m1Query("limit=0"), m1Query("limit=101"), m1Query("limit=abc"), m1Query("offset=10001"), m1Query("sort=email"), m1Query("limit=1&limit=2")},
		shape:     regexp.MustCompile(`^\{"items":\[\{"userId":"` + m1UUID + `","email":(null|"[^"]*"),"state":"(active|pending|suspended)","enrollment":(null|"pending"|"expired")\}.*\],"total":"[1-9][0-9]*"\}$`),
		audit:     "access.read",
		rootAudit: "access.account.read",
		state:     m8Audited("access.read"),
	},
	{Method: http.MethodPost, Path: "/api/administration/accounts"}: {
		cells: m1With(m8AccountWrite(), func(c *m1Cells) {
			c.foreign = m1NA("the new account has no key in the request")
			c.deny, c.absent = m1NA("AllowsAll reads only the decision; "+m8AfterFence), m1NA("an absent role is "+m8AfterFence)
		}),
		prepare: func(_ *testing.T, w *m1World) m1Request {
			w.name()
			return m1Request{"/api/administration/accounts", `{"email":"m8-` + strconv.Itoa(w.names) + `@example.test","roleKey":"hr.employee"}`}
		},
		invalid: []m1Edit{
			m1Replace(`@example.test`, ``), m1Replace(`"roleKey":"hr.employee"`, `"roleKey":""`), m1Replace(`"hr.employee"`, `"`+m8LongKey+`"`),
			m1Replace(`,"roleKey":"hr.employee"`, ``), m1Replace(`"hr.employee"`, `1`), m1Body(`[]`),
		},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"userId":"` + m1UUID + `","email":"m8-[0-9]+@example\.test","state":"pending"\}$`),
		audit:     "account.provision",
		rootAudit: "account.provision",
	},
	{Method: http.MethodPost, Path: "/api/administration/users/:id/suspend"}: {
		cells: m1With(m8AccountWrite(), func(c *m1Cells) { c.invalid = m1Refused(403) }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/administration/users/" + m8Target(t, w) + "/suspend"}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m8Upper(4), m1Segment(4, "not-a-uuid")},
		extra:     m1Body(`{"extra":1}`),
		shape:     regexp.MustCompile(`^\{"status":"suspended"\}$`),
		audit:     "account.suspend",
		rootAudit: "account.suspend",
	},
	{Method: http.MethodPost, Path: "/api/administration/users/:id/reactivate"}: {
		cells: m1With(m8AccountWrite(), func(c *m1Cells) { c.invalid = m1Refused(403) }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			target := m8Target(t, w)
			w.exec(t, m1Suspend, target)
			return m1Request{target: "/api/administration/users/" + target + "/reactivate"}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m8Upper(4), m1Segment(4, "not-a-uuid")},
		extra:     m1Body(`{"extra":1}`),
		shape:     regexp.MustCompile(`^\{"status":"reactivated"\}$`),
		audit:     "account.reactivate",
		rootAudit: "account.reactivate",
	},
	{Method: http.MethodPost, Path: "/api/administration/accounts/:id/roles"}: {
		cells: m8AccountWrite(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{"/api/administration/accounts/" + m8Target(t, w) + "/roles", `{"roleKey":"hr.admin"}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Body(`{"roleKey":""}`), m1Body(`{"roleKey":1}`), m1Body(`{}`), m1Body(`{"roleKey":null}`), m1Body(`{"roleKey":"` + m8LongKey + `"}`), m1Body(`[]`),
		},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"status":"assigned"\}$`),
		audit:     "permission.role-assign",
		rootAudit: "permission.role-assign",
	},
	{Method: http.MethodDelete, Path: "/api/administration/accounts/:id/roles/:roleKey"}: {
		cells: m1With(m8AccountWrite(), func(c *m1Cells) { c.extra = m1NA("the route reads no body") }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: "/api/administration/accounts/" + m8Target(t, w, m1Admin) + "/roles/hr.admin"}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m1Segment(6, m8LongKey)},
		shape:     regexp.MustCompile(`^\{"status":"revoked"\}$`),
		audit:     "permission.role-revoke",
		rootAudit: "permission.role-revoke",
	},
	{Method: http.MethodPost, Path: "/api/administration/accounts/:id/boundaries"}: {
		cells: m8AccountWrite(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{m8Path(m8Target(t, w), "/boundaries"), m8IdentityRef}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Body(`{"key":"","version":1}`), m1Body(`{"key":"1identity","version":1}`), m1Body(`{"key":"identityAdministration","version":0}`),
			m1Body(`{"key":"identityAdministration","version":2147483648}`), m1Body(`{"key":"identityAdministration","version":1.5}`),
			m1Body(`{"key":"identityAdministration","version":"1"}`), m1Body(`{"key":"identityAdministration"}`), m1Body(`[]`),
			m1Body(`{"key":"nope","version":1}`), m1Body(`{"key":"identityAdministration","version":2}`),
		},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"status":"bound"\}$`),
		audit:     "permission.boundary-assign",
		rootAudit: "permission.boundary-assign",
	},
	{Method: http.MethodDelete, Path: "/api/administration/accounts/:id/boundaries/:key/:version"}: {
		cells: m1With(m8AccountWrite(), func(c *m1Cells) { c.extra = m1NA("the route reads no body") }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			target := m8Target(t, w)
			w.exec(t, m8BindIdentity, target)
			return m1Request{target: m8Path(target, "/boundaries/identityAdministration/1")}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m1Segment(6, "1identity"), m1Segment(7, "0"), m1Segment(7, "01"), m1Segment(7, "2147483648"), m1Segment(7, "a"), m1Segment(7, "10000000000")},
		shape:     regexp.MustCompile(`^\{"status":"unbound"\}$`),
		audit:     "permission.boundary-revoke",
		rootAudit: "permission.boundary-revoke",
	},
	{Method: http.MethodPut, Path: "/api/administration/accounts/:id/email"}: {
		cells: m8AccountWrite(),
		prepare: func(t *testing.T, w *m1World) m1Request {
			w.name()
			return m1Request{m8Path(m8Mailed(t, w), "/email"), `{"email":"M8-Changed-` + strconv.Itoa(w.names) + `@example.test"}`}
		},
		absent: m1Segment(4, m1Absent),
		invalid: []m1Edit{
			m1Body(`{"email":""}`), m1Body(`{"email":"not-an-email"}`), m1Body(`{"email":1}`), m1Body(`{}`), m1Body(`{"email":null}`), m1Body(`[]`),
		},
		extra:     m1Extra,
		shape:     regexp.MustCompile(`^\{"status":"changed"\}$`),
		audit:     "identity.email-change",
		rootAudit: "identity.email-change",
	},
	{Method: http.MethodPost, Path: "/api/administration/accounts/:id/mfa/reset"}: {
		cells: m1With(m8AccountWrite(), func(c *m1Cells) { c.invalid = m1Refused(403) }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			target := m8Target(t, w)
			w.exec(t, m8RecoveryCode, target)
			return m1Request{target: m8Path(target, "/mfa/reset")}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m8Upper(4), m1Segment(4, "not-a-uuid")},
		extra:     m1Body(`{"extra":1}`),
		shape:     regexp.MustCompile(`^\{"status":"reset"\}$`),
		audit:     "identity.mfa-reset-by-permission",
		rootAudit: "identity.mfa-reset-by-permission",
	},
	{Method: http.MethodPost, Path: "/api/administration/accounts/:id/google/reset"}: {
		cells: m1With(m8AccountWrite(), func(c *m1Cells) { c.invalid = m1Refused(403) }),
		prepare: func(t *testing.T, w *m1World) m1Request {
			return m1Request{target: m8Path(m8Mailed(t, w), "/google/reset")}
		},
		absent:    m1Segment(4, m1Absent),
		invalid:   []m1Edit{m8Upper(4), m1Segment(4, "not-a-uuid")},
		extra:     m1Body(`{"extra":1}`),
		shape:     regexp.MustCompile(`^\{"status":"reset"\}$`),
		audit:     "identity.binding-reset",
		rootAudit: "identity.binding-reset",
	},
}

func TestEveryM8AccountRouteIsMigratedWithAFullMatrix(t *testing.T) {
	if len(m8AccountMatrix) != 11 {
		t.Errorf("%d account routes in the matrix, want 11", len(m8AccountMatrix))
	}
	for route, row := range m8AccountMatrix {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s: account route is not migrated", route)
		}
		checkMatrixRow(t, route, row)
	}
}

// newM8AccountWorld adds the accounts role to the role world, the three identity roles (held by no one yet),
// and a role larger than hr's grants while hr does not hold the changeEmail role.
// hr and denied are bound to the whole identityAdministration package, denied denies each identity permission.
func newM8AccountWorld(t *testing.T) *m1World {
	w := newM8World(t)
	w.exec(t, m8InsertRole, m8Accounts, "Matrix accounts")
	for _, permission := range m8AccountGrants {
		w.exec(t, m8InsertGrant, m8Accounts, permission, "allow", "allAccounts")
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", "allAccounts")
	}
	for _, name := range []string{"hr", "unbound", "denied"} {
		w.exec(t, m8Hold, w.ids[name], m8Accounts)
	}
	for _, name := range []string{"hr", "denied"} {
		for _, permission := range m8AccountGrants[1:] {
			w.exec(t, m8Bind, w.ids[name], permission)
		}
	}
	for role, permission := range m8IdentityRoles {
		w.exec(t, m8InsertRole, role, "Matrix identity")
		w.exec(t, m8InsertGrant, role, permission, "allow", "allAccounts")
		w.exec(t, m1InsertRule, w.ids["denied"], permission, "deny", "allAccounts")
	}
	for _, name := range []string{"hr", "denied"} {
		w.exec(t, m8BindIdentity, w.ids[name])
	}
	w.exec(t, m8InsertRole, m8Larger, "Matrix larger")
	w.exec(t, m8InsertGrant, m8Larger, "account.changeEmail", "allow", "allAccounts")
	return w
}

func TestTheM8AccountRoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM8AccountWorld(t)
	statuses := m1ContractStatuses(t)
	for route, row := range m8AccountMatrix {
		t.Run(route.String(), func(t *testing.T) {
			w.holdIdentity(t, m8IdentityRoutes[route])
			w.signIn(t)
			w.check(t, route, row, statuses[route])
		})
	}
}

// m8Committed sends a request refused inside the exclusive transaction: the revision and the access obligation
// commit, the accounts, their roles, boundaries and identity stay.
func (w *m1World) m8Committed(t *testing.T, name, actor, method string, r m1Request, status int) {
	t.Helper()
	before := w.scalar(t, m8State)
	got, body := w.send(method, actor, r, nil)
	if !m1Refused(status).answers(got, body) {
		t.Errorf("%s: %d %s, want %d", name, got, body, status)
	}
	if after := w.scalar(t, m8State); after != before {
		t.Errorf("%s changed an account, its roles, boundaries or identity: %s -> %s", name, before, after)
	}
}

// Each invariant of the account commands refuses one real request: oneself, a Root target (absent from the
// directory, before oneself), a target or a role larger than the actor's grants, a target id that is not
// canonical, a taken email, an account that is not suspended, the last role. Suspend ends the target's session.
func TestM8AccountsOverHTTP(t *testing.T) {
	w := newM8AccountWorld(t)
	w.signIn(t)
	suspend := func(id string) m1Request { return m1Request{target: "/api/administration/users/" + id + "/suspend"} }

	w.m8Refused(t, "suspend of oneself", "hr", http.MethodPost, suspend(w.ids["hr"]), http.StatusForbidden)
	w.m8Refused(t, "assign to oneself", "hr", http.MethodPost, m1Request{"/api/administration/accounts/" + w.ids["hr"] + "/roles", `{"roleKey":"hr.employee"}`}, http.StatusForbidden)
	w.m8Refused(t, "an IAM suspend of Root", "hr", http.MethodPost, suspend(w.ids["root"]), http.StatusNotFound)
	rootAudits := w.scalar(t, m1Audits, w.ids["root"], "account.suspend")
	w.m8Committed(t, "Root suspending itself", "root", http.MethodPost, suspend(w.ids["root"]), http.StatusNotFound)
	if after := w.scalar(t, m1Audits, w.ids["root"], "account.suspend"); after == rootAudits {
		t.Errorf("Root's suspend of a target outside the directory left no audit")
	}

	larger := m8Target(t, w, m8Larger)
	w.m8Committed(t, "an IAM suspend of a larger account", "hr", http.MethodPost, suspend(larger), http.StatusNotFound)
	w.m8Committed(t, "an IAM reactivate of a larger account", "hr", http.MethodPost, m1Request{target: "/api/administration/users/" + larger + "/reactivate"}, http.StatusNotFound)
	w.m8Committed(t, "an IAM revoke from a larger account", "hr", http.MethodDelete, m1Request{target: "/api/administration/accounts/" + larger + "/roles/" + m1Employee}, http.StatusNotFound)
	w.m8Committed(t, "an IAM assign to a larger account", "hr", http.MethodPost, m1Request{"/api/administration/accounts/" + larger + "/roles", `{"roleKey":"` + m1Admin + `"}`}, http.StatusNotFound)
	within := m8Target(t, w)
	w.m8Committed(t, "an IAM assign of a role outside the actor's grants", "hr", http.MethodPost, m1Request{"/api/administration/accounts/" + within + "/roles", `{"roleKey":"` + m8Larger + `"}`}, http.StatusNotFound)
	w.succeed(t, "a Root assign of a role larger than hr's grants", "root", http.MethodPost, m1Request{"/api/administration/accounts/" + m8Target(t, w) + "/roles", `{"roleKey":"` + m8Larger + `"}`}, regexp.MustCompile(`^\{"status":"assigned"\}$`), http.StatusOK, "permission.role-assign")
	w.m8Refused(t, "a suspend of an upper-case id", "hr", http.MethodPost, suspend(strings.ToUpper(within)), http.StatusForbidden)
	w.m8Refused(t, "an assign to an upper-case id", "root", http.MethodPost, m1Request{"/api/administration/accounts/" + strings.ToUpper(within) + "/roles", `{"roleKey":"hr.admin"}`}, http.StatusForbidden)
	w.m8Refused(t, "a reactivate of an active account", "hr", http.MethodPost, m1Request{target: "/api/administration/users/" + within + "/reactivate"}, http.StatusConflict)
	w.m8Refused(t, "a revoke of the last role", "hr", http.MethodDelete, m1Request{target: "/api/administration/accounts/" + within + "/roles/hr.employee"}, http.StatusConflict)
	w.m8Refused(t, "an assign of a held role", "hr", http.MethodPost, m1Request{"/api/administration/accounts/" + within + "/roles", `{"roleKey":"hr.employee"}`}, http.StatusConflict)

	w.secrets["target"] = fixture.Session(t, w.stack, within, fixture.SessionSpec{})
	if status, body := w.send(http.MethodGet, "target", m1Request{target: "/api/auth/session"}, nil); status != http.StatusOK {
		t.Fatalf("session of the target before suspend: %d %s", status, body)
	}
	before := w.scalar(t, m8Epoch, within)
	epoch, err := strconv.Atoi(strings.TrimPrefix(before, "active:"))
	if err != nil {
		t.Fatalf("target before suspend: %s", before)
	}
	w.succeed(t, "suspend", "hr", http.MethodPost, suspend(within), regexp.MustCompile(`^\{"status":"suspended"\}$`), http.StatusOK, "account.suspend")
	if after := w.scalar(t, m8Epoch, within); after != "suspended:"+strconv.Itoa(epoch+1) {
		t.Errorf("suspend moved the account from %s to %s", before, after)
	}
	if status, body := w.send(http.MethodGet, "target", m1Request{target: "/api/auth/session"}, nil); !m1Refused(http.StatusUnauthorized).answers(status, body) {
		t.Errorf("session of the target after suspend: %d %s", status, body)
	}

	provision := func(email, roleKey string) m1Request {
		return m1Request{"/api/administration/accounts", `{"email":"` + email + `","roleKey":"` + roleKey + `"}`}
	}
	w.succeed(t, "provision", "hr", http.MethodPost, provision("m8-taken@example.test", "hr.employee"), regexp.MustCompile(`^\{"userId":"`+m1UUID+`","email":"m8-taken@example\.test","state":"pending"\}$`), http.StatusCreated, "account.provision")
	w.m8Refused(t, "a provision of a taken email", "hr", http.MethodPost, provision("M8-Taken@example.test", "hr.employee"), http.StatusConflict)
	w.m8Committed(t, "a provision of an absent role", "hr", http.MethodPost, provision("m8-absent@example.test", "custom.m8_absent"), http.StatusNotFound)
	w.m8Committed(t, "a provision of a role outside the actor's grants", "hr", http.MethodPost, provision("m8-larger@example.test", m8Larger), http.StatusNotFound)
	w.m8Committed(t, "a provision by a denied actor", "denied", http.MethodPost, provision("m8-denied@example.test", "hr.employee"), http.StatusNotFound)
}

// m8RootAbsent: Root's command on itself is not found (Root is outside the directory, before oneself) and leaves
// exactly one more audit of kind by Root.
func (w *m1World) m8RootAbsent(t *testing.T, name, method string, r m1Request, kind string) {
	t.Helper()
	audits, err := strconv.Atoi(w.scalar(t, m1Audits, w.ids["root"], kind))
	if err != nil {
		t.Fatal(err)
	}
	w.m8Committed(t, name, "root", method, r, http.StatusNotFound)
	if after := w.scalar(t, m1Audits, w.ids["root"], kind); after != strconv.Itoa(audits+1) {
		t.Errorf("%s: %d %s audits by Root, then %s", name, audits, kind, after)
	}
}

// m8EndsTheSession sends a successful identity command on target, whose session must work before and answer 401
// after, with auth_epoch one higher; it returns the account state after.
func (w *m1World) m8EndsTheSession(t *testing.T, name, method string, r m1Request, target, kind string) string {
	t.Helper()
	w.secrets["target"] = fixture.Session(t, w.stack, target, fixture.SessionSpec{})
	if status, body := w.send(http.MethodGet, "target", m1Request{target: "/api/auth/session"}, nil); status != http.StatusOK {
		t.Fatalf("%s: session of the target before: %d %s", name, status, body)
	}
	state, epoch, _ := strings.Cut(w.scalar(t, m8Epoch, target), ":")
	before, err := strconv.Atoi(epoch)
	if err != nil {
		t.Fatalf("%s: target %s:%s", name, state, epoch)
	}
	shape := regexp.MustCompile(`^\{"status":"(changed|reset)"\}$`)
	w.succeed(t, name, "hr", method, r, shape, http.StatusOK, kind)
	state, epoch, _ = strings.Cut(w.scalar(t, m8Epoch, target), ":")
	if epoch != strconv.Itoa(before+1) {
		t.Errorf("%s moved auth_epoch from %d to %s", name, before, epoch)
	}
	if status, body := w.send(http.MethodGet, "target", m1Request{target: "/api/auth/session"}, nil); !m1Refused(http.StatusUnauthorized).answers(status, body) {
		t.Errorf("%s: session of the target after: %d %s", name, status, body)
	}
	return state
}

// m8TwoProviders is w served by a second boot over the same database whose configuration has two OIDC providers:
// there is no one issuer to enroll at. (A configuration without the enabled provider does not boot: disabling it
// needs the offline revoke.)
func m8TwoProviders(t *testing.T, w *m1World) *m1World {
	t.Helper()
	cfg := configOver()
	cfg.OidcProviders = append(cfg.OidcProviders, config.ProductOidcProviderConfig{Issuer: "https://second.example.test", Version: "1"})
	running, err := boot(t.Context(), cfg, quietLogger(), stepsOver(w.stack))
	if step, failed := errors.AsType[*BootError](err); failed {
		t.Fatalf("boot step %s: %s", step.Step, test.Redact(step.Err))
	}
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		running.release()
		if err := running.listener.Close(); err != nil {
			t.Error(err)
		}
	})
	other := *w
	other.handler = running.server.Handler
	return &other
}

// The boundary and identity commands refuse each invariant with one real request: oneself (403), a Root target
// (404, before oneself, Root's own audited absent), a target larger than the actor's grants (404, chosen so that
// without the comparison the command would succeed), an id that is not canonical (403), a package the IAM actor
// is not bound to itself (403 before the 409), a package bound already or not bound (409), a taken email and no
// second factor (409), not exactly one provider (503). Each identity command ends the target's sessions.
func TestM8BoundariesAndIdentityOverHTTP(t *testing.T) {
	w := newM8AccountWorld(t)
	w.signIn(t)
	bind := func(id string) m1Request { return m1Request{m8Path(id, "/boundaries"), m8IdentityRef} }
	unbind := func(id string) m1Request {
		return m1Request{target: m8Path(id, "/boundaries/identityAdministration/1")}
	}
	mfa := func(id string) m1Request { return m1Request{target: m8Path(id, "/mfa/reset")} }

	w.m8Refused(t, "a bind on oneself", "hr", http.MethodPost, bind(w.ids["hr"]), http.StatusForbidden)
	w.m8Refused(t, "an unbind of oneself", "hr", http.MethodDelete, unbind(w.ids["hr"]), http.StatusForbidden)
	w.m8Refused(t, "an IAM bind on Root", "hr", http.MethodPost, bind(w.ids["root"]), http.StatusNotFound)
	w.m8RootAbsent(t, "Root binding itself", http.MethodPost, bind(w.ids["root"]), "access.account.bindBoundary")

	larger := m8Target(t, w, m8Larger)
	w.m8Committed(t, "an IAM bind on a larger account", "hr", http.MethodPost, bind(larger), http.StatusNotFound)
	within := m8Target(t, w)
	w.m8Refused(t, "a bind on an upper-case id", "hr", http.MethodPost, bind(strings.ToUpper(within)), http.StatusForbidden)
	w.m8Refused(t, "an unbind of a package not bound", "hr", http.MethodDelete, unbind(within), http.StatusConflict)

	w.ids["binder"] = fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{m1Employee, m8Accounts}}).ID
	w.exec(t, m8Bind, w.ids["binder"], "account.bindBoundary")
	w.secrets["binder"] = fixture.Session(t, w.stack, w.ids["binder"], fixture.SessionSpec{Fresh: true})
	w.m8Refused(t, "an IAM bind of a package the actor is not bound to", "binder", http.MethodPost, bind(within), http.StatusForbidden)
	w.succeed(t, "a bind", "hr", http.MethodPost, bind(within), regexp.MustCompile(`^\{"status":"bound"\}$`), http.StatusOK, "permission.boundary-assign")
	w.m8Refused(t, "a bind of a package bound already", "hr", http.MethodPost, bind(within), http.StatusConflict)
	w.m8Refused(t, "a bind by an actor not bound, on a package bound already", "binder", http.MethodPost, bind(within), http.StatusForbidden)
	w.succeed(t, "an unbind", "hr", http.MethodDelete, unbind(within), regexp.MustCompile(`^\{"status":"unbound"\}$`), http.StatusOK, "permission.boundary-revoke")

	w.holdIdentity(t, m8Mfa)
	w.signIn(t)
	w.exec(t, m8RecoveryCode, w.ids["hr"])
	w.m8Refused(t, "an mfa reset of oneself", "hr", http.MethodPost, mfa(w.ids["hr"]), http.StatusForbidden)
	w.m8Refused(t, "an IAM mfa reset of Root", "hr", http.MethodPost, mfa(w.ids["root"]), http.StatusNotFound)
	w.m8RootAbsent(t, "Root resetting its own second factor", http.MethodPost, mfa(w.ids["root"]), "identity.mfa-reset-by-permission")
	w.exec(t, m8RecoveryCode, larger)
	w.m8Committed(t, "an IAM mfa reset of a larger account", "hr", http.MethodPost, mfa(larger), http.StatusNotFound)
	w.m8Refused(t, "an mfa reset of an upper-case id", "hr", http.MethodPost, mfa(strings.ToUpper(within)), http.StatusForbidden)
	w.m8Refused(t, "an mfa reset without a second factor", "hr", http.MethodPost, mfa(within), http.StatusConflict)
	w.exec(t, m8RecoveryCode, within)
	w.m8EndsTheSession(t, "an mfa reset", http.MethodPost, mfa(within), within, "identity.mfa-reset-by-permission")
	if codes := w.scalar(t, `SELECT count(*)::text FROM mfa_recovery_code WHERE user_id=$1`, within); codes != "0" {
		t.Errorf("recovery codes left after an mfa reset: %s", codes)
	}

	w.holdIdentity(t, m8Email)
	w.signIn(t)
	email := func(id, address string) m1Request {
		return m1Request{m8Path(id, "/email"), `{"email":"` + address + `"}`}
	}
	mailed := m8Mailed(t, w)
	w.m8Refused(t, "an email change of oneself", "hr", http.MethodPut, email(w.ids["hr"], "m8-self@example.test"), http.StatusForbidden)
	w.m8Refused(t, "an IAM email change of Root", "hr", http.MethodPut, email(w.ids["root"], "m8-root@example.test"), http.StatusNotFound)
	w.m8RootAbsent(t, "Root changing its own email", http.MethodPut, email(w.ids["root"], "m8-root@example.test"), "identity.email-change")
	w.m8Refused(t, "an email change of an upper-case id", "hr", http.MethodPut, email(strings.ToUpper(mailed), "m8-upper@example.test"), http.StatusForbidden)
	taken := w.scalar(t, `SELECT email_canonical FROM app_user WHERE id=$1`, m8Mailed(t, w))
	w.m8Refused(t, "an email change to a taken email", "hr", http.MethodPut, email(mailed, strings.ToUpper(taken)), http.StatusConflict)
	w.m8EndsTheSession(t, "an email change", http.MethodPut, email(mailed, "M8-New@example.test"), mailed, "identity.email-change")
	if changed := w.scalar(t, `SELECT email_canonical||':'||email_verified FROM app_user WHERE id=$1`, mailed); changed != "m8-new@example.test:false" {
		t.Errorf("email after the change: %s", changed)
	}

	w.holdIdentity(t, m8Google)
	w.signIn(t)
	google := func(id string) m1Request { return m1Request{target: m8Path(id, "/google/reset")} }
	w.m8Refused(t, "a Google reset of oneself", "hr", http.MethodPost, google(w.ids["hr"]), http.StatusForbidden)
	w.m8RootAbsent(t, "Root resetting its own Google binding", http.MethodPost, google(w.ids["root"]), "identity.binding-reset")
	w.m8Refused(t, "a Google reset of an account without an email", "hr", http.MethodPost, google(within), http.StatusConflict)
	reset := m8Mailed(t, w)
	if state := w.m8EndsTheSession(t, "a Google reset", http.MethodPost, google(reset), reset, "identity.binding-reset"); state != "pending" {
		t.Errorf("state after a Google reset: %s", state)
	}
	if bindings := w.scalar(t, `SELECT count(*) FILTER (WHERE enabled)||':'||count(*) FROM external_identity WHERE user_id=$1`, reset); bindings != "0:1" {
		t.Errorf("bindings after a Google reset: %s", bindings)
	}

	two := m8TwoProviders(t, w)
	two.m8Refused(t, "an email change with two providers", "hr", http.MethodPut, email(m8Mailed(t, w), "m8-two@example.test"), http.StatusServiceUnavailable)
	two.m8Refused(t, "a Google reset with two providers", "hr", http.MethodPost, google(m8Mailed(t, w)), http.StatusServiceUnavailable)
	w.holdIdentity(t, m8Mfa)
	target := m8Target(t, w)
	w.exec(t, m8RecoveryCode, target)
	two.succeed(t, "an mfa reset with two providers", "hr", http.MethodPost, mfa(target), regexp.MustCompile(`^\{"status":"reset"\}$`), http.StatusOK, "identity.mfa-reset-by-permission")
}
