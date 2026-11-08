package compiler_test

import (
	"strings"
	"testing"

	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
)

func TestProductDomainBindingsRejectIncompleteValidityWindows(t *testing.T) {
	c := newTestCore(t)
	d, err := c.Validate(fixtureDeclarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	baseDomain := compiler.DomainRelationBinding{
		Table:        "site_manager",
		SourceColumn: "site_id",
		TargetColumn: "user_id",
	}
	for _, partial := range []compiler.DomainRelationBinding{
		{Table: baseDomain.Table, SourceColumn: baseDomain.SourceColumn, TargetColumn: baseDomain.TargetColumn, StartsColumn: "starts_at"},
		{Table: baseDomain.Table, SourceColumn: baseDomain.SourceColumn, TargetColumn: baseDomain.TargetColumn, ExpiresColumn: "expires_at"},
	} {
		b := fixtureStorageBindings()
		b.Domains["siteManagers"] = partial
		if _, err := compiler.NewRegistry(c, d, b); err == nil {
			t.Errorf("expected error for incomplete domain validity window %#v", partial)
		}
	}

	bWithoutWindow := fixtureStorageBindings()
	if _, err := compiler.NewRegistry(c, d, bWithoutWindow); err != nil {
		t.Fatalf("domain without window rejected: %v", err)
	}

	bWithWindow := fixtureStorageBindings()
	bWithWindow.Domains["siteManagers"] = compiler.DomainRelationBinding{
		Table:         baseDomain.Table,
		SourceColumn:  baseDomain.SourceColumn,
		TargetColumn:  baseDomain.TargetColumn,
		StartsColumn:  "starts_at",
		ExpiresColumn: "expires_at",
	}
	if _, err := compiler.NewRegistry(c, d, bWithWindow); err != nil {
		t.Fatalf("domain with full window rejected: %v", err)
	}
}

func TestProductIdentityRelationSQLChecksSourceObjectRegistryTypeAndExactVersion(t *testing.T) {
	c := newTestCore(t)
	d, err := c.Validate(fixtureDeclarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	reg, err := compiler.NewRegistry(c, d, fixtureStorageBindings())
	if err != nil {
		t.Fatal(err)
	}
	rules := []core.RuleFact{
		{
			ID:         "r1",
			Permission: "submission.read",
			Subject:    core.RuleSubject{Kind: core.SubjectIdentity, Identity: alice},
			Effect:     core.EffectAllow,
			Template:   core.RelationRef{Key: "assignedToMe", Version: 1},
			Parameters: map[string]core.Scalar{},
		},
	}
	decision := c.Plan(fixtureInput(), fixtureSnapshot(d, rules))
	if !decision.Allowed() {
		t.Fatalf("decision denied: %s", decision.Reason())
	}
	predicate, err := compiler.CompilePlan(decision.Plan(), reg)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"FROM user_relation r_e1 JOIN object_ref r_t1 ON r_t1.object_id=r_e1.object_id",
		"r_t1.type_key = CAST(",
		"r_e1.relation_key = CAST(",
		"r_e1.relation_version = CAST(",
		`r_e1."starts_at" <= statement_timestamp() AND (r_e1."expires_at" IS NULL OR r_e1."expires_at" > statement_timestamp())`,
	} {
		if !strings.Contains(predicate.SQL, want) {
			t.Errorf("compiled SQL missing %q:\n%s", want, predicate.SQL)
		}
	}
}
