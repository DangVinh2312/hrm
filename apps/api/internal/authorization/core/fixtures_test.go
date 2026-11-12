package core_test

import (
	"fmt"
	"strconv"
	"strings"
	"testing"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/values"
)

// Synthetic declarations shared by the core tests. Names are fixture data, not core concepts.

const (
	alice core.IdentityID = "a0000000-0000-4000-8000-000000000001"
	bob   core.IdentityID = "b0000000-0000-4000-8000-000000000002"

	now   = "2026-10-13T10:00:00.000000Z"
	later = "2026-10-13T10:00:02.000000Z"
)

var fixtureCore = newCore()

func newCore() *core.Core {
	c, err := core.New(values.Codecs())
	if err != nil {
		panic(err)
	}
	return c
}

func ptr(value string) *string { return &value }

func literal(value string) core.ValueRef {
	return core.ValueRef{From: core.SourceLiteral, Literal: core.TextValue(value)}
}

func parameter(name string) core.ValueRef {
	return core.ValueRef{From: core.SourceParameter, Name: name}
}

func eq(field string, value core.ValueRef) core.Expr {
	return core.CompareExpr{Op: core.OpEq, Field: field, Value: value}
}

var everything core.Expr = core.ConstantExpr{Value: true}

var principalID core.Expr = eq("identityId", core.ValueRef{From: core.SourcePrincipal, Name: "id"})

func baselinePolicy() core.PermissionPolicy {
	return core.PermissionPolicy{
		Key: "baseline", Version: 1,
		ContextRequirements: []core.ContextRequirement{},
		RequiredScope:       everything,
		Obligations:         []core.Obligation{},
	}
}

func minimumAssurance(minimum string) core.ContextRequirement {
	return core.ContextRequirement{
		Validator:  "minimumAssurance@1",
		Parameters: map[string]core.Scalar{"minimum": core.Text(minimum)},
	}
}

func declarations() core.SystemDeclarations {
	baseline := core.RelationRef{Key: "baseline", Version: 1}
	return core.SystemDeclarations{
		Resources: []core.ResourceDeclaration{
			{
				Key: "submission", KeyKind: core.KeyInteger,
				Fields: map[string]core.FieldType{
					"status":   {Kind: core.FieldString},
					"amount":   {Kind: core.FieldDecimal},
					"title":    {Kind: core.FieldString, Nullable: true},
					"priority": {Kind: core.FieldInteger, Nullable: true},
				},
				Actions: map[string]core.ActionDeclaration{
					"read":    {Policy: baseline, Boundary: core.BoundaryOptional},
					"approve": {Policy: core.RelationRef{Key: "approval", Version: 1}, Boundary: core.BoundaryOptional},
				},
			},
			{
				Key: "site", KeyKind: core.KeyUUID,
				Fields:  map[string]core.FieldType{"name": {Kind: core.FieldString}},
				Actions: map[string]core.ActionDeclaration{"read": {Policy: baseline, Boundary: core.BoundaryOptional}},
			},
		},
		Relations: []core.RelationDeclaration{
			{
				Key: "submission.site", Version: 1, SourceType: "submission",
				Target:  core.RelationTarget{Kind: core.RelationTargetResource, Type: "site"},
				Binding: core.RelationBinding{Kind: core.BindingEdgeStore},
			},
			{
				Key: "site.manager", Version: 1, SourceType: "site",
				Target:  core.RelationTarget{Kind: core.RelationTargetIdentity},
				Binding: core.RelationBinding{Kind: core.BindingDomain, Key: "siteManagers"},
			},
			{
				Key: "submission.assignee", Version: 1, SourceType: "submission",
				Target:  core.RelationTarget{Kind: core.RelationTargetIdentity},
				Binding: core.RelationBinding{Kind: core.BindingEdgeStore},
			},
		},
		Policies: []core.PermissionPolicy{
			baselinePolicy(),
			{
				Key: "approval", Version: 1,
				ContextRequirements: []core.ContextRequirement{minimumAssurance("2")},
				RequiredScope:       eq("status", literal("pending")),
				Obligations:         []core.Obligation{{Handler: "auditBeforeCommit@1"}},
			},
		},
		Templates: []core.ScopeTemplate{
			template("all", "submission", everything, nil),
			template("assignedToMe", "submission", core.ExistsExpr{Relation: "submission.assignee@1", Where: principalID}, nil),
			template("managedSite", "submission", core.ExistsExpr{
				Relation: "submission.site@1",
				Where:    core.ExistsExpr{Relation: "site.manager@1", Where: principalID},
			}, nil),
			template("statusIs", "submission", eq("status", parameter("status")), map[string]core.FieldKind{"status": core.FieldString}),
			template("amountAtMost", "submission", core.CompareExpr{Op: core.OpLte, Field: "amount", Value: parameter("limit")},
				map[string]core.FieldKind{"limit": core.FieldDecimal}),
			template("priorityBelow", "submission", core.CompareExpr{Op: core.OpLt, Field: "priority", Value: parameter("limit")},
				map[string]core.FieldKind{"limit": core.FieldInteger}),
			template("titleIs", "submission", eq("title", parameter("title")), map[string]core.FieldKind{"title": core.FieldString}),
			template("untitled", "submission", core.IsNullExpr{Field: "title"}, nil),
		},
		Boundaries: []core.PermissionBoundary{},
		Capabilities: core.Capabilities{
			Validators:         []string{"minimumAssurance@1"},
			ObligationHandlers: []string{"auditBeforeCommit@1"},
		},
	}
}

