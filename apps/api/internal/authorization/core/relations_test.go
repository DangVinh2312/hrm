package core_test

import (
	"crypto/sha256"
	"slices"
	"testing"

	"hrm/api/internal/authorization/core"
)

const (
	relationRecord = "54000000-0000-4000-8000-000000000001"
	siteObject     = "54000000-0000-4000-8000-0000000000a1"
)

func relationSubmission() core.FactObject { return submission(relationRecord, "1", nil) }

func siteA() core.FactObject {
	return core.FactObject{
		Type: "site", Key: core.Key{Kind: core.KeyUUID, Value: "d97eecc9-8f23-4a76-a9aa-82b9d4ef33ac"},
		ObjectID: siteObject, Fields: map[string]core.FieldValue{"name": core.TextValue("Site A")},
	}
}

func edge(key, source string, target core.EdgeTarget, mutate func(*core.EdgeFact)) core.EdgeFact {
	fact := core.EdgeFact{
		Relation: core.RelationRef{Key: key, Version: 1}, Source: source, Target: target,
		StartsAt: "2026-10-01T00:00:00.000000Z",
	}
	if mutate != nil {
		mutate(&fact)
	}
	return fact
}

func objectTarget(objectID string) core.EdgeTarget {
	return core.EdgeTarget{Kind: core.EdgeTargetObject, ObjectID: objectID}
}

func identityTarget(identity core.IdentityID) core.EdgeTarget {
	return core.EdgeTarget{Kind: core.EdgeTargetIdentity, Identity: identity}
}

func submissionSite(mutate func(*core.EdgeFact)) core.EdgeFact {
	return edge("submission.site", relationRecord, objectTarget(siteObject), mutate)
}

func siteManager(identity core.IdentityID, mutate func(*core.EdgeFact)) core.EdgeFact {
	return edge("site.manager", siteObject, identityTarget(identity), mutate)
}

func graph(edges ...core.EdgeFact) core.CompleteFacts {
	f := factsOf(relationSubmission())
	f.Objects = []core.FactObject{relationSubmission(), siteA()}
	f.Edges = edges
	return f
}

func managedSite(t *testing.T, f core.CompleteFacts) core.Decision {
	t.Helper()
	manager := core.RuleSubject{Kind: core.SubjectRole, Role: "manager"}
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(func(s *core.AuthoritySnapshot) {
		s.Roles = []string{"manager"}
		s.Rules = []core.RuleFact{read(manager, core.EffectAllow, "managedSite@1", nil)}
	})))
	return fixtureCore.Evaluate(plan, f)
}

func TestASitePathGrantsTheSiteManagerOnly(t *testing.T) {
	if !managedSite(t, graph(submissionSite(nil), siteManager(alice, nil))).Allowed() {
		t.Error("the site manager was denied")
	}
	if managedSite(t, graph(submissionSite(nil), siteManager(bob, nil))).Allowed() {
		t.Error("the manager of the site is bob, alice was allowed")
	}
	if managedSite(t, graph(siteManager(alice, nil))).Allowed() {
		t.Error("the path has no first edge, alice was allowed")
	}
}

