//go:build integration

package authority_test

import (
	"errors"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/test/fixture"
)

const grantSuspend = `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('account.suspend','UTF8'),$1,'allow',convert_to('allAccounts','UTF8'),1,'{}','runtime')`
const bindSuspend = `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('account.suspend','UTF8'),convert_to('accountAdministration','UTF8'),1)`

func suspendAccount() *authority.AdminCommand[string, bool] {
	return authority.NewAdminCommand("account", "suspend", func(c authority.AdminContext, target string) (bool, error) {
		row, err := c.Detail(target)
		if err != nil || row == nil {
			return false, err
		}
		if _, err := c.Reaches("account", "read", target, true); err != nil {
			return false, err
		}
		if _, err := c.Tx.Exec(`UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`, target); err != nil {
			return false, err
		}
		if c.Actor.Kind == "iam" {
			return true, audit.Append(c.Tx, audit.Event{Kind: audit.KindAccountSuspend, Actor: c.Actor.ID, Detail: audit.AccountChange{Permission: c.Permission, TargetUserID: target}})
		}
		return true, nil
	}, func(c authority.AdminContext, target string, done bool) *audit.Event {
		outcome := "ok"
		if !done {
			outcome = "absent"
		}
		return &audit.Event{Kind: audit.KindAccountSuspend, Actor: c.Actor.ID, Detail: audit.AccountChange{Permission: c.Permission, TargetUserID: target, Root: &audit.RootOutcome{Outcome: outcome}}}
	})
}

func (f *authorityFixture) state(t *testing.T, id string) string {
	t.Helper()
	var state string
	requireDB(t, f.conn.QueryRow(t.Context(), "SELECT state FROM app_user WHERE id=$1", id).Scan(&state))
	return state
}

func TestAdministerRunsOnlyForAGrantInsideTheBoundary(t *testing.T) {
	f := newAuthorityFixture(t)
	command := suspendAccount()
	a := f.authority(t, authority.DefaultCapabilities(), command)
	target := fixture.Account(t, f.s, fixture.AccountSpec{})
	actor := fixture.Account(t, f.s, fixture.AccountSpec{})
	secret := fixture.Session(t, f.s, actor.ID, fixture.SessionSpec{Fresh: true})

	if _, err := authority.Administer(t.Context(), a, secret, command, target.ID); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("an actor without a grant ran an admin command")
	}
	f.exec(t, grantSuspend, actor.ID)
	if _, err := authority.Administer(t.Context(), a, secret, command, target.ID); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("a grant outside its boundary ran an admin command")
	}
	if f.state(t, target.ID) != "active" {
		t.Fatal("a refused admin command changed the target")
	}
	f.exec(t, bindSuspend, actor.ID)
	root := fixture.Root(t, f.s)
	done, err := authority.Administer(t.Context(), a, secret, command, root.ID)
	requireDB(t, err)
	if done || f.state(t, root.ID) != "active" {
		t.Fatal("an IAM actor reached the Root account")
	}
	f.exec(t, `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('account.read','UTF8'),$1,'allow',convert_to('allAccounts','UTF8'),1,'{}','runtime')`, actor.ID)
	done, err = authority.Administer(t.Context(), a, secret, command, target.ID)
	requireDB(t, err)
	if !done || f.state(t, target.ID) != "suspended" {
		t.Fatal("a granted admin command inside its boundary did not run")
	}
	var events string
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT string_agg(convert_from(event_kind,'UTF8'),',' ORDER BY convert_from(event_kind,'UTF8')) FROM audit_outbox WHERE actor_id=$1`, actor.ID).Scan(&events))
	if events != "access.read,access.suspend,access.suspend,account.suspend" {
		t.Fatalf("IAM admin audit: %s", events)
	}
	if _, err := authority.Administer(t.Context(), a, fixture.Session(t, f.s, actor.ID, fixture.SessionSpec{}), command, target.ID); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("an admin command ran without fresh authentication")
	}
}

func TestAdministerByRootRunsAndAudits(t *testing.T) {
	f := newAuthorityFixture(t)
	command := suspendAccount()
	a := f.authority(t, authority.DefaultCapabilities(), command)
	target := fixture.Account(t, f.s, fixture.AccountSpec{})
	root := fixture.Root(t, f.s)
	done, err := authority.Administer(t.Context(), a, fixture.Session(t, f.s, root.ID, fixture.SessionSpec{Fresh: true}), command, target.ID)
	requireDB(t, err)
	if !done || f.state(t, target.ID) != "suspended" {
		t.Fatal("root admin command did not run")
	}
	var suspends int
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT count(*) FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('account.suspend','UTF8') AND safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='ok'`, root.ID).Scan(&suspends))
	if suspends != 1 {
		t.Fatal("root admin command left no audit")
	}
	unregistered := suspendAccount()
	if _, err := authority.Administer(t.Context(), a, fixture.Session(t, f.s, root.ID, fixture.SessionSpec{Fresh: true}), unregistered, target.ID); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("an unregistered admin command ran")
	}
	notFresh := authority.NewAdminCommand("account", "read", func(authority.AdminContext, string) (bool, error) { return true, nil }, func(authority.AdminContext, string, bool) *audit.Event { return &audit.Event{} })
	c, err := declarations.NewCore()
	requireDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	requireDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	requireDB(t, err)
	if _, err := authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), nil, notFresh); err == nil {
		t.Fatal("an admin command registered without a fresh policy")
	}
}
