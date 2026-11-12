package core_test

import (
	"slices"
	"testing"

	"hrm/api/internal/authorization/core"
)

func emptyDeclarations() core.SystemDeclarations {
	return core.SystemDeclarations{
		Resources:    []core.ResourceDeclaration{},
		Relations:    []core.RelationDeclaration{},
		Policies:     []core.PermissionPolicy{},
		Templates:    []core.ScopeTemplate{},
		Boundaries:   []core.PermissionBoundary{},
		Capabilities: core.Capabilities{Validators: []string{}, ObligationHandlers: []string{}},
	}
}

func TestEmptyListsAreDeclarationsAndNilListsAreNot(t *testing.T) {
	if _, err := fixtureCore.Validate(emptyDeclarations()); err != nil {
		t.Fatalf("empty declarations: %v", err)
	}
	for name, mutate := range map[string]func(*core.SystemDeclarations){
		"resources":  func(d *core.SystemDeclarations) { d.Resources = nil },
		"relations":  func(d *core.SystemDeclarations) { d.Relations = nil },
		"policies":   func(d *core.SystemDeclarations) { d.Policies = nil },
		"templates":  func(d *core.SystemDeclarations) { d.Templates = nil },
		"boundaries": func(d *core.SystemDeclarations) { d.Boundaries = nil },
		"validators": func(d *core.SystemDeclarations) { d.Capabilities.Validators = nil },
		"handlers":   func(d *core.SystemDeclarations) { d.Capabilities.ObligationHandlers = nil },
	} {
		t.Run(name, func(t *testing.T) {
			source := emptyDeclarations()
			mutate(&source)
			validationFails(t, source)
		})
	}
}

// The cases below add a declaration nothing else refers to, so that its own rule is the only one that can refuse it.
func TestAnUnreferencedDeclarationIsStillChecked(t *testing.T) {
	validRelation := core.RelationDeclaration{
		Key: "submission.other", Version: 1, SourceType: "submission",
		Target:  core.RelationTarget{Kind: core.RelationTargetIdentity},
		Binding: core.RelationBinding{Kind: core.BindingEdgeStore},
	}
	validPolicy := baselinePolicy()
	validPolicy.Key = "unused"
	validResource := core.ResourceDeclaration{
		Key: "extra", KeyKind: core.KeyString,
		Fields: map[string]core.FieldType{}, Actions: map[string]core.ActionDeclaration{},
	}
	withRelation := func(mutate func(*core.RelationDeclaration)) func(*core.SystemDeclarations) {
		return func(d *core.SystemDeclarations) {
			relation := validRelation
			mutate(&relation)
			d.Relations = append(d.Relations, relation)
		}
	}
	withPolicy := func(mutate func(*core.PermissionPolicy)) func(*core.SystemDeclarations) {
		return func(d *core.SystemDeclarations) {
			policy := validPolicy
			mutate(&policy)
			d.Policies = append(d.Policies, policy)
		}
	}
	withResource := func(mutate func(*core.ResourceDeclaration)) func(*core.SystemDeclarations) {
		return func(d *core.SystemDeclarations) {
			resource := validResource
			mutate(&resource)
			d.Resources = append(d.Resources, resource)
		}
	}
	accepted := declarations()
	withRelation(func(*core.RelationDeclaration) {})(&accepted)
	withPolicy(func(*core.PermissionPolicy) {})(&accepted)
	withResource(func(*core.ResourceDeclaration) {})(&accepted)
	if _, err := fixtureCore.Validate(accepted); err != nil {
		t.Fatalf("the valid forms were refused: %v", err)
	}
	for name, mutate := range map[string]func(*core.SystemDeclarations){
		"resource key":         withResource(func(r *core.ResourceDeclaration) { r.Key = "Bad" }),
		"resource nil fields":  withResource(func(r *core.ResourceDeclaration) { r.Fields = nil }),
		"resource nil actions": withResource(func(r *core.ResourceDeclaration) { r.Actions = nil }),
		"relation key":         withRelation(func(r *core.RelationDeclaration) { r.Key = "Bad Key" }),
		"relation version":     withRelation(func(r *core.RelationDeclaration) { r.Version = 0 }),
		"relation source":      withRelation(func(r *core.RelationDeclaration) { r.SourceType = "invoice" }),
		"relation target type": withRelation(func(r *core.RelationDeclaration) {
			r.Target = core.RelationTarget{Kind: core.RelationTargetResource, Type: "invoice"}
		}),
		"relation target kind": withRelation(func(r *core.RelationDeclaration) { r.Target = core.RelationTarget{Kind: "group"} }),
		"policy key":           withPolicy(func(p *core.PermissionPolicy) { p.Key = "Bad key" }),
		"policy version":       withPolicy(func(p *core.PermissionPolicy) { p.Version = 0 }),
		"validator capability": func(d *core.SystemDeclarations) {
			d.Capabilities.Validators = append(d.Capabilities.Validators, "noVersion")
		},
		"obligation capability": func(d *core.SystemDeclarations) {
			d.Capabilities.ObligationHandlers = append(d.Capabilities.ObligationHandlers, "audit@0")
		},
	} {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			mutate(&source)
			validationFails(t, source)
		})
	}
}

