package core_test

import (
	"errors"
	"reflect"
	"testing"

	"hrm/api/internal/authorization/core"
)

func TestZeroValuesOfDecisionTypesDeny(t *testing.T) {
	var decision core.Decision
	if decision.Allowed() {
		t.Error("the zero Decision is allowed")
	}
	if decision.Plan() != nil {
		t.Error("the zero Decision has a plan")
	}
	if len(decision.Obligations()) != 0 {
		t.Error("the zero Decision has obligations")
	}

	wantReason(t, fixtureCore.Evaluate(&core.AuthorizedPlan{}, factsOf(pendingRecord())), "foreign_plan")
	wantReason(t, fixtureCore.Plan(input(), core.AuthoritySnapshot{}), "unvalidated_declarations")
	wantReason(t, fixtureCore.PlanUnrestricted(input(), core.AuthoritySnapshot{}), "unvalidated_declarations")
	wantReason(t, fixtureCore.Plan(core.TrustedInput{}, snapshot()), "invalid_principal")
	wantReason(t, fixtureCore.PlanUnrestricted(core.TrustedInput{}, snapshot()), "invalid_principal")

	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(reviewer, core.EffectAllow, "all@1", nil)))))
	wantReason(t, fixtureCore.Evaluate(plan, core.CompleteFacts{}), "invalid_now")

	if result, err := fixtureCore.Validate(core.SystemDeclarations{}); err == nil || result != nil {
		t.Errorf("zero declarations: %v, %v", result, err)
	}
	if fixtureCore.IsValidated(&core.ValidatedDeclarations{}) || fixtureCore.IsValidated(nil) {
		t.Error("zero declarations count as validated")
	}
}

func TestZeroValuesOfDeclaredTypesAreRefusedByValidation(t *testing.T) {
	cases := map[string]func(*core.SystemDeclarations){
		"resource": func(d *core.SystemDeclarations) { d.Resources = append(d.Resources, core.ResourceDeclaration{}) },
		"relation": func(d *core.SystemDeclarations) { d.Relations = append(d.Relations, core.RelationDeclaration{}) },
		"policy":   func(d *core.SystemDeclarations) { d.Policies = append(d.Policies, core.PermissionPolicy{}) },
		"template": func(d *core.SystemDeclarations) { d.Templates = append(d.Templates, core.ScopeTemplate{}) },
		"boundary": func(d *core.SystemDeclarations) { d.Boundaries = append(d.Boundaries, core.PermissionBoundary{}) },
		"action": func(d *core.SystemDeclarations) {
			d.Resources[1].Actions["other"] = core.ActionDeclaration{}
		},
		"requirement": func(d *core.SystemDeclarations) {
			d.Policies[0].ContextRequirements = []core.ContextRequirement{{}}
		},
		"obligation": func(d *core.SystemDeclarations) { d.Policies[0].Obligations = []core.Obligation{{}} },
		"scope":      func(d *core.SystemDeclarations) { d.Policies[0].RequiredScope = nil },
		"value ref": func(d *core.SystemDeclarations) {
			d.Policies[1].RequiredScope = core.CompareExpr{Op: core.OpEq, Field: "status"}
		},
		"compare": func(d *core.SystemDeclarations) { d.Policies[1].RequiredScope = core.CompareExpr{} },
		"logical": func(d *core.SystemDeclarations) { d.Policies[1].RequiredScope = core.LogicalExpr{} },
		"is null": func(d *core.SystemDeclarations) { d.Policies[1].RequiredScope = core.IsNullExpr{} },
		"exists":  func(d *core.SystemDeclarations) { d.Policies[1].RequiredScope = core.ExistsExpr{} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			mutate(&source)
			validationFails(t, source)
		})
	}
}

func TestZeroConstantExpressionGrantsNothing(t *testing.T) {
	source := declarations()
	source.Templates = append(source.Templates, template("nothing", "submission", core.ConstantExpr{}, nil))
	s := snapshotWith(withRules(read(reviewer, core.EffectAllow, "nothing@1", nil)))
	s.Declarations = validated(source)
	if decide(fixtureCore, input(), s, factsOf(pendingRecord())) {
		t.Fatal("a zero constant granted")
	}
}

