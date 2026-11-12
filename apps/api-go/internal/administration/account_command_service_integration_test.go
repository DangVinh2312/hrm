//go:build integration

package administration

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/grant"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

const (
	scopeInsertRole = `INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to($1,'UTF8'),'runtime','Scope fixture')`
	scopeInsertRule = `INSERT INTO policy_rule(rule_id,permission_key,role_key,user_id,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to($1,'UTF8'),convert_to($2,'UTF8'),$3,$4,convert_to($5,'UTF8'),1,CAST($6 AS jsonb),'runtime')`
	scopeInsertMany = `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
      SELECT gen_random_uuid(),convert_to('account.read','UTF8'),convert_to($1,'UTF8'),'allow',convert_to('allAccounts','UTF8'),1,jsonb_build_object('i',g),'runtime'
        FROM generate_series(1,CAST($2 AS int)) g`
	scopeHeld = `SELECT coalesce(string_agg(convert_from(role_key,'UTF8'),',' ORDER BY role_key),'') FROM user_role WHERE user_id=$1`
)

type scopeRule struct{ permission, effect, template, parameters string }

func allowed(permission string) scopeRule {
	return scopeRule{permission, "allow", "allAccounts", "{}"}
}

type scopeFixture struct {
	stack *test.Stack
	conn  *pgx.Conn
	core  *core.Core
	roles int
}

func newScopeFixture(t *testing.T) *scopeFixture {
	t.Helper()
	s := test.NewDatabase(t)
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	return &scopeFixture{stack: s, conn: conn, core: c}
}