func TestOnlyPrincipalIDIsAvailableOnAnIdentityField(t *testing.T) {
	validationFails(t, withTemplate(core.ExistsExpr{
		Relation: "submission.assignee@1",
		Where:    eq("identityId", core.ValueRef{From: core.SourcePrincipal, Name: "email"}),
	}, "submission"))
}

func TestFreeTextInDeclarationsMustBeValidUTF8(t *testing.T) {
	const invalid = "\xff"
	requirement := func(parameters map[string]core.Scalar) func(*core.SystemDeclarations) {
		return func(d *core.SystemDeclarations) {
			d.Policies[1].ContextRequirements = []core.ContextRequirement{{Validator: "minimumAssurance@1", Parameters: parameters}}
		}
	}
	unusedPolicy := func(scope core.Expr) func(*core.SystemDeclarations) {
		return func(d *core.SystemDeclarations) {
			policy := baselinePolicy()
			policy.Key, policy.RequiredScope = "unused", scope
			d.Policies = append(d.Policies, policy)
		}
	}
	for name, mutate := range map[string]func(*core.SystemDeclarations){
		"validator parameter value": requirement(map[string]core.Scalar{"minimum": core.Text(invalid)}),
		"validator parameter name":  requirement(map[string]core.Scalar{invalid: core.Text("2")}),
		"two requirements that would hash alike": func(d *core.SystemDeclarations) {
			d.Policies[1].ContextRequirements = []core.ContextRequirement{
				{Validator: "minimumAssurance@1", Parameters: text("minimum", "\xfe")},
				{Validator: "minimumAssurance@1", Parameters: text("minimum", "\xff")},
			}
		},
		"context name": func(d *core.SystemDeclarations) {
			d.Policies[1].RequiredScope = eq("status", core.ValueRef{From: core.SourceContext, Name: invalid})
		},
		"context name in a template": func(d *core.SystemDeclarations) {
			d.Templates = append(d.Templates, template("probe", "submission", eq("status", core.ValueRef{From: core.SourceContext, Name: invalid}), nil))
		},
		"domain binding key": func(d *core.SystemDeclarations) {
			d.Relations[1].Binding = core.RelationBinding{Kind: core.BindingDomain, Key: invalid}
		},
		"key beside an edge store binding": func(d *core.SystemDeclarations) {
			d.Relations[0].Binding = core.RelationBinding{Kind: core.BindingEdgeStore, Key: invalid}
		},
		"type beside an identity target": func(d *core.SystemDeclarations) {
			d.Relations[2].Target = core.RelationTarget{Kind: core.RelationTargetIdentity, Type: invalid}
		},
		"literal of an unused policy":  unusedPolicy(eq("status", literal(invalid))),
		"field of an unused policy":    unusedPolicy(eq(invalid, literal("x"))),
		"name in an unused policy":     unusedPolicy(eq("status", core.ValueRef{From: core.SourceContext, Name: invalid})),
		"is null of an unused policy":  unusedPolicy(core.IsNullExpr{Field: invalid}),
		"relation of an unused policy": unusedPolicy(core.ExistsExpr{Relation: invalid, Where: everything}),
	} {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			mutate(&source)
			validationFails(t, source)
		})
	}
	replacement := declarations()
	requirement(map[string]core.Scalar{"minimum": core.Text(string(rune(0xfffd)))})(&replacement)
	if _, err := fixtureCore.Validate(replacement); err != nil {
		t.Fatalf("U+FFFD is valid text: %v", err)
	}
}

