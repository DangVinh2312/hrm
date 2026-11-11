//go:build integration

package role

import (
	"context"
	"maps"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

// The rows are written straight into the tables: the write path enforces lower limits, so nothing it writes
// reaches the limits of a read.
const (
	readAbsent    = "00000000-0000-4000-8000-000000000000"
	readRoleCount = `SELECT count(*)::int, count(*) FILTER (WHERE managed_by='code')::int FROM role_definition`
	readBulkRoles = `INSERT INTO role_definition(role_key,managed_by,label)
       SELECT convert_to('custom.'||CAST($1 AS text)||'_'||lpad(i::text,4,'0'),'UTF8'),'runtime','L'
         FROM generate_series(1,CAST($2 AS int)) i`
	readBulkRules = `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       SELECT gen_random_uuid(),convert_to('workRequest.read','UTF8'),convert_to(CAST($1 AS text),'UTF8'),'allow',
              convert_to('ownRequests','UTF8'),1,jsonb_build_object('n',i),'runtime'
         FROM generate_series(1,CAST($2 AS int)) i`
	readOneMoreRule = `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       VALUES(gen_random_uuid(),convert_to('workRequest.read','UTF8'),convert_to($1,'UTF8'),'allow',convert_to('ownRequests','UTF8'),1,'{"n":-1}','runtime')`
	readUserRule = `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
       VALUES(gen_random_uuid(),convert_to('workRequest.read','UTF8'),$1,'allow',convert_to('ownRequests','UTF8'),1,'{"n":-1}','runtime')`
	readHoldMany = `INSERT INTO user_role(user_id,role_key)
       SELECT CAST($1 AS uuid),convert_to('custom.held_'||lpad(i::text,4,'0'),'UTF8') FROM generate_series(1,CAST($2 AS int)) i
       ON CONFLICT DO NOTHING`
	readHold = `INSERT INTO user_role(user_id,role_key) VALUES($1,convert_to($2,'UTF8'))`
)

type statementTrace struct {
	mu   sync.Mutex
	seen []string
}

func (s *statementTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen = append(s.seen, data.SQL)
	return ctx
}

func (s *statementTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (s *statementTrace) take() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := s.seen
	s.seen = nil
	return seen
}

func tracedRunner(t *testing.T, s *test.Stack, tracer pgx.QueryTracer) *database.Runner {
	t.Helper()
	pools := maps.Clone(s.Pools)
	for purpose, pool := range s.Pools {
		config := pool.Config()
		config.ConnConfig.Tracer = tracer
		traced, err := pgxpool.NewWithConfig(t.Context(), config)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		t.Cleanup(traced.Close)
		pools[purpose] = traced
	}
	runner, err := database.NewRunner(pools, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func (f *commandFixture) matrix(t *testing.T, secret string) MatrixView {
	t.Helper()
	view, found, err := f.service.Matrix(t.Context(), secret)
	if err != nil || !found {
		t.Fatalf("the matrix: found %t, %v", found, test.Redact(err))
	}
	return view
}

func (f *commandFixture) permissions(t *testing.T, secret, account string) AccountPermissionView {
	t.Helper()
	view, found, err := f.service.AccountPermissions(t.Context(), secret, account)
	if err != nil || !found {
		t.Fatalf("the permissions of an account: found %t, %v", found, test.Redact(err))
	}
	return view
}

// unreachable: no answer at all, so not even the flag.
func (f *commandFixture) unreachable(t *testing.T, name, secret, account string) {
	t.Helper()
	view, found, err := f.service.AccountPermissions(t.Context(), secret, account)
	if err != nil || found || view.Truncated || len(view.Roles)+len(view.Grants)+len(view.Boundaries) != 0 {
		t.Errorf("%s: found %t, %+v, %v", name, found, view, test.Redact(err))
	}
}

func (f *commandFixture) account(t *testing.T, roles ...string) string {
	t.Helper()
	return fixture.Account(t, f.s, fixture.AccountSpec{Roles: roles}).ID
}

func roleOf(view MatrixView, key string) (View, bool) {
	for _, role := range view.Roles {
		if role.Key == key {
			return role, true
		}
	}
	return View{}, false
}

func TestTheMatrixIsCutAtTheRoleLimitAndSaysSo(t *testing.T) {
	f := newCommandFixture(t)
	reader := f.holder(t, pair("role.read", "role", 1))
	if f.matrix(t, reader).Truncated || f.matrix(t, f.root).Truncated {
		t.Fatal("the matrix of the fixture is already cut")
	}
	var roles, code int
	if err := f.conn.QueryRow(t.Context(), readRoleCount).Scan(&roles, &code); err != nil {
		t.Fatal(test.Redact(err))
	}
	if code < 4 {
		t.Fatalf("%d roles of the release", code)
	}

	f.exec(t, readBulkRoles, "fill", maxRoles-roles)
	if exact := f.matrix(t, reader); len(exact.Roles) != maxRoles || exact.Truncated {
		t.Errorf("at the limit: %d roles, truncated %t", len(exact.Roles), exact.Truncated)
	}

	f.exec(t, readBulkRoles, "zz", 1)
	over := f.matrix(t, reader)
	if len(over.Roles) != maxRoles || !over.Truncated {
		t.Fatalf("one above the limit: %d roles, truncated %t", len(over.Roles), over.Truncated)
	}
	for i, role := range over.Roles {
		if (i < code) != (role.Source == SourceCode) {
			t.Errorf("role %d of the cut matrix is %s (%s), with %d roles of the release", i, role.Key, role.Source, code)
		}
	}
	if _, kept := roleOf(over, "custom.zz_0001"); kept {
		t.Error("the cut kept the last role instead of the first ones")
	}
	if byRoot := f.matrix(t, f.root); len(byRoot.Roles) != maxRoles || !byRoot.Truncated {
		t.Errorf("Root above the limit: %d roles, truncated %t", len(byRoot.Roles), byRoot.Truncated)
	}

	stranger := fixture.Session(t, f.s, f.account(t), fixture.SessionSpec{})
	if view, found, err := f.service.Matrix(t.Context(), stranger); err != nil || found || view.Truncated || len(view.Roles) != 0 {
		t.Errorf("an account without the grant: found %t, %d roles, truncated %t, %v", found, len(view.Roles), view.Truncated, test.Redact(err))
	}
}

func TestARoleAboveTheRuleLimitCutsTheMatrix(t *testing.T) {
	f := newCommandFixture(t)
	reader := f.holder(t, pair("role.read", "role", 1))
	f.exec(t, readBulkRoles, "big", 1)
	f.exec(t, readBulkRules, "custom.big_0001", maxGrantsPerRole)
	exact := f.matrix(t, reader)
	if big, found := roleOf(exact, "custom.big_0001"); !found || len(big.Grants) != maxGrantsPerRole || exact.Truncated {
		t.Errorf("at the limit: found %t, %d rules, truncated %t", found, len(big.Grants), exact.Truncated)
	}

	f.exec(t, readOneMoreRule, "custom.big_0001")
	over := f.matrix(t, reader)
	if big, found := roleOf(over, "custom.big_0001"); !found || len(big.Grants) != maxGrantsPerRole || !over.Truncated {
		t.Errorf("one above the limit: found %t, %d rules, truncated %t", found, len(big.Grants), over.Truncated)
	}
}

func TestThePermissionsOfAnAccountAreCutAtTheRoleLimit(t *testing.T) {
	f := newCommandFixture(t)
	reader := f.holder(t, pair("account.readPermissions", "allAccounts", 1))
	target := f.account(t)
	if empty := f.permissions(t, reader, target); len(empty.Roles)+len(empty.Grants)+len(empty.Boundaries) != 0 || empty.Truncated {
		t.Errorf("an account holding nothing: %+v", empty)
	}

	f.exec(t, readBulkRoles, "held", maxAccountRoles+1)
	f.exec(t, readHoldMany, target, maxAccountRoles)
	if exact := f.permissions(t, reader, target); len(exact.Roles) != maxAccountRoles || exact.Truncated {
		t.Errorf("at the limit: %d roles, truncated %t", len(exact.Roles), exact.Truncated)
	}

	f.exec(t, readHoldMany, target, maxAccountRoles+1)
	over := f.permissions(t, reader, target)
	if len(over.Roles) != maxAccountRoles || !over.Truncated {
		t.Fatalf("one above the limit: %d roles, truncated %t", len(over.Roles), over.Truncated)
	}
	if first, last := over.Roles[0].Key, over.Roles[maxAccountRoles-1].Key; first != "custom.held_0001" || last != "custom.held_0200" {
		t.Errorf("the cut kept %s to %s", first, last)
	}

	f.unreachable(t, "an absent account", reader, readAbsent)
	f.unreachable(t, "Root", reader, f.rootID)
}

func TestThePermissionsOfAnAccountAreCutAtTheRuleLimit(t *testing.T) {
	f := newCommandFixture(t)
	reader := f.holder(t, pair("account.readPermissions", "allAccounts", 1))
	target, other := f.account(t), f.account(t)
	f.exec(t, readBulkRoles, "rules", 1)
	f.exec(t, readBulkRules, "custom.rules_0001", maxAccountGrants)
	f.exec(t, readHold, target, "custom.rules_0001")
	if exact := f.permissions(t, reader, target); len(exact.Grants) != maxAccountGrants || exact.Truncated {
		t.Errorf("at the limit: %d rules, truncated %t", len(exact.Grants), exact.Truncated)
	}

	f.exec(t, readHold, other, "custom.rules_0001")
	f.exec(t, readUserRule, other)
	if view := f.permissions(t, reader, target); len(view.Grants) != maxAccountGrants || view.Truncated {
		t.Errorf("the rules of another account counted: %d rules, truncated %t", len(view.Grants), view.Truncated)
	}

	f.exec(t, readUserRule, target)
	if over := f.permissions(t, reader, target); len(over.Grants) != maxAccountGrants || !over.Truncated {
		t.Errorf("one above the limit: %d rules, truncated %t", len(over.Grants), over.Truncated)
	}
}

func TestThePermissionsOfAnAccountAreReadInOneStatement(t *testing.T) {
	trace := &statementTrace{}
	f := newCommandFixture(t, trace)
	reader := f.holder(t, pair("account.readPermissions", "allAccounts", 1))
	target := f.account(t, "hr.employee")
	trace.take()
	if view := f.permissions(t, reader, target); len(view.Roles) != 1 || len(view.Grants) == 0 {
		t.Fatalf("the permissions of an hr.employee: %d roles, %d rules", len(view.Roles), len(view.Grants))
	}

	var reads []string
	for _, statement := range trace.take() {
		switch {
		case strings.Contains(statement, "account_directory"):
			reads = append(reads, statement)
		case strings.Contains(statement, "resolve_session"):
		case strings.Contains(statement, "user_role") || strings.Contains(statement, "policy_rule") || strings.Contains(statement, "user_boundary"):
			t.Errorf("a statement outside the read of the target reads its roles, rules or boundaries")
		}
	}
	if len(reads) != 1 {
		t.Fatalf("%d statements read the target, want 1", len(reads))
	}
	for _, table := range []string{"user_role", "policy_rule", "user_boundary"} {
		if !strings.Contains(reads[0], table) {
			t.Errorf("the statement of the target does not read %s", table)
		}
	}
}