func (f *scopeFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func (f *scopeFixture) one(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	if err := f.conn.QueryRow(t.Context(), sql, args...).Scan(&value); err != nil {
		t.Fatal(test.Redact(err))
	}
	return value
}

func (f *scopeFixture) role(t *testing.T, rules ...scopeRule) string {
	t.Helper()
	f.roles++
	key := "custom.scope_" + strconv.Itoa(f.roles)
	f.exec(t, scopeInsertRole, key)
	for _, rule := range rules {
		f.exec(t, scopeInsertRule, rule.permission, key, nil, rule.effect, rule.template, rule.parameters)
	}
	return key
}

func (f *scopeFixture) account(t *testing.T, roles ...string) string {
	t.Helper()
	return fixture.Account(t, f.stack, fixture.AccountSpec{Roles: roles}).ID
}

func (f *scopeFixture) attach(t *testing.T, userID string, rule scopeRule) {
	t.Helper()
	f.exec(t, scopeInsertRule, rule.permission, nil, userID, rule.effect, rule.template, rule.parameters)
}

func (f *scopeFixture) holds(t *testing.T, userID, role string) bool {
	t.Helper()
	return strings.Contains(","+f.one(t, scopeHeld, userID)+",", ","+role+",")
}

func iam(id string) authority.Actor { return authority.Actor{ID: id, Kind: "iam"} }

// work runs the work of an account command as the frame of the command does after it found the target: in an
// admin transaction, with the verified actor. done is false for a not found.
func work[I any](t *testing.T, f *scopeFixture, actor authority.Actor, action keys.AccountAction, command func(authority.AdminContext, I) (*audit.Event, error), input I) (bool, error) {
	t.Helper()
	done := false
	err := admin(t, f.stack, func(tx *database.Tx) error {
		event, err := command(authority.AdminContext{Tx: tx, Actor: actor, Permission: string(keys.AccountResourceAccount) + "." + string(action)}, input)
		done = event != nil
		return err
	})
	return done, err
}

func (f *scopeFixture) change(t *testing.T, actor authority.Actor, assigning bool, target, role string) (bool, error) {
	t.Helper()
	action := keys.AccountActionRevokeRole
	if assigning {
		action = keys.AccountActionAssignRole
	}
	return work(t, f, actor, action, commands{core: f.core}.changeRole(assigning), roleChange{UserID: target, RoleKey: role})
}

func (f *scopeFixture) notFound(t *testing.T, name string, actor authority.Actor, assigning bool, target, role string) {
	t.Helper()
	before := f.one(t, scopeHeld, target)
	done, err := f.change(t, actor, assigning, target, role)
	if err != nil || done {
		t.Errorf("%s: done=%v error=%s", name, done, test.Redact(err))
	}
	if after := f.one(t, scopeHeld, target); after != before {
		t.Errorf("%s moved the roles of the target from %s to %s", name, before, after)
	}
}

func (f *scopeFixture) changes(t *testing.T, name string, actor authority.Actor, assigning bool, target, role string) {
	t.Helper()
	done, err := f.change(t, actor, assigning, target, role)
	if err != nil || !done {
		t.Errorf("%s: done=%v error=%s", name, done, test.Redact(err))
	}
	if f.holds(t, target, role) != assigning {
		t.Errorf("%s left the target holding %s", name, f.one(t, scopeHeld, target))
	}
}

func TestAnIAMActorAssignsOnlyARoleProvenWithinItsOwnGrants(t *testing.T) {
	f := newScopeFixture(t)
	read := allowed("account.read")
	actor := iam(f.account(t, f.role(t, read)))
	target := f.account(t, f.role(t))

	for name, rules := range map[string][]scopeRule{
		"a role with another template of a held permission": {{"account.read", "allow", "setting", "{}"}},
		"a role with a parameter on a held permission":      {{"account.read", "allow", "allAccounts", `{"scope":"x"}`}},
		"a role with a deny beside a held grant":            {read, {"account.provision", "deny", "allAccounts", "{}"}},
	} {
		f.notFound(t, name, actor, true, target, f.role(t, rules...))
	}
	f.changes(t, "a role equal to the actor's grants", actor, true, target, f.role(t, read))
	f.changes(t, "a role without rules", actor, true, target, f.role(t))

	inSet := f.role(t, read)
	denying := iam(f.account(t, f.role(t, read, scopeRule{"account.provision", "deny", "allAccounts", "{}"})))
	f.notFound(t, "an actor holding a deny", denying, true, target, inSet)
	attached := iam(f.account(t, f.role(t, read)))
	f.attach(t, attached.ID, read)
	f.notFound(t, "an actor with a rule attached to the account", attached, true, target, inSet)
}

func TestARoleOrAnActorReadCutAtItsLimitProvesNothing(t *testing.T) {
	f := newScopeFixture(t)
	read := allowed("account.read")
	big := f.role(t, read)
	f.exec(t, scopeInsertMany, big, keys.MaxRoleGrants)
	edge := f.role(t, read)
	f.exec(t, scopeInsertMany, edge, keys.MaxRoleGrants-1)
	actor := iam(f.account(t, big))
	target := f.account(t, f.role(t))

	f.notFound(t, "a role of one rule more than a read of a role holds", actor, true, target, big)
	f.changes(t, "a role of exactly the rules a read holds", actor, true, target, edge)
	f.changes(t, "Root assigning the role an IAM actor cannot prove", authority.Actor{ID: fixture.Root(t, f.stack).ID, Kind: "root"}, true, target, big)

	wide := f.role(t, read)
	f.exec(t, scopeInsertMany, wide, grant.MaxFactRows)
	cut := iam(f.account(t, wide))
	held := f.role(t)
	plain := f.account(t, held, f.role(t, read))
	f.notFound(t, "an assign by an actor whose grants exceed one read", cut, true, plain, f.role(t, read))
	f.notFound(t, "a revoke by an actor whose grants exceed one read", cut, false, plain, held)
}

func TestATargetNotProvenWithinTheActorsGrantsIsNotFoundForEveryCommand(t *testing.T) {
	f := newScopeFixture(t)
	read, suspend := allowed("account.read"), allowed("account.suspend")
	actor := iam(f.account(t, f.role(t, read, suspend)))
	inSet, unheld := f.role(t, read), f.role(t)
	m := commands{core: f.core}

	targets := map[string]string{}
	kept := map[string]string{}
	for name, rule := range map[string]scopeRule{
		"a target holding a deny":                        {"account.read", "deny", "allAccounts", "{}"},
		"a target with another template of a permission": {"account.read", "allow", "setting", "{}"},
		"a target with a parameter on a permission":      {"account.read", "allow", "allAccounts", `{"scope":"x"}`},
	} {
		kept[name] = f.role(t)
		targets[name] = f.account(t, f.role(t, rule), kept[name])
	}
	const attached = "a target with a rule attached to the account"
	kept[attached] = f.role(t)
	targets[attached] = f.account(t, f.role(t), kept[attached])
	f.attach(t, targets[attached], read)

	for name, target := range targets {
		f.notFound(t, "an assign to "+name, actor, true, target, inSet)
		f.notFound(t, "a revoke of a held role from "+name, actor, false, target, kept[name])
		f.notFound(t, "a revoke of a role not held from "+name, actor, false, target, unheld)

		before := accountFacts(t, f.stack, target)
		if done, err := work(t, f, actor, keys.AccountActionSuspend, m.suspend, accountID(target)); err != nil || done {
			t.Errorf("a suspend of %s: done=%v error=%s", name, done, test.Redact(err))
		}
		if done, err := work(t, f, actor, keys.AccountActionReactivate, m.reactivate, accountID(target)); err != nil || done {
			t.Errorf("a reactivate of %s, which is active: done=%v error=%s", name, done, test.Redact(err))
		}
		if after := accountFacts(t, f.stack, target); after != before {
			t.Errorf("%s went from %s to %s", name, before, after)
		}
	}

	equal := f.account(t, f.role(t, read, suspend), f.role(t))
	f.changes(t, "an assign to a target of equal grants", actor, true, equal, inSet)
	f.changes(t, "a revoke from a target of equal grants", actor, false, equal, inSet)
	if done, err := work(t, f, actor, keys.AccountActionReactivate, m.reactivate, accountID(equal)); !errors.Is(err, apperror.ErrCommandRejected) || done {
		t.Errorf("a reactivate of an active target within the actor's grants: done=%v error=%s", done, test.Redact(err))
	}
	smaller := f.account(t, f.role(t, suspend))
	f.changes(t, "an assign to a target of fewer grants", actor, true, smaller, inSet)
	spread := iam(f.account(t, f.role(t, read), f.role(t, suspend)))
	f.changes(t, "an assign by an actor whose grants come from two roles", spread, true, f.account(t, f.role(t, read, suspend)), inSet)
}