func template(key, resource string, expression core.Expr, parameters map[string]core.FieldKind) core.ScopeTemplate {
	if parameters == nil {
		parameters = map[string]core.FieldKind{}
	}
	return core.ScopeTemplate{Key: key, Version: 1, Resource: resource, Parameters: parameters, Expression: expression}
}

func validatedBy(c *core.Core, source core.SystemDeclarations) *core.ValidatedDeclarations {
	result, err := c.Validate(source)
	if err != nil {
		panic(fmt.Sprintf("fixture declarations invalid: %v", err))
	}
	return result
}

func validated(source core.SystemDeclarations) *core.ValidatedDeclarations {
	return validatedBy(fixtureCore, source)
}

var ruleCounter int

func rule(permission string, subject core.RuleSubject, effect core.Effect, templateRef string, parameters map[string]core.Scalar) core.RuleFact {
	ruleCounter++
	key, version, _ := strings.Cut(templateRef, "@")
	number, err := strconv.Atoi(version)
	if err != nil {
		panic(err)
	}
	if parameters == nil {
		parameters = map[string]core.Scalar{}
	}
	return core.RuleFact{
		ID: "rule-" + strconv.Itoa(ruleCounter), Permission: permission, Subject: subject, Effect: effect,
		Template: core.RelationRef{Key: key, Version: number}, Parameters: parameters,
	}
}

func text(pairs ...string) map[string]core.Scalar {
	result := map[string]core.Scalar{}
	for i := 0; i+1 < len(pairs); i += 2 {
		result[pairs[i]] = core.Text(pairs[i+1])
	}
	return result
}

var (
	reviewer = core.RuleSubject{Kind: core.SubjectRole, Role: "reviewer"}
	personal = core.RuleSubject{Kind: core.SubjectIdentity, Identity: alice}
)

func read(subject core.RuleSubject, effect core.Effect, templateRef string, parameters map[string]core.Scalar) core.RuleFact {
	return rule("submission.read", subject, effect, templateRef, parameters)
}

func assuranceValidator(parameters map[string]core.Scalar, input core.ValidatorInput) core.ValidatorResult {
	minimum, isText := parameters["minimum"].AsText()
	if !isText {
		return core.ValidatorFalse
	}
	required, err := strconv.Atoi(minimum)
	if err != nil || input.Principal.Assurance < required {
		return core.ValidatorFalse
	}
	return core.ValidatorTrue
}

