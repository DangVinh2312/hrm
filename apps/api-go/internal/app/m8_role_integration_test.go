//go:build integration

package app

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"

	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/test/fixture"
)

const (
	m8Roles       = "/api/administration/roles"
	m8StoredPairs = `SELECT coalesce(string_agg(convert_from(permission_key,'UTF8')||' '||convert_from(template_key,'UTF8'), ',' ORDER BY permission_key, template_key),'')
       FROM policy_rule WHERE role_key=convert_to($1,'UTF8') AND effect='allow' AND managed_by='runtime' AND user_id IS NULL AND template_version=1 AND parameters='{}'`
	m8RoleRow = `SELECT label||':'||(SELECT count(*) FROM policy_rule p WHERE p.role_key=d.role_key) FROM role_definition d
       WHERE d.role_key=convert_to($1,'UTF8') AND d.managed_by='runtime'`
	m8InsertParameterised = `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to($2,'UTF8'),convert_to($1,'UTF8'),'allow',convert_to($3,'UTF8'),1,'{"p":"x"}','runtime')`
	m8CodeRoleWrites = `SELECT count(*)::text FROM policy_rule
       WHERE convert_from(permission_key,'UTF8') IN ('role.create','role.update','role.delete') AND managed_by='code'`
)

var m8Deleted = regexp.MustCompile(`^\{"status":"deleted"\}$`)

func m8Update(key, label, grants, digest string) m1Request {
	return m1Request{m8Roles + "/" + key, `{"label":"` + label + `","grants":[` + grants + `],"expectedDigest":"` + digest + `"}`}
}

// m8Holder is a new IAM account under name holding exactly pairs through one runtime role, with a fresh
// session; it returns the key of that role.
func m8Holder(t *testing.T, w *m1World, name string, pairs ...[2]string) string {
	t.Helper()
	key := m8Key(w)
	w.exec(t, m8InsertRole, key, "Matrix holder")
	for _, held := range pairs {
		w.exec(t, m8InsertGrant, key, held[0], "allow", held[1])
	}
	w.ids[name] = fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{key}}).ID
	w.secrets[name] = fixture.Session(t, w.stack, w.ids[name], fixture.SessionSpec{Fresh: true})
	return key
}

// Derived from the declarations, not from the catalog of the route: a pair the command refused would show.
func TestM8RootPutsEverySelectablePairIntoOneRole(t *testing.T) {
	w := newM8World(t)
	source := declarations.Source().Declarations
	var names, pairs []string
	for _, resource := range source.Resources {
		if resource.Key == "document" {
			continue
		}
		for action := range resource.Actions {
			for _, template := range source.Templates {
				if template.Resource != resource.Key {
					continue
				}
				if template.Version != 1 || len(template.Parameters) != 0 {
					t.Fatalf("template %s@%d: the fixture writes version 1 without parameters", template.Key, template.Version)
				}
				permission := resource.Key + "." + action
				names = append(names, permission+" "+template.Key)
				pairs = append(pairs, m8Pair(permission, template.Key))
			}
		}
	}
	if len(pairs) <= 100 || len(pairs) > 300 {
		t.Fatalf("%d selectable pairs", len(pairs))
	}

	key := m8Key(w)
	m8Create(t, w, key, strings.Join(pairs, ","))

	stored := strings.Split(w.scalar(t, m8StoredPairs, key), ",")
	slices.Sort(stored)
	slices.Sort(names)
	if !slices.Equal(stored, names) {
		t.Errorf("stored %d pairs of %d sent:\n got %v\nwant %v", len(stored), len(names), stored, names)
	}
}