// A field that never reaches a decision is refused: otherwise it reaches the canonical form, and two
// declarations that decide alike hash apart, or hash alike when only that field differs in bytes encoding/json drops.
func TestFieldsTheDeclarationDoesNotUseAreRefused(t *testing.T) {
	withLiteral := func(ref core.ValueRef) core.ValueRef {
		ref.Literal = core.TextValue("\xfe")
		return ref
	}
	refs := map[string]struct {
		field string
		ref   core.ValueRef
	}{
		"value beside a parameter": {"status", withLiteral(parameter("status"))},
		"value beside a context":   {"status", withLiteral(core.ValueRef{From: core.SourceContext, Name: "dept"})},
		"value beside a principal": {"identityId", core.ValueRef{From: core.SourcePrincipal, Name: "id", Literal: core.TextValue(string(alice))}},
		"name beside a literal":    {"status", core.ValueRef{From: core.SourceLiteral, Name: "status", Literal: core.TextValue("x")}},
	}
	for name, c := range refs {
		t.Run("template: "+name, func(t *testing.T) {
			expression := eq(c.field, c.ref)
			if c.field == "identityId" {
				expression = core.ExistsExpr{Relation: "submission.assignee@1", Where: expression}
			}
			source := declarations()
			source.Templates = append(source.Templates, template("probe", "submission", expression, map[string]core.FieldKind{"status": core.FieldString}))
			validationFails(t, source)
		})
		t.Run("unused policy: "+name, func(t *testing.T) {
			source := declarations()
			policy := baselinePolicy()
			policy.Key, policy.RequiredScope = "unused", eq(c.field, c.ref)
			source.Policies = append(source.Policies, policy)
			validationFails(t, source)
		})
	}
	boundary := boundarySource()
	boundary.Boundaries = []core.PermissionBoundary{{Key: "probe", Version: 1, Entries: []core.BoundaryEntry{{
		Permission: "customer.export", ContextRequirements: []core.ContextRequirement{},
		RequiredScope: eq("region", core.ValueRef{From: core.SourceLiteral, Name: "region", Literal: core.TextValue("north")}),
	}}}}
	validationFails(t, boundary)

	for name, mutate := range map[string]func(*core.RelationDeclaration){
		"type beside an identity target": func(r *core.RelationDeclaration) { r.Target.Type = "site" },
		"key beside an edge store":       func(r *core.RelationDeclaration) { r.Binding.Key = "assignees" },
	} {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			mutate(&source.Relations[2])
			validationFails(t, source)
		})
	}
}

func TestCanonicalFormIgnoresTheOrderOfCapabilitiesEntriesAndRequirements(t *testing.T) {
	build := func(reverse bool) string {
		source := boundarySource()
		source.Capabilities.Validators = []string{"minimumAssurance@1", "other@1", "other@1"}
		source.Capabilities.ObligationHandlers = []string{"first@1", "second@1"}
		source.Policies[1].ContextRequirements = []core.ContextRequirement{minimumAssurance("2"), minimumAssurance("3")}
		entries := []core.BoundaryEntry{
			{Permission: "applicationRole.assign", ContextRequirements: []core.ContextRequirement{minimumAssurance("1"), minimumAssurance("2")}, RequiredScope: everything},
			{Permission: "customer.export", ContextRequirements: []core.ContextRequirement{}, RequiredScope: everything},
		}
		if reverse {
			slices.Reverse(source.Capabilities.Validators)
			slices.Reverse(source.Capabilities.ObligationHandlers)
			slices.Reverse(source.Policies[1].ContextRequirements)
			slices.Reverse(entries[0].ContextRequirements)
			slices.Reverse(entries)
		}
		source.Boundaries = []core.PermissionBoundary{{Key: "both", Version: 1, Entries: entries}}
		return validated(source).Canonical()
	}
	if build(false) != build(true) {
		t.Fatalf("order changed the canonical form:\n%s\n%s", build(false), build(true))
	}
	source := boundarySource()
	source.Capabilities.Validators = []string{"other@1", "minimumAssurance@1", "other@1"}
	capabilities := validated(source).Capabilities()
	if !slices.Equal(capabilities.Validators, []string{"minimumAssurance@1", "other@1"}) {
		t.Fatalf("validators %v", capabilities.Validators)
	}
}