func TestEveryEdgeIsCheckedOnEachStep(t *testing.T) {
	cases := map[string]core.CompleteFacts{
		"first edge expired at the decision instant": graph(submissionSite(func(e *core.EdgeFact) {
			e.ExpiresAt = ptr(now)
		}), siteManager(alice, nil)),
		"last edge expired": graph(submissionSite(nil), siteManager(alice, func(e *core.EdgeFact) {
			e.ExpiresAt = ptr("2026-10-13T09:59:59.999999Z")
		})),
		"last edge not started": graph(submissionSite(nil), siteManager(alice, func(e *core.EdgeFact) {
			e.StartsAt = "2026-10-14T00:00:00.000000Z"
		})),
		"first edge of another version": graph(submissionSite(func(e *core.EdgeFact) {
			e.Relation.Version = 2
		}), siteManager(alice, nil)),
		"last edge of another version": graph(submissionSite(nil), siteManager(alice, func(e *core.EdgeFact) {
			e.Relation.Version = 2
		})),
		"first edge of another relation": graph(submissionSite(func(e *core.EdgeFact) {
			e.Relation.Key = "submission.other"
		}), siteManager(alice, nil)),
		"first edge from another source": graph(submissionSite(func(e *core.EdgeFact) {
			e.Source = "54000000-0000-4000-8000-0000000000ff"
		}), siteManager(alice, nil)),
		"last edge from another source": graph(submissionSite(nil), siteManager(alice, func(e *core.EdgeFact) {
			e.Source = relationRecord
		})),
		"reversed first edge": graph(
			edge("submission.site", siteObject, objectTarget(relationRecord), nil),
			siteManager(alice, nil),
		),
		"object target where the relation names an identity": graph(submissionSite(nil), siteManager(alice, func(e *core.EdgeFact) {
			e.Target = objectTarget(siteObject)
		})),
		"object target carrying the right identity": graph(submissionSite(nil), siteManager(alice, func(e *core.EdgeFact) {
			e.Target = core.EdgeTarget{Kind: core.EdgeTargetObject, ObjectID: siteObject, Identity: alice}
		})),
		"target without a kind carrying the right identity": graph(submissionSite(nil), siteManager(alice, func(e *core.EdgeFact) {
			e.Target = core.EdgeTarget{Identity: alice}
		})),
		"identity target where the relation names a resource": graph(submissionSite(func(e *core.EdgeFact) {
			e.Target = identityTarget(alice)
		}), siteManager(alice, nil)),
		"empty target": graph(submissionSite(func(e *core.EdgeFact) {
			e.Target = core.EdgeTarget{ObjectID: siteObject, Identity: alice}
		}), siteManager(alice, nil)),
		"target object of another type": func() core.CompleteFacts {
			f := graph(submissionSite(nil), siteManager(alice, nil))
			wrong := siteA()
			wrong.Type = "submission"
			f.Objects = []core.FactObject{relationSubmission(), wrong}
			return f
		}(),
		"target object absent from the facts": func() core.CompleteFacts {
			f := graph(submissionSite(nil), siteManager(alice, nil))
			f.Objects = []core.FactObject{relationSubmission()}
			return f
		}(),
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			if managedSite(t, f).Allowed() {
				t.Fatal("allowed")
			}
		})
	}
}

func TestATargetObjectOfAnotherTypeIsNotReachedEvenWhenTheWhereIsTrue(t *testing.T) {
	source := declarations()
	source.Templates = append(source.Templates, template("anySite", "submission", core.ExistsExpr{Relation: "submission.site@1", Where: everything}, nil))
	s := snapshotWith(withRules(read(reviewer, core.EffectAllow, "anySite@1", nil)))
	s.Declarations = validated(source)
	plan := planned(t, fixtureCore.Plan(input(), s))

	f := graph(submissionSite(nil))
	if !fixtureCore.Evaluate(plan, f).Allowed() {
		t.Fatal("the site was not reached")
	}
	wrong := siteA()
	wrong.Type = "submission"
	f.Objects = []core.FactObject{relationSubmission(), wrong}
	if fixtureCore.Evaluate(plan, f).Allowed() {
		t.Fatal("an object of another type was reached")
	}
}

func TestAnEdgeWithAnInvalidTimeDeniesTheDecision(t *testing.T) {
	for name, mutate := range map[string]func(*core.EdgeFact){
		"start": func(e *core.EdgeFact) { e.StartsAt = "2026-10-01T24:00:00Z" },
		"end":   func(e *core.EdgeFact) { e.ExpiresAt = ptr("2026-10-01T00:00:00+07:00") },
		"start behind a past expiry": func(e *core.EdgeFact) {
			e.StartsAt, e.ExpiresAt = "nope", ptr("2026-10-13T09:00:00.000000Z")
		},
		"expiry behind a future start": func(e *core.EdgeFact) {
			e.StartsAt, e.ExpiresAt = "2026-10-14T00:00:00.000000Z", ptr("soon")
		},
	} {
		t.Run(name, func(t *testing.T) {
			wantReason(t, managedSite(t, graph(submissionSite(mutate), siteManager(alice, nil))), "invalid_time")
		})
	}
}

