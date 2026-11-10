//go:build integration

package grant_test

import (
	"context"
	"strings"
	"testing"

	"hrm/api-go/internal/authorization/grant"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

func TestATargetWithALargerGrantSetIsRefused(t *testing.T) {
	s := test.NewDatabase(t)
	actor := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.admin", "hr.employee"}})
	smaller := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	larger := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.coo"}})
	attached := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	type answer struct {
		smaller, larger, attached, truncated bool
		actorGrants                          int
	}
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	if _, err := conn.Exec(t.Context(), `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES(gen_random_uuid(),convert_to('employee.read','UTF8'),$1,'allow',convert_to('selfEmployee','UTF8'),1,'{}','runtime')`, attached.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	c := newCore(t)
	got, err := database.Run(t.Context(), s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (answer, error) {
		var a answer
		var grants []grant.GrantRuleFact
		var err error
		iam := grant.Actor{ID: actor.ID, Kind: "iam"}
		if a.smaller, grants, err = grant.WithinActor(tx, c, iam, smaller.ID); err != nil {
			return a, err
		}
		a.actorGrants = len(grants)
		if a.larger, _, err = grant.WithinActor(tx, c, iam, larger.ID); err != nil {
			return a, err
		}
		if a.attached, _, err = grant.WithinActor(tx, c, iam, attached.ID); err != nil {
			return a, err
		}
		_, a.truncated, err = grant.Read(tx, c, []string{actor.ID}, 1)
		return a, err
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if !got.smaller || got.actorGrants == 0 {
		t.Fatal("a target within the actor's grants was refused")
	}
	if got.larger {
		t.Fatal("a target holding a permission the actor lacks was accepted")
	}
	if got.attached {
		t.Fatal("a target with a rule attached to the account was accepted")
	}
	if !got.truncated {
		t.Fatal("a capped read was not reported truncated")
	}
}

func TestANonCanonicalTargetIDIsAnError(t *testing.T) {
	s := test.NewDatabase(t)
	actor := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	larger := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.coo"}})
	iam := grant.Actor{ID: actor.ID, Kind: "iam"}
	c := newCore(t)
	for _, id := range []string{strings.ToUpper(larger.ID), "{" + larger.ID + "}"} {
		within, err := database.Run(t.Context(), s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (bool, error) {
			within, _, err := grant.WithinActor(tx, c, iam, id)
			return within, err
		}, database.RunOptions{})
		if err == nil || within {
			t.Errorf("a non-canonical target id gave within=%v error=%v", within, err != nil)
		}
	}
}
