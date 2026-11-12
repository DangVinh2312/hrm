//go:build integration

package role

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const (
	commandInsertRole = `INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to($1,'UTF8'),'runtime','Fixture')`
	commandInsertRule = `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to($2,'UTF8'),convert_to($1,'UTF8'),'allow',convert_to($3,'UTF8'),$4,'{}','runtime')`
	commandState = `SELECT concat_ws('|', (SELECT revision::text FROM authz_state WHERE singleton),
      (SELECT count(*)||':'||coalesce(md5(string_agg(encode(role_key,'hex')||':'||label,',' ORDER BY role_key)),'') FROM role_definition),
      (SELECT count(*)||':'||coalesce(md5(string_agg(rule_id::text,',' ORDER BY rule_id)),'') FROM policy_rule),
      (SELECT count(*)::text FROM audit_outbox))`
)

// commandFixture is the role operations over a real authority, with a fresh Root session.
type commandFixture struct {
	s       *test.Stack
	conn    *pgx.Conn
	auth    *authority.Authorization
	ops     *Operations
	service *Service
	root    string
	rootID  string
	names   int
}

// newCommandFixture: with a tracer, the authority runs on its own pools, which report every statement to it.
func newCommandFixture(t *testing.T, tracers ...pgx.QueryTracer) *commandFixture {
	t.Helper()
	f := &commandFixture{s: test.NewDatabase(t)}
	conn, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	f.conn = conn
	c, validated := release(t)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	if err != nil {
		t.Fatal(err)
	}
	f.ops, err = NewOperations(c, validated)
	if err != nil {
		t.Fatal(err)
	}
	runner := f.s.Runner
	if len(tracers) > 0 {
		runner = tracedRunner(t, f.s, tracers[0])
	}
	f.auth, err = authority.New(runner, bindings, authority.DefaultCapabilities(), nil, f.ops.All()...)
	if err != nil {
		t.Fatal(err)
	}
	f.service = f.ops.Bind(f.auth)
	f.rootID = fixture.Root(t, f.s).ID
	f.root = fixture.Session(t, f.s, f.rootID, fixture.SessionSpec{Fresh: true})
	return f
}

func (f *commandFixture) key() string {
	f.names++
	return "custom.command_" + strconv.Itoa(f.names)
}