func TestAMissingFactBehindADenyPathDeniesInsteadOfAllowing(t *testing.T) {
	source := declarations()
	source.Templates = append(source.Templates, template("namedSite", "submission", core.ExistsExpr{
		Relation: "submission.site@1", Where: eq("name", literal("Site A")),
	}, nil))
	s := snapshotWith(withRules(
		read(reviewer, core.EffectAllow, "all@1", nil),
		read(personal, core.EffectDeny, "namedSite@1", nil),
	))
	s.Declarations = validated(source)
	plan := planned(t, fixtureCore.Plan(input(), s))

	site := func(fields map[string]core.FieldValue) core.CompleteFacts {
		f := graph(submissionSite(nil))
		target := siteA()
		target.Fields = fields
		f.Objects = []core.FactObject{relationSubmission(), target}
		return f
	}
	wantReason(t, fixtureCore.Evaluate(plan, site(map[string]core.FieldValue{"name": core.TextValue("Site A")})), "predicate_false")
	if !fixtureCore.Evaluate(plan, site(map[string]core.FieldValue{"name": core.TextValue("Site B")})).Allowed() {
		t.Fatal("the deny reached another site")
	}
	wantReason(t, fixtureCore.Evaluate(plan, site(map[string]core.FieldValue{})), "missing_fact")
}

func TestAPlanThatStartsAPathFromAnotherTypeGrantsNothing(t *testing.T) {
	where := core.PlanConstant{Value: true}
	relation := core.RelationRef{Key: "submission.assignee", Version: 1}
	target := core.RelationTarget{Kind: core.RelationTargetIdentity}
	f := factsOf(relationSubmission())
	f.Edges = []core.EdgeFact{edge("submission.assignee", relationRecord, identityTarget(alice), nil)}

	matching := core.PlanExists{Relation: relation, Source: "submission", Target: target, Where: where}
	if !fixtureCore.Evaluate(fixtureCore.IssueForTest("submission", matching, later), f).Allowed() {
		t.Fatal("the matching source was denied")
	}
	other := core.PlanExists{Relation: relation, Source: "site", Target: target, Where: where}
	if fixtureCore.Evaluate(fixtureCore.IssueForTest("submission", other, later), f).Allowed() {
		t.Fatal("a path from another source type was allowed")
	}
	nested := core.PlanExists{Relation: relation, Source: "submission", Target: target, Where: matching}
	if fixtureCore.Evaluate(fixtureCore.IssueForTest("submission", nested, later), f).Allowed() {
		t.Fatal("a path continuing from an identity was allowed")
	}
	unknown := core.PlanExists{Relation: relation, Source: "submission", Target: core.RelationTarget{Kind: "group"}, Where: where}
	wantReason(t, fixtureCore.Evaluate(fixtureCore.IssueForTest("submission", unknown, later), f), "unsupported_plan_node")
}

func withTemplate(expression core.Expr, resource string) core.SystemDeclarations {
	source := declarations()
	source.Templates = append(source.Templates, template("probe", resource, expression, nil))
	return source
}

func validationFails(t *testing.T, source core.SystemDeclarations) {
	t.Helper()
	if _, err := fixtureCore.Validate(source); err == nil {
		t.Fatal("the declarations were accepted")
	}
}