// Each refusal is 403 with no role, rule, audit or revision written: a pair outside the actor's set, another
// template of a permission it holds, and any set that holds a deny or a rule attached to the user, which
// proves nothing even for a pair it holds.
func TestM8AnIAMActorWritesNoRoleBeyondItsOwnGrants(t *testing.T) {
	w := newM8World(t)
	create := func(grants string) m1Request { return m1Request{m8Roles, m8CreateBody(m8Key(w), grants)} }
	roleCreate, roleRead := [2]string{"role.create", "role"}, [2]string{"role.read", "role"}
	settingRead := m8Pair("setting.read", "setting")
	allEmployees, selfEmployee := m8Pair("employee.read", "allEmployees"), m8Pair("employee.read", "selfEmployee")

	m8Holder(t, w, "holder", roleCreate, roleRead)
	w.m8Refused(t, "a template of another resource", "holder", http.MethodPost, create(m8Pair("role.read", "setting")), http.StatusBadRequest)
	w.m8Refused(t, "a held pair with one outside the set", "holder", http.MethodPost, create(m8RoleRead+","+settingRead), http.StatusForbidden)
	w.m8Refused(t, "a pair outside the set", "holder", http.MethodPost, create(settingRead), http.StatusForbidden)
	w.m8Refused(t, "another permission of the same resource", "holder", http.MethodPost, create(m8Pair("role.update", "role")), http.StatusForbidden)

	m8Holder(t, w, "wide", roleCreate, [2]string{"employee.read", "allEmployees"})
	w.m8Refused(t, "another template of a held permission", "wide", http.MethodPost, create(selfEmployee), http.StatusForbidden)

	denyRole := m8Holder(t, w, "withDeny", roleCreate, roleRead)
	w.exec(t, m8InsertGrant, denyRole, "setting.read", "deny", "setting")
	w.m8Refused(t, "a held pair, by an actor whose role holds a deny", "withDeny", http.MethodPost, create(m8RoleRead), http.StatusForbidden)

	m8Holder(t, w, "withUserRule", roleCreate, roleRead)
	w.exec(t, m1InsertRule, w.ids["withUserRule"], "setting.read", "allow", "setting")
	w.m8Refused(t, "a held pair, by an actor with a rule attached to it", "withUserRule", http.MethodPost, create(m8RoleRead), http.StatusForbidden)

	w.succeed(t, "a role inside the set", "holder", http.MethodPost, create(m8RoleRead), m8Written, http.StatusCreated, "permission.role-create")
	w.succeed(t, "an empty role", "holder", http.MethodPost, create(""), m8Written, http.StatusCreated, "permission.role-create")

	m8Holder(t, w, "editor", [2]string{"role.update", "role"}, roleRead, [2]string{"employee.read", "allEmployees"})
	w.exec(t, m8Bind, w.ids["editor"], "role.update")
	key := m8Key(w)
	digest := m8Create(t, w, key, m8RoleRead)
	w.m8Refused(t, "an update to another template of a held permission", "editor", http.MethodPut, m8Update(key, "Matrix role", m8RoleRead+","+selfEmployee, digest), http.StatusForbidden)
	w.m8Refused(t, "an update adding a pair outside the set", "editor", http.MethodPut, m8Update(key, "Matrix role", m8RoleRead+","+settingRead, digest), http.StatusForbidden)
	w.succeed(t, "an update inside the set", "editor", http.MethodPut, m8Update(key, "Matrix role", m8RoleRead+","+allEmployees, digest), m8Written, http.StatusOK, "permission.role-update")
}

func TestM8ATakenRoleKeyIsAConflictThatChangesNothing(t *testing.T) {
	w := newM8World(t)
	key := m8Key(w)
	m8Create(t, w, key, m8RoleRead)
	second := m1Request{m8Roles, `{"key":"` + key + `","label":"Second","grants":[` + m8Pair("setting.read", "setting") + `]}`}
	w.m8Refused(t, "a Root create of a taken key", "root", http.MethodPost, second, http.StatusConflict)
	w.m8Refused(t, "an IAM create of a taken key", "hr", http.MethodPost, m1Request{m8Roles, m8CreateBody(key, "")}, http.StatusConflict)
	if row := w.scalar(t, m8RoleRow, key); row != "Matrix role:1" {
		t.Errorf("the role after two refused creates: %s", row)
	}
}

// hr holds role.create with no parameters, so each odd rule would be inside its set if the comparison read
// only the permission and the template: a deny or a parameterised rule proves nothing instead.
func TestM8ARoleWithADenyOrAParameterisedRuleIsNotFoundForAnIAMActor(t *testing.T) {
	w := newM8World(t)
	for name, odd := range map[string]func(key string){
		"a deny":               func(key string) { w.exec(t, m8InsertGrant, key, "role.create", "deny", "role") },
		"a parameterised rule": func(key string) { w.exec(t, m8InsertParameterised, key, "role.create", "role") },
	} {
		key := m8Key(w)
		m8Create(t, w, key, m8RoleRead)
		odd(key)
		update := m8Update(key, "Matrix role", m8RoleRead, w.m8Digest(t, key))
		w.m8Refused(t, "an IAM update of a role holding "+name, "hr", http.MethodPut, update, http.StatusNotFound)
		w.m8Refused(t, "an IAM delete of a role holding "+name, "hr", http.MethodDelete, m1Request{target: m8Roles + "/" + key}, http.StatusNotFound)
		w.m8Refused(t, "a Root update of a role holding "+name, "root", http.MethodPut, update, http.StatusConflict)
	}

	key := m8Key(w)
	digest := m8Create(t, w, key, m8RoleRead)
	w.succeed(t, "an IAM update of a plain role", "hr", http.MethodPut, m8Update(key, "Matrix renamed", m8RoleRead, digest), m8Written, http.StatusOK, "permission.role-update")
	w.succeed(t, "an IAM delete of a plain role", "hr", http.MethodDelete, m1Request{target: m8Roles + "/" + key}, m8Deleted, http.StatusOK, "permission.role-delete")
}

