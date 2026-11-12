package authority_test

import (
	"context"
	"errors"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/database"
)

func TestPermitQueriesAreBounded(t *testing.T) {
	if authority.ValidPermitQueries(nil) {
		t.Fatal("empty probes accepted")
	}
	queries := make([]authority.PermitQuery, 18)
	for i := range queries {
		queries[i] = authority.PermitQuery{{Resource: "document", Action: "read"}}
	}
	if authority.ValidPermitQueries(queries) {
		t.Fatal("unbounded probes accepted")
	}
	if !authority.ValidPermitQueries(queries[:17]) {
		t.Fatal("bounded probes refused")
	}
}

func testAuthority(t *testing.T, operations ...authority.Operation) *authority.Authorization {
	t.Helper()
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	validated, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		t.Fatal(err)
	}
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	if err != nil {
		t.Fatal(err)
	}
	runner, err := database.NewRunner(nil, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	a, err := authority.New(runner, bindings, authority.DefaultCapabilities(), nil, operations...)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestOperationsRequireIdentityAndRegistrationBeforeIO(t *testing.T) {
	query := authority.NewQuery("document", "read", nil, func(authority.QueryContext, string) (authority.QueryResult[string], error) {
		t.Fatal("unregistered query ran")
		return authority.QueryResult[string]{}, nil
	})
	command := authority.NewCommand("document", "update", database.ModeWrite, func(input string) string { return input }, func(authority.CommandContext, string) (string, error) {
		t.Fatal("unregistered command ran")
		return "", nil
	})
	a := testAuthority(t, query, command)
	queryCopy := *query
	commandCopy := *command
	for _, q := range []*authority.Query[string, string]{nil, &queryCopy, authority.NewQuery("document", "read", nil, func(authority.QueryContext, string) (authority.QueryResult[string], error) {
		return authority.QueryResult[string]{}, nil
	})} {
		if _, err := authority.Read(context.Background(), a, "", q, ""); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Fatal("foreign query accepted")
		}
	}
	for _, c := range []*authority.Command[string, string]{nil, &commandCopy, authority.NewCommand("document", "update", database.ModeWrite, func(input string) string { return input }, func(authority.CommandContext, string) (string, error) { return "", nil })} {
		if _, err := authority.Execute(context.Background(), a, "", c, ""); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Fatal("foreign command accepted")
		}
	}
	if !a.PermissionExists("document", "read") || a.PermissionExists("document", "missing") || a.PermissionExists("missing", "read") {
		t.Fatal("invalid permission registry")
	}
}

func TestAdminRegistrationRequiresTheActionsFreshPolicy(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	validated, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		t.Fatal(err)
	}
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	if err != nil {
		t.Fatal(err)
	}
	runner, err := database.NewRunner(nil, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	run := func(authority.CommandContext, string) (string, error) { return "", nil }
	target := func(key string) string { return key }
	for _, entry := range []struct {
		resource, action string
		valid            bool
	}{{"account", "suspend", true}, {"document", "update", false}, {"missing", "read", false}} {
		command := authority.NewCommand(entry.resource, entry.action, database.ModeAdmin, target, run)
		_, err := authority.New(runner, bindings, authority.DefaultCapabilities(), nil, command)
		if (err == nil) != entry.valid {
			t.Fatalf("admin registration %s.%s validity=%v", entry.resource, entry.action, entry.valid)
		}
	}
	checked := 0
	for _, resource := range validated.Resources() {
		for action, declared := range resource.Actions {
			if declared.Boundary != "required" {
				continue
			}
			checked++
			policy, ok := validated.Policy(declared.Policy)
			if !ok {
				t.Fatal("required-boundary policy missing")
			}
			fresh := false
			for _, requirement := range policy.ContextRequirements {
				fresh = fresh || requirement.Validator == "fresh@1"
			}
			if !fresh {
				t.Fatalf("required-boundary action %s.%s lacks fresh", resource.Key, action)
			}
		}
	}
	if checked == 0 {
		t.Fatal("required-boundary policy assertion is vacuous")
	}
}