func TestRelationTypeAndDirectionAreCheckedAtValidation(t *testing.T) {
	cases := map[string]core.SystemDeclarations{
		"relation that starts at another type": withTemplate(core.ExistsExpr{Relation: "site.manager@1", Where: everything}, "submission"),
		"relation used from its target":        withTemplate(core.ExistsExpr{Relation: "submission.site@1", Where: everything}, "site"),
		"field of another type in the target": withTemplate(core.ExistsExpr{
			Relation: "submission.site@1", Where: eq("status", literal("x")),
		}, "submission"),
		"unknown relation version":  withTemplate(core.ExistsExpr{Relation: "submission.site@2", Where: everything}, "submission"),
		"relation name without one": withTemplate(core.ExistsExpr{Relation: "submission.site", Where: everything}, "submission"),
		"exists without a where":    withTemplate(core.ExistsExpr{Relation: "submission.site@1"}, "submission"),
	}
	for name, source := range cases {
		t.Run(name, func(t *testing.T) { validationFails(t, source) })
	}
}

func chainDeclarations(steps int) core.SystemDeclarations {
	path := everything
	for range steps {
		path = core.ExistsExpr{Relation: "submission.previous@1", Where: path}
	}
	source := withTemplate(path, "submission")
	source.Relations = append(source.Relations, core.RelationDeclaration{
		Key: "submission.previous", Version: 1, SourceType: "submission",
		Target:  core.RelationTarget{Kind: core.RelationTargetResource, Type: "submission"},
		Binding: core.RelationBinding{Kind: core.BindingEdgeStore},
	})
	return source
}

func TestPathsOfEightStepsAreAcceptedAndNineRejected(t *testing.T) {
	if _, err := fixtureCore.Validate(chainDeclarations(8)); err != nil {
		t.Fatalf("8 steps: %v", err)
	}
	validationFails(t, chainDeclarations(9))
	deeper := chainDeclarations(9)
	deeper.Limits.MaxPathDepth = new(9)
	validationFails(t, deeper)
	shorter := chainDeclarations(3)
	shorter.Limits.MaxPathDepth = new(2)
	validationFails(t, shorter)
}

type referenceExpr struct{ core.ConstantExpr }

func TestUnsupportedExpressionNodesAreRejected(t *testing.T) {
	cases := map[string]core.Expr{
		"nil":                        nil,
		"type outside the set":       referenceExpr{},
		"pointer to a member":        &core.ConstantExpr{Value: true},
		"unknown logical operator":   core.LogicalExpr{Op: "xor", Args: []core.Expr{everything}},
		"empty logical operator":     core.LogicalExpr{Args: []core.Expr{everything}},
		"unknown compare operator":   core.CompareExpr{Op: "like", Field: "status", Value: literal("x")},
		"empty compare operator":     core.CompareExpr{Field: "status", Value: literal("x")},
		"logical without arguments":  core.LogicalExpr{Op: core.OpAnd},
		"nil nested in a logical":    core.LogicalExpr{Op: core.OpOr, Args: []core.Expr{everything, nil}},
		"isNull on a required field": core.IsNullExpr{Field: "status"},
		"isNull on an unknown field": core.IsNullExpr{Field: "missing"},
	}
	for name, expression := range cases {
		t.Run(name, func(t *testing.T) { validationFails(t, withTemplate(expression, "submission")) })
	}
}

func TestACyclicExpressionStopsAtTheNodeLimit(t *testing.T) {
	args := []core.Expr{nil}
	args[0] = core.LogicalExpr{Op: core.OpAnd, Args: args}
	validationFails(t, withTemplate(args[0], "submission"))

	unreferenced := declarations()
	unreferenced.Policies = append(unreferenced.Policies, core.PermissionPolicy{
		Key: "unused", Version: 1,
		ContextRequirements: []core.ContextRequirement{},
		RequiredScope:       args[0],
		Obligations:         []core.Obligation{},
	})
	validationFails(t, unreferenced)
}

func TestAPolicyNoActionUsesStillNeedsAWellFormedScope(t *testing.T) {
	source := declarations()
	source.Policies = append(source.Policies, core.PermissionPolicy{
		Key: "unused", Version: 1,
		ContextRequirements: []core.ContextRequirement{},
		Obligations:         []core.Obligation{},
	})
	validationFails(t, source)
	source.Policies[len(source.Policies)-1].RequiredScope = everything
	if _, err := fixtureCore.Validate(source); err != nil {
		t.Fatalf("a well-formed unused policy: %v", err)
	}
}

