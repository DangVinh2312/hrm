//go:build integration

package role

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/grant"
	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

func sqlState(err error) string {
	if pg, ok := errors.AsType[*pgconn.PgError](err); ok {
		return pg.Code
	}
	return ""
}

func superuser(t *testing.T, s *test.Stack, statements ...string) {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	for _, statement := range statements {
		if _, err := conn.Exec(t.Context(), statement); err != nil {
			t.Fatal(test.Redact(err))
		}
	}
}

// The authority login, which runs every role command, cannot change a role the release owns: the lock of
// the commands does not see it, and the database refuses a write that tried.
func TestTheAuthorityLoginCannotChangeACodeOwnedRole(t *testing.T) {
	s := test.NewDatabase(t)
	admin := func(work func(tx *database.Tx) error) error {
		_, err := database.Run(t.Context(), s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			return struct{}{}, work(tx)
		}, database.RunOptions{})
		return err
	}
	if err := admin(func(tx *database.Tx) error {
		_, found, err := lockRole(tx, "hr.admin")
		if err == nil && found {
			t.Error("the command lock found a code-owned role")
		}
		return err
	}); err != nil {
		t.Fatal(test.Redact(err))
	}
	for name, write := range map[string]func(tx *database.Tx) error{
		"label":  func(tx *database.Tx) error { return setLabel(tx, "hr.admin", "Taken") },
		"delete": func(tx *database.Tx) error { return deleteRole(tx, "hr.admin") },
		"rule": func(tx *database.Tx) error {
			return insertRules(tx, "hr.admin", []GrantPair{{Permission: "role.read", Template: TemplateRef{Key: "role", Version: 1}}})
		},
	} {
		if err := admin(write); sqlState(err) != "42501" {
			t.Errorf("%s of a code-owned role: %v", name, test.Redact(err))
		}
	}
}

// An IAM actor proves what it holds only from a complete read of its own grants; one row above
// grant.MaxFactRows refuses even an empty role. Root does not read its grants.
func TestAnIncompleteReadOfTheActorsGrantsProvesNothing(t *testing.T) {
	s := test.NewDatabase(t)
	superuser(t, s,
		`INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to('custom.big','UTF8'),'runtime','Big'),(convert_to('custom.small','UTF8'),'runtime','Small')`,
		`INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       SELECT gen_random_uuid(),convert_to('role.read','UTF8'),convert_to('custom.big','UTF8'),'allow',convert_to('role','UTF8'),1,'{}','runtime'
         FROM generate_series(1,20001)`,
		`INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       VALUES(gen_random_uuid(),convert_to('role.read','UTF8'),convert_to('custom.small','UTF8'),'allow',convert_to('role','UTF8'),1,'{}','runtime')`,
	)
	big := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"custom.big"}})
	small := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"custom.small"}})
	c, validated := release(t)
	m := commands{core: c, declarations: validated}
	read := []grant.GrantRuleFact{{Source: grant.SourceRole, Effect: core.EffectAllow, Permission: "role.read", Template: core.RelationRef{Key: "role", Version: 1}, Parameters: "{}"}}
	type answer struct{ big, small, root bool }
	got, err := database.Run(t.Context(), s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (answer, error) {
		var a answer
		var err error
		if a.big, err = m.within(authority.CommandContext{Tx: tx, Actor: authority.Actor{ID: big.ID, Kind: "iam"}}, nil); err != nil {
			return a, err
		}
		if a.small, err = m.within(authority.CommandContext{Tx: tx, Actor: authority.Actor{ID: small.ID, Kind: "iam"}}, read); err != nil {
			return a, err
		}
		a.root, err = m.within(authority.CommandContext{Tx: tx, Actor: authority.Actor{ID: big.ID, Kind: "root"}}, read)
		return a, err
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if got.big {
		t.Error("a truncated read of the actor's grants proved an empty role within")
	}
	if !got.small || !got.root {
		t.Errorf("a complete read or Root was refused: %+v", got)
	}
}