// The stale session is a working Root session: it reads the matrix, and the same writes pass once fresh.
func TestM8RootWithoutAFreshAuthenticationWritesNoRole(t *testing.T) {
	w := newM8World(t)
	key := m8Key(w)
	digest := m8Create(t, w, key, m8RoleRead)
	w.secrets["staleRoot"] = fixture.Session(t, w.stack, w.ids["root"], fixture.SessionSpec{})
	if status, body := w.send(http.MethodGet, "staleRoot", m1Request{target: m8Roles}, nil); status != http.StatusOK {
		t.Fatalf("the matrix read by Root without a fresh authentication: %d %s", status, body)
	}

	create := m1Request{m8Roles, m8CreateBody(m8Key(w), m8RoleRead)}
	update := m8Update(key, "Matrix renamed", m8RoleRead, digest)
	remove := m1Request{target: m8Roles + "/" + key}
	w.m8Refused(t, "a create by Root without a fresh authentication", "staleRoot", http.MethodPost, create, http.StatusForbidden)
	w.m8Refused(t, "an update by Root without a fresh authentication", "staleRoot", http.MethodPut, update, http.StatusForbidden)
	w.m8Refused(t, "a delete by Root without a fresh authentication", "staleRoot", http.MethodDelete, remove, http.StatusForbidden)

	w.succeed(t, "the same create by a fresh Root", "root", http.MethodPost, create, m8Written, http.StatusCreated, "permission.role-create")
	w.succeed(t, "the same update by a fresh Root", "root", http.MethodPut, update, m8Written, http.StatusOK, "permission.role-update")
	w.succeed(t, "the same delete by a fresh Root", "root", http.MethodDelete, remove, m8Deleted, http.StatusOK, "permission.role-delete")
}

// The account is fresh and bound for update and delete, and the roles are empty (inside every set), so the
// only thing it lacks is a grant of the release.
func TestM8TheReleaseGivesHrAdminNoRoleWrite(t *testing.T) {
	w := newM8World(t)
	w.ids["admin"] = fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{m1Employee, m1Admin}}).ID
	for _, permission := range []string{"role.update", "role.delete"} {
		w.exec(t, m8Bind, w.ids["admin"], permission)
	}
	w.secrets["admin"] = fixture.Session(t, w.stack, w.ids["admin"], fixture.SessionSpec{Fresh: true})
	key := m8Key(w)
	digest := m8Create(t, w, key, "")

	w.m8Refused(t, "a create by hr.admin", "admin", http.MethodPost, m1Request{m8Roles, m8CreateBody(m8Key(w), "")}, http.StatusForbidden)
	w.m8Refused(t, "an update by hr.admin", "admin", http.MethodPut, m8Update(key, "Matrix role", "", digest), http.StatusForbidden)
	w.m8Refused(t, "a delete by hr.admin", "admin", http.MethodDelete, m1Request{target: m8Roles + "/" + key}, http.StatusForbidden)
	w.m8Refused(t, "a delete of an absent role by hr.admin", "admin", http.MethodDelete, m1Request{target: m8Roles + "/" + m8Key(w)}, http.StatusForbidden)
	if granted := w.scalar(t, m8CodeRoleWrites); granted != "0" {
		t.Errorf("the release grants %s role writes", granted)
	}

	w.succeed(t, "the same update by Root", "root", http.MethodPut, m8Update(key, "Matrix role", "", digest), m8Written, http.StatusOK, "permission.role-update")
	w.succeed(t, "the same delete by Root", "root", http.MethodDelete, m1Request{target: m8Roles + "/" + key}, m8Deleted, http.StatusOK, "permission.role-delete")
}