func TestRelationsMustReferenceDeclaredTypesAndBeUnique(t *testing.T) {
	base := declarations()
	undeclared := declarations()
	undeclared.Relations = append(undeclared.Relations, core.RelationDeclaration{
		Key: "x", Version: 1, SourceType: "invoice",
		Target: core.RelationTarget{Kind: core.RelationTargetIdentity}, Binding: core.RelationBinding{Kind: core.BindingEdgeStore},
	})
	validationFails(t, undeclared)
	duplicated := declarations()
	duplicated.Relations = append(duplicated.Relations, base.Relations[0])
	validationFails(t, duplicated)

	mutants := map[string]func(*core.RelationDeclaration){
		"undeclared target":    func(r *core.RelationDeclaration) { r.Target.Type = "invoice" },
		"unknown target kind":  func(r *core.RelationDeclaration) { r.Target.Kind = "group" },
		"zero target":          func(r *core.RelationDeclaration) { r.Target = core.RelationTarget{} },
		"unknown binding":      func(r *core.RelationDeclaration) { r.Binding = core.RelationBinding{Kind: "view"} },
		"domain without a key": func(r *core.RelationDeclaration) { r.Binding = core.RelationBinding{Kind: core.BindingDomain} },
		"version zero":         func(r *core.RelationDeclaration) { r.Version = 0 },
		"invalid key":          func(r *core.RelationDeclaration) { r.Key = "Bad Key" },
	}
	for name, mutate := range mutants {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			mutate(&source.Relations[0])
			validationFails(t, source)
		})
	}
}

func TestCanonicalFormAndHashAreIndependentOfDeclarationOrder(t *testing.T) {
	base := declarations()
	reordered := declarations()
	slices.Reverse(reordered.Resources)
	slices.Reverse(reordered.Relations)
	slices.Reverse(reordered.Policies)
	slices.Reverse(reordered.Templates)
	slices.Reverse(reordered.Capabilities.Validators)
	slices.Reverse(reordered.Capabilities.ObligationHandlers)

	hash := func(d *core.ValidatedDeclarations) [32]byte { return sha256.Sum256([]byte(d.Canonical())) }
	if hash(validated(base)) != hash(validated(reordered)) {
		t.Fatalf("order changed the canonical form:\n%s\n%s", validated(base).Canonical(), validated(reordered).Canonical())
	}
	changed := declarations()
	for i := range changed.Templates {
		if changed.Templates[i].Key == "all" {
			changed.Templates[i].Version = 2
		}
	}
	if hash(validated(base)) == hash(validated(changed)) {
		t.Fatal("a new template version did not change the hash")
	}
	for name, mutate := range map[string]func(*core.SystemDeclarations){
		"literal": func(d *core.SystemDeclarations) { d.Policies[1].RequiredScope = eq("status", literal("other")) },
		"operator": func(d *core.SystemDeclarations) {
			d.Templates[4].Expression = core.CompareExpr{Op: core.OpLt, Field: "amount", Value: parameter("limit")}
		},
		"nullable": func(d *core.SystemDeclarations) {
			d.Resources[0].Fields["status"] = core.FieldType{Kind: core.FieldString, Nullable: true}
		},
		"limit": func(d *core.SystemDeclarations) { d.Limits.MaxRules = new(7) },
		"parameters": func(d *core.SystemDeclarations) {
			d.Policies[1].ContextRequirements = []core.ContextRequirement{minimumAssurance("3")}
		},
		"lifecycle": func(d *core.SystemDeclarations) { d.Policies[0].Lifecycle = core.LifecycleDeprecated },
		"action": func(d *core.SystemDeclarations) {
			d.Resources[1].Actions["read"] = core.ActionDeclaration{Policy: core.RelationRef{Key: "baseline", Version: 1}, Boundary: core.BoundaryRequired}
		},
	} {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			mutate(&source)
			if validated(source).Canonical() == validated(base).Canonical() {
				t.Fatal("the change did not reach the canonical form")
			}
		})
	}
}