func TestZeroPlanNodesDeny(t *testing.T) {
	cases := map[string]core.PlanExpr{
		"nil":        nil,
		"constant":   core.PlanConstant{},
		"logical":    core.PlanLogical{},
		"not of nil": core.PlanNot{},
		"compare":    core.PlanCompare{},
		"is null":    core.PlanIsNull{},
		"exists":     core.PlanExists{},
		"exception":  core.PlanException{},
	}
	for name, predicate := range cases {
		t.Run(name, func(t *testing.T) {
			plan := fixtureCore.IssueForTest("submission", predicate, later)
			if fixtureCore.Evaluate(plan, factsOf(pendingRecord())).Allowed() {
				t.Fatal("allowed")
			}
		})
	}
	unknown := fixtureCore.IssueForTest("submission", core.PlanLogical{Op: "xor", Args: []core.PlanExpr{core.PlanConstant{Value: true}}}, later)
	wantReason(t, fixtureCore.Evaluate(unknown, factsOf(pendingRecord())), "unsupported_plan_node")
	like := fixtureCore.IssueForTest("submission", core.PlanCompare{Op: "like", Field: "status", Kind: core.FieldString, Value: core.Text("pending")}, later)
	wantReason(t, fixtureCore.Evaluate(like, factsOf(pendingRecord())), "unsupported_plan_node")
	badKind := fixtureCore.IssueForTest("submission", core.PlanCompare{Op: core.OpEq, Field: "status", Kind: "money", Value: core.Text("pending")}, later)
	wantReason(t, fixtureCore.Evaluate(badKind, factsOf(pendingRecord())), "internal_error")
}

func TestZeroEnumsAreNotAnyOfTheirMembers(t *testing.T) {
	if core.Lifecycle("") == core.LifecycleActive || core.BoundaryRequirement("") == core.BoundaryOptional ||
		core.Effect("") == core.EffectAllow || core.UserState("") == core.UserActive ||
		core.SubjectKind("") == core.SubjectRole || core.EdgeTargetKind("") == core.EdgeTargetObject ||
		core.ExceptionPurpose("") == core.PurposeManual || core.ValueSource("") == core.SourceLiteral {
		t.Error("an empty enum equals a member")
	}
	if core.ValidatorResult(0) == core.ValidatorTrue {
		t.Error("the zero validator result passes")
	}
	if core.Comparison(0) == core.Equal {
		t.Error("the zero comparison reads as equal")
	}
}

func TestZeroCoreRefusesEverything(t *testing.T) {
	for name, c := range map[string]*core.Core{"zero": {}, "nil": nil} {
		t.Run(name, func(t *testing.T) {
			if c.Plan(input(), snapshot()).Allowed() {
				t.Error("Plan")
			}
			if c.PlanUnrestricted(input(), snapshot()).Allowed() {
				t.Error("PlanUnrestricted")
			}
			plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(reviewer, core.EffectAllow, "all@1", nil)))))
			if c.Evaluate(plan, factsOf(pendingRecord())).Allowed() {
				t.Error("Evaluate")
			}
			if result, err := c.Validate(declarations()); err == nil || result != nil {
				t.Errorf("Validate: %v, %v", result, err)
			}
			if _, err := c.ParseKey(core.KeyInteger, "1"); err == nil {
				t.Error("ParseKey")
			}
			if _, err := c.NormalizeValue(core.FieldInteger, core.TextValue("1")); err == nil || errors.Is(err, core.ErrInvalidValue) {
				t.Errorf("NormalizeValue: %v", err)
			}
			if _, err := c.CompareValues(core.FieldInteger, core.Text("1"), core.Text("1")); err == nil {
				t.Error("CompareValues")
			}
			if c.IsCanonicalUUID(string(alice)) {
				t.Error("IsCanonicalUUID")
			}
			if c.IsValidated(validated(declarations())) {
				t.Error("IsValidated")
			}
			if c.Issued(plan) {
				t.Error("Issued")
			}
		})
	}
}