func fixtureRegistry() core.Registry {
	return core.Registry{
		Validators:         map[string]core.ContextValidator{"minimumAssurance@1": assuranceValidator},
		ObligationHandlers: []string{"auditBeforeCommit@1"},
	}
}

func catalogRow(key string, policy core.RelationRef, boundary core.BoundaryRequirement) core.PermissionFact {
	resource, action, _ := strings.Cut(key, ".")
	return core.PermissionFact{
		Key: key, Resource: resource, Action: action, Policy: policy, Boundary: boundary, Lifecycle: core.LifecycleActive,
	}
}

func snapshot() core.AuthoritySnapshot {
	baseline := core.RelationRef{Key: "baseline", Version: 1}
	return core.AuthoritySnapshot{
		Revision:     "7",
		Declarations: validated(declarations()),
		User:         &core.AuthorityUser{ID: alice, State: core.UserActive},
		Roles:        []string{"reviewer"},
		Permissions: []core.PermissionFact{
			catalogRow("submission.read", baseline, core.BoundaryOptional),
			catalogRow("submission.approve", core.RelationRef{Key: "approval", Version: 1}, core.BoundaryOptional),
			catalogRow("site.read", baseline, core.BoundaryOptional),
		},
		Rules:      []core.RuleFact{},
		Boundaries: []core.BoundaryBindingFact{},
		Registry:   fixtureRegistry(),
	}
}

func snapshotWith(mutate func(*core.AuthoritySnapshot)) core.AuthoritySnapshot {
	s := snapshot()
	if mutate != nil {
		mutate(&s)
	}
	return s
}

func withRules(rules ...core.RuleFact) func(*core.AuthoritySnapshot) {
	return func(s *core.AuthoritySnapshot) { s.Rules = rules }
}

func input() core.TrustedInput {
	return core.TrustedInput{
		Principal: core.TrustedPrincipal{ID: alice, Assurance: 1},
		Resource:  "submission", Action: "read",
		Context: map[string]core.Scalar{},
		Now:     now, ValidUntil: later,
	}
}

func approveInput(assurance int) core.TrustedInput {
	i := input()
	i.Action = "approve"
	i.Principal.Assurance = assurance
	return i
}

func submission(objectID, key string, fields map[string]core.FieldValue) core.FactObject {
	merged := map[string]core.FieldValue{
		"status": core.TextValue("pending"), "amount": core.TextValue("10.00"),
		"title": core.TextValue("Fixture"), "priority": core.NullValue(),
	}
	for name, value := range fields {
		merged[name] = value
	}
	return core.FactObject{
		Type: "submission", Key: core.Key{Kind: core.KeyInteger, Value: key}, ObjectID: objectID, Fields: merged,
	}
}

func factsOf(record core.FactObject) core.CompleteFacts {
	return core.CompleteFacts{Now: now, Record: record, Objects: []core.FactObject{record}}
}

func planned(t *testing.T, decision core.Decision) *core.AuthorizedPlan {
	t.Helper()
	if !decision.Allowed() {
		t.Fatalf("plan denied: %s", decision.Reason())
	}
	return decision.Plan()
}

func decide(c *core.Core, i core.TrustedInput, s core.AuthoritySnapshot, f core.CompleteFacts) bool {
	decision := c.Plan(i, s)
	if !decision.Allowed() {
		return false
	}
	return c.Evaluate(decision.Plan(), f).Allowed()
}

func wantReason(t *testing.T, decision core.Decision, want string) {
	t.Helper()
	if decision.Allowed() {
		t.Fatalf("allowed, want deny %q", want)
	}
	if decision.Reason() != want {
		t.Fatalf("reason %q, want %q", decision.Reason(), want)
	}
}