func (f *commandFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func (f *commandFixture) state(t *testing.T) string {
	t.Helper()
	var state string
	if err := f.conn.QueryRow(t.Context(), commandState).Scan(&state); err != nil {
		t.Fatal(test.Redact(err))
	}
	return state
}

// holder is the fresh session of a new IAM account holding exactly grants, through one runtime role.
func (f *commandFixture) holder(t *testing.T, grants ...GrantPair) string {
	t.Helper()
	key := f.key()
	f.exec(t, commandInsertRole, key)
	for _, g := range grants {
		f.exec(t, commandInsertRule, key, g.Permission, g.Template.Key, g.Template.Version)
	}
	account := fixture.Account(t, f.s, fixture.AccountSpec{Roles: []string{key}})
	return fixture.Session(t, f.s, account.ID, fixture.SessionSpec{Fresh: true})
}

// refused wants the error and no trace: no role, no rule, no audit and no revision.
func (f *commandFixture) refused(t *testing.T, name string, want error, run func() error) {
	t.Helper()
	before := f.state(t)
	if err := run(); !errors.Is(err, want) {
		t.Errorf("%s: %v, want %v", name, test.Redact(err), want)
	}
	if after := f.state(t); after != before {
		t.Errorf("%s left a trace: %s -> %s", name, before, after)
	}
}

func TestAnActorHoldingOnePairCreatesNoRoleWithAnotherPairOfTheCatalog(t *testing.T) {
	f := newCommandFixture(t)
	_, validated := release(t)
	all := selectable(validated)
	create := pair("role.create", "role", 1)
	for _, held := range []GrantPair{pair("employee.read", "allEmployees", 1), pair("employee.read", "selfEmployee", 1), pair("setting.read", "setting", 1)} {
		secret := f.holder(t, create, held)
		tried := 0
		before := f.state(t)
		for _, other := range all {
			if other == held || other == create || other.Permission == permissionApprovals {
				continue
			}
			tried++
			_, err := f.service.Create(t.Context(), secret, CreateInput{Key: f.key(), Label: "Property", Grants: []GrantPair{other}})
			if !errors.Is(err, apperror.ErrAccessDenied) {
				t.Errorf("%s created %s: %v", named(held), named(other), test.Redact(err))
			}
		}
		if tried < 100 {
			t.Errorf("%s: only %d other pairs were tried", named(held), tried)
		}
		if after := f.state(t); after != before {
			t.Errorf("%s: the refused creates left a trace: %s -> %s", named(held), before, after)
		}
		if _, err := f.service.Create(t.Context(), secret, CreateInput{Key: f.key(), Label: "Property", Grants: []GrantPair{held}}); err != nil {
			t.Errorf("%s did not create a role with the pair it holds: %v", named(held), test.Redact(err))
		}
	}
}

func TestCreateRefusesAKeyOrAGrantOutsideTheCatalog(t *testing.T) {
	f := newCommandFixture(t)
	read := pair("role.read", "role", 1)
	many := make([]GrantPair, 0, 301)
	for i := range 301 {
		many = append(many, pair(fmt.Sprintf("p.a%d", i), "t", 1))
	}
	for name, input := range map[string]CreateInput{
		"a key of the release":          {Key: "hr.admin", Label: "x", Grants: []GrantPair{read}},
		"a key with no name":            {Key: "custom.", Label: "x", Grants: []GrantPair{read}},
		"a document grant":              {Key: f.key(), Label: "x", Grants: []GrantPair{pair("document.read", "ownedDocuments", 1)}},
		"approvals without decideFinal": {Key: f.key(), Label: "x", Grants: []GrantPair{pair("hrCompany.approvals", "company", 1)}},
		"an unknown permission":         {Key: f.key(), Label: "x", Grants: []GrantPair{pair("nope.read", "role", 1)}},
		"301 grants":                    {Key: f.key(), Label: "x", Grants: many},
	} {
		f.refused(t, name, apperror.ErrInvalidRequest, func() error {
			_, err := f.service.Create(t.Context(), f.root, input)
			return err
		})
	}
}

// The commands are run straight through the authority, as a caller that skipped Service and the body parser.
func TestTheCommandsCheckTheirInputAgainWhenTheServiceIsBypassed(t *testing.T) {
	f := newCommandFixture(t)
	read := pair("role.read", "role", 1)
	create := func(input CreateInput) error {
		_, err := authority.Execute(t.Context(), f.auth, f.root, f.ops.create, input)
		return err
	}
	for name, input := range map[string]CreateInput{
		"a document grant":               {Key: f.key(), Label: "Label", Grants: []GrantPair{pair("document.read", "ownedDocuments", 1)}},
		"approvals without decideFinal":  {Key: f.key(), Label: "Label", Grants: []GrantPair{pair("hrCompany.approvals", "company", 1)}},
		"a template of another resource": {Key: f.key(), Label: "Label", Grants: []GrantPair{pair("role.read", "setting", 1)}},
		"a key of the release":           {Key: "hr.admin", Label: "Label", Grants: []GrantPair{read}},
		"a padded label":                 {Key: f.key(), Label: "  padded  ", Grants: []GrantPair{read}},
		"an empty label":                 {Key: f.key(), Label: "", Grants: []GrantPair{read}},
	} {
		f.refused(t, "create with "+name, apperror.ErrInvalidRequest, func() error { return create(input) })
	}

	key := f.key()
	if err := create(CreateInput{Key: key, Label: "Label", Grants: []GrantPair{read}}); err != nil {
		t.Fatalf("the control create: %v", test.Redact(err))
	}
	matrix, found, err := f.service.Matrix(t.Context(), f.root)
	if err != nil || !found {
		t.Fatalf("the matrix read by Root: %t %v", found, test.Redact(err))
	}
	expected := ""
	for _, view := range matrix.Roles {
		if view.Key == key {
			expected = view.Digest
		}
	}
	update := func(label string, grants ...GrantPair) error {
		_, err := authority.Execute(t.Context(), f.auth, f.root, f.ops.update, UpdateInput{CreateInput: CreateInput{Key: key, Label: label, Grants: grants}, ExpectedDigest: expected})
		return err
	}
	f.refused(t, "update with a document grant", apperror.ErrInvalidRequest, func() error {
		return update("Label", pair("document.read", "ownedDocuments", 1))
	})
	f.refused(t, "update with a padded label", apperror.ErrInvalidRequest, func() error { return update(" Label", read) })
	if err := update("Renamed", read); err != nil {
		t.Errorf("the control update: %v", test.Redact(err))
	}
}