func TestChangingACopyDoesNotReachTheOriginal(t *testing.T) {
	source := declarations()
	d := validated(source)
	before := d.Canonical()

	source.Resources[0].Fields["status"] = core.FieldType{Kind: core.FieldBoolean}
	source.Resources[0].Actions["read"] = core.ActionDeclaration{}
	source.Policies[1].ContextRequirements[0].Parameters["minimum"] = core.Text("0")
	source.Policies[1].Obligations[0].Handler = "other@1"
	source.Capabilities.Validators[0] = "other@1"
	source.Templates[3].Parameters["status"] = core.FieldBoolean
	if d.Canonical() != before {
		t.Fatal("the canonical form changed")
	}
	s := snapshot()
	s.Declarations = d
	wantReason(t, fixtureCore.Plan(approveInput(1), s), "context_requirement_failed")

	resource, ok := d.Resource("submission")
	if !ok {
		t.Fatal("no resource")
	}
	resource.Fields["status"] = core.FieldType{Kind: core.FieldBoolean}
	delete(resource.Actions, "read")
	policy, ok := d.Policy(core.RelationRef{Key: "approval", Version: 1})
	if !ok {
		t.Fatal("no policy")
	}
	policy.ContextRequirements[0].Parameters["minimum"] = core.Text("0")
	policy.Obligations[0].Handler = "other@1"
	policy.RequiredScope = everything
	templates := d.Templates()
	templates[0].Parameters["injected"] = core.FieldString
	capabilities := d.Capabilities()
	capabilities.Validators[0] = "other@1"
	for _, listed := range d.Resources() {
		for name := range listed.Fields {
			delete(listed.Fields, name)
		}
	}

	fresh, _ := d.Resource("submission")
	if fresh.Fields["status"].Kind != core.FieldString {
		t.Error("the resource table changed")
	}
	if _, kept := fresh.Actions["read"]; !kept {
		t.Error("an action disappeared")
	}
	stored, _ := d.Policy(core.RelationRef{Key: "approval", Version: 1})
	if got, _ := stored.ContextRequirements[0].Parameters["minimum"].AsText(); got != "2" {
		t.Errorf("the policy parameter became %q", got)
	}
	if stored.Obligations[0].Handler != "auditBeforeCommit@1" {
		t.Errorf("the obligation became %q", stored.Obligations[0].Handler)
	}
	if !reflect.DeepEqual(stored.RequiredScope, eq("status", literal("pending"))) {
		t.Errorf("the scope became %#v", stored.RequiredScope)
	}
	if len(d.Templates()[0].Parameters) != 0 {
		t.Error("a template gained a parameter")
	}
	if d.Capabilities().Validators[0] != "minimumAssurance@1" {
		t.Error("the capabilities changed")
	}
	wantReason(t, fixtureCore.Plan(approveInput(1), s), "context_requirement_failed")
}

func TestChangingAnExpressionCopyDoesNotReachTheDeclaration(t *testing.T) {
	source := declarations()
	args := []core.Expr{eq("status", literal("pending")), everything}
	source.Policies[1].RequiredScope = core.LogicalExpr{Op: core.OpAnd, Args: args}
	d := validated(source)
	args[0] = everything
	policy, _ := d.Policy(core.RelationRef{Key: "approval", Version: 1})
	policy.RequiredScope.(core.LogicalExpr).Args[0] = everything
	stored, _ := d.Policy(core.RelationRef{Key: "approval", Version: 1})
	if !reflect.DeepEqual(stored.RequiredScope.(core.LogicalExpr).Args[0], eq("status", literal("pending"))) {
		t.Fatalf("the declaration became %#v", stored.RequiredScope)
	}
}

func TestChangingACopyOfAPlanDoesNotChangeTheDecision(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(approveInput(3), snapshotWith(withRules(
		rule("submission.approve", reviewer, core.EffectAllow, "statusIs@1", text("status", "pending")),
	))))
	predicate := plan.Predicate()
	logical, ok := predicate.(core.PlanLogical)
	if !ok {
		t.Fatalf("predicate %#v", predicate)
	}
	for i := range logical.Args {
		logical.Args[i] = core.PlanConstant{Value: true}
	}
	obligations := plan.Obligations()
	obligations[0].Handler = "other@1"
	if plan.Obligations()[0].Handler != "auditBeforeCommit@1" {
		t.Error("the plan's obligations changed")
	}
	decision := fixtureCore.Plan(approveInput(3), snapshotWith(withRules(
		rule("submission.approve", reviewer, core.EffectAllow, "statusIs@1", text("status", "pending")),
	)))
	decisionObligations := decision.Obligations()
	decisionObligations[0].Handler = "other@1"
	if decision.Obligations()[0].Handler != "auditBeforeCommit@1" {
		t.Error("the decision's obligations changed")
	}
	if fixtureCore.Evaluate(plan, factsOf(approvedRecord())).Allowed() {
		t.Fatal("changing a copy widened the plan")
	}
}

func TestRolesInThePlanAreSortedCopies(t *testing.T) {
	roles := []string{"z", "reviewer", "a", "reviewer"}
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(func(s *core.AuthoritySnapshot) { s.Roles = roles })))
	roles[1] = "other"
	exceptions := map[string]core.PlanException{}
	var walk func(core.PlanExpr)
	walk = func(node core.PlanExpr) {
		switch n := node.(type) {
		case core.PlanLogical:
			for _, arg := range n.Args {
				walk(arg)
			}
		case core.PlanNot:
			walk(n.Arg)
		case core.PlanException:
			exceptions[string(n.Effect)] = n
		}
	}
	walk(plan.Predicate())
	if len(exceptions) != 2 {
		t.Fatalf("exceptions %#v", exceptions)
	}
	for effect, node := range exceptions {
		if !reflect.DeepEqual(node.Roles, []string{"a", "reviewer", "z"}) {
			t.Errorf("%s roles %v", effect, node.Roles)
		}
	}
}
