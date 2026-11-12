package core_test

import (
	"reflect"
	"testing"

	"hrm/api/internal/authorization/core"
)

const (
	policyPending  = "53000000-0000-4000-8000-000000000001"
	policyApproved = "53000000-0000-4000-8000-000000000002"
)

func pendingSubmission() core.FactObject {
	return submission(policyPending, "1", map[string]core.FieldValue{"status": core.TextValue("pending")})
}

func approvedSubmission() core.FactObject {
	return submission(policyApproved, "2", map[string]core.FieldValue{"status": core.TextValue("approved")})
}

func approveAllowException(objectID string) core.ExceptionFact {
	return core.ExceptionFact{
		ObjectID: objectID, Permission: "submission.approve", Subject: personal,
		Effect: core.EffectAllow, Purpose: core.PurposeManual, StartsAt: "2026-10-01T00:00:00.000000Z",
	}
}

func TestARecordAllowCannotBypassThePolicyRequiredScope(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(approveInput(3), snapshot()))
	if fixtureCore.Evaluate(plan, withExceptions(approvedSubmission(), approveAllowException(policyApproved))).Allowed() {
		t.Fatal("a record allow passed the required scope")
	}
	if !fixtureCore.Evaluate(plan, withExceptions(pendingSubmission(), approveAllowException(policyPending))).Allowed() {
		t.Fatal("a record allow inside the required scope was denied")
	}
}

func TestContextRequirementIsEnforcedBeforeAnyGrant(t *testing.T) {
	rules := withRules(rule("submission.approve", reviewer, core.EffectAllow, "all@1", nil))
	wantReason(t, fixtureCore.Plan(approveInput(1), snapshotWith(rules)), "context_requirement_failed")
	planned(t, fixtureCore.Plan(approveInput(2), snapshotWith(rules)))
}

func TestValidatorResultsOtherThanTrueDeny(t *testing.T) {
	registry := func(validators map[string]core.ContextValidator) func(*core.AuthoritySnapshot) {
		return func(s *core.AuthoritySnapshot) {
			s.Registry = core.Registry{Validators: validators, ObligationHandlers: []string{"auditBeforeCommit@1"}}
		}
	}
	answering := func(result core.ValidatorResult) map[string]core.ContextValidator {
		return map[string]core.ContextValidator{
			"minimumAssurance@1": func(map[string]core.Scalar, core.ValidatorInput) core.ValidatorResult { return result },
		}
	}
	cases := map[string]struct {
		validators map[string]core.ContextValidator
		reason     string
	}{
		"false":        {answering(core.ValidatorFalse), "context_requirement_failed"},
		"unknown":      {answering(core.ValidatorUnknown), "context_requirement_failed"},
		"out of range": {answering(core.ValidatorResult(9)), "context_requirement_failed"},
		"missing":      {map[string]core.ContextValidator{}, "validator_unavailable"},
		"nil registry": {nil, "validator_unavailable"},
		"nil entry":    {map[string]core.ContextValidator{"minimumAssurance@1": nil}, "validator_unavailable"},
		"panic":        {map[string]core.ContextValidator{"minimumAssurance@1": func(map[string]core.Scalar, core.ValidatorInput) core.ValidatorResult { panic("fact source down") }}, "validator_failed"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			wantReason(t, fixtureCore.Plan(approveInput(5), snapshotWith(registry(c.validators))), c.reason)
		})
	}
}

func TestAValidatorCannotChangeSharedParametersOrContext(t *testing.T) {
	calls := 0
	s := snapshotWith(func(s *core.AuthoritySnapshot) {
		s.Registry.Validators = map[string]core.ContextValidator{
			"minimumAssurance@1": func(parameters map[string]core.Scalar, in core.ValidatorInput) core.ValidatorResult {
				calls++
				if _, ok := parameters["minimum"].AsText(); !ok {
					return core.ValidatorFalse
				}
				parameters["minimum"] = core.Text("9")
				in.Context["injected"] = core.Text("x")
				return core.ValidatorTrue
			},
		}
	})
	i := approveInput(1)
	for range 2 {
		planned(t, fixtureCore.Plan(i, s))
	}
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
	policy, ok := s.Declarations.Policy(core.RelationRef{Key: "approval", Version: 1})
	if !ok {
		t.Fatal("no policy")
	}
	if got, _ := policy.ContextRequirements[0].Parameters["minimum"].AsText(); got != "2" {
		t.Errorf("declaration parameter became %q", got)
	}
	if _, leaked := i.Context["injected"]; leaked {
		t.Error("the validator wrote into the caller's context")
	}
}

func TestPolicySatisfiedButNoGrantStillDenies(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshot()))
	if fixtureCore.Evaluate(plan, factsOf(pendingSubmission())).Allowed() {
		t.Fatal("allowed without a grant")
	}
}

func TestObligationsAreAttachedWhicheverPathGrantsAndMergedByHandler(t *testing.T) {
	want := []core.Obligation{{Handler: "auditBeforeCommit@1"}}
	decision := fixtureCore.Plan(approveInput(3), snapshot())
	if !reflect.DeepEqual(decision.Obligations(), want) {
		t.Fatalf("plan obligations %#v", decision.Obligations())
	}
	evaluated := fixtureCore.Evaluate(decision.Plan(), withExceptions(pendingSubmission(), approveAllowException(policyPending)))
	if !evaluated.Allowed() || !reflect.DeepEqual(evaluated.Obligations(), want) || evaluated.Plan() != decision.Plan() {
		t.Fatalf("evaluated: allowed=%v obligations=%#v", evaluated.Allowed(), evaluated.Obligations())
	}

	doubled := declarations()
	doubled.Policies[1].Obligations = []core.Obligation{{Handler: "auditBeforeCommit@1"}, {Handler: "auditBeforeCommit@1"}}
	s := snapshot()
	s.Declarations = validated(doubled)
	merged := fixtureCore.Plan(approveInput(3), s)
	if !reflect.DeepEqual(merged.Obligations(), want) {
		t.Fatalf("merged obligations %#v", merged.Obligations())
	}
}

func TestAbsentRetiredOrMismatchedPoliciesFailReadinessAndRuntime(t *testing.T) {
	absent := declarations()
	absent.Policies = absent.Policies[:1]
	validationFails(t, absent)
	retired := declarations()
	retired.Policies[1].Lifecycle = core.LifecycleRetired
	validationFails(t, retired)

	catalog := func(mutate func(*core.PermissionFact)) func(*core.AuthoritySnapshot) {
		return func(s *core.AuthoritySnapshot) {
			for i := range s.Permissions {
				if s.Permissions[i].Key == "submission.approve" {
					mutate(&s.Permissions[i])
				}
			}
		}
	}
	cases := map[string]struct {
		mutate func(*core.PermissionFact)
		reason string
	}{
		"other version":  {func(p *core.PermissionFact) { p.Policy.Version = 2 }, "policy_binding_mismatch"},
		"other policy":   {func(p *core.PermissionFact) { p.Policy.Key = "baseline" }, "policy_binding_mismatch"},
		"zero policy":    {func(p *core.PermissionFact) { p.Policy = core.RelationRef{} }, "policy_binding_mismatch"},
		"retired":        {func(p *core.PermissionFact) { p.Lifecycle = core.LifecycleRetired }, "permission_unavailable"},
		"no lifecycle":   {func(p *core.PermissionFact) { p.Lifecycle = "" }, "permission_unavailable"},
		"odd lifecycle":  {func(p *core.PermissionFact) { p.Lifecycle = "paused" }, "permission_unavailable"},
		"other action":   {func(p *core.PermissionFact) { p.Action = "read" }, "permission_unavailable"},
		"other resource": {func(p *core.PermissionFact) { p.Resource = "site" }, "permission_unavailable"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			wantReason(t, fixtureCore.Plan(approveInput(3), snapshotWith(catalog(c.mutate))), c.reason)
		})
	}
	deprecated := snapshotWith(catalog(func(p *core.PermissionFact) { p.Lifecycle = core.LifecycleDeprecated }))
	planned(t, fixtureCore.Plan(approveInput(3), deprecated))
}

func TestMissingValidatorOrObligationHandlerFailsReadinessAndRuntime(t *testing.T) {
	noValidator := declarations()
	noValidator.Capabilities.Validators = []string{}
	validationFails(t, noValidator)
	noHandler := declarations()
	noHandler.Capabilities.ObligationHandlers = []string{}
	validationFails(t, noHandler)
	for name, handlers := range map[string][]string{"empty": {}, "nil": nil, "other": {"other@1"}} {
		t.Run(name, func(t *testing.T) {
			s := snapshotWith(func(s *core.AuthoritySnapshot) { s.Registry.ObligationHandlers = handlers })
			wantReason(t, fixtureCore.Plan(approveInput(3), s), "obligation_handler_unavailable")
		})
	}
}

func TestUnknownValueSourcesAndWrongLiteralsAreRejected(t *testing.T) {
	cases := map[string]core.Expr{
		"plain value without a source": core.CompareExpr{Op: core.OpEq, Field: "status"},
		"unknown source":               eq("status", core.ValueRef{From: "record", Name: "x"}),
		"null literal":                 eq("status", core.ValueRef{From: core.SourceLiteral, Literal: core.NullValue()}),
		"zero literal":                 eq("status", core.ValueRef{From: core.SourceLiteral}),
		"unknown field":                eq("missing", literal("x")),
		"lt on a boolean literal":      core.CompareExpr{Op: core.OpLt, Field: "status", Value: core.ValueRef{From: core.SourceLiteral, Literal: core.BoolValue(true)}},
		"undeclared parameter":         eq("status", parameter("undeclared")),
		"principal name other than id": eq("status", core.ValueRef{From: core.SourcePrincipal, Name: "email"}),
		"principal id on a string":     eq("status", core.ValueRef{From: core.SourcePrincipal, Name: "id"}),
		"context without a name":       eq("status", core.ValueRef{From: core.SourceContext}),
		"parameter of another kind":    eq("amount", parameter("kindProbe")),
	}
	for name, expression := range cases {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			source.Templates = append(source.Templates, template("probe", "submission", expression, map[string]core.FieldKind{"kindProbe": core.FieldString}))
			validationFails(t, source)
		})
	}
	ordered := declarations()
	ordered.Resources[0].Fields["active"] = core.FieldType{Kind: core.FieldBoolean}
	ordered.Templates = append(ordered.Templates, template("probe", "submission", core.CompareExpr{
		Op: core.OpLt, Field: "active", Value: core.ValueRef{From: core.SourceLiteral, Literal: core.BoolValue(true)},
	}, nil))
	validationFails(t, ordered)
}

func TestAParameterInARequiredScopeIsRejected(t *testing.T) {
	source := declarations()
	source.Policies[1].RequiredScope = eq("status", parameter("status"))
	validationFails(t, source)
}

func TestDeclarationShapesThatFailValidation(t *testing.T) {
	cases := map[string]func(*core.SystemDeclarations){
		"nil resources":           func(d *core.SystemDeclarations) { d.Resources = nil },
		"nil relations":           func(d *core.SystemDeclarations) { d.Relations = nil },
		"nil policies":            func(d *core.SystemDeclarations) { d.Policies = nil },
		"nil templates":           func(d *core.SystemDeclarations) { d.Templates = nil },
		"nil boundaries":          func(d *core.SystemDeclarations) { d.Boundaries = nil },
		"nil validators":          func(d *core.SystemDeclarations) { d.Capabilities.Validators = nil },
		"nil handlers":            func(d *core.SystemDeclarations) { d.Capabilities.ObligationHandlers = nil },
		"capability without name": func(d *core.SystemDeclarations) { d.Capabilities.Validators = []string{"minimumAssurance"} },
		"capability bad version":  func(d *core.SystemDeclarations) { d.Capabilities.ObligationHandlers = []string{"audit@0"} },
		"resource key":            func(d *core.SystemDeclarations) { d.Resources[0].Key = "Bad" },
		"resource declared twice": func(d *core.SystemDeclarations) { d.Resources = append(d.Resources, d.Resources[0]) },
		"unknown key kind":        func(d *core.SystemDeclarations) { d.Resources[0].KeyKind = "number" },
		"empty key kind":          func(d *core.SystemDeclarations) { d.Resources[0].KeyKind = "" },
		"nil fields":              func(d *core.SystemDeclarations) { d.Resources[0].Fields = nil },
		"nil actions":             func(d *core.SystemDeclarations) { d.Resources[0].Actions = nil },
		"field name": func(d *core.SystemDeclarations) {
			d.Resources[0].Fields["Bad name"] = core.FieldType{Kind: core.FieldString}
		},
		"field kind":  func(d *core.SystemDeclarations) { d.Resources[0].Fields["other"] = core.FieldType{Kind: "money"} },
		"zero field":  func(d *core.SystemDeclarations) { d.Resources[0].Fields["other"] = core.FieldType{} },
		"action name": func(d *core.SystemDeclarations) { d.Resources[1].Actions["Bad name"] = d.Resources[1].Actions["read"] },
		"action without a policy": func(d *core.SystemDeclarations) {
			d.Resources[1].Actions["other"] = core.ActionDeclaration{Boundary: core.BoundaryOptional}
		},
		"action policy version": func(d *core.SystemDeclarations) {
			d.Resources[1].Actions["other"] = core.ActionDeclaration{Policy: core.RelationRef{Key: "baseline"}, Boundary: core.BoundaryOptional}
		},
		"policy declared twice":    func(d *core.SystemDeclarations) { d.Policies = append(d.Policies, d.Policies[0]) },
		"policy key":               func(d *core.SystemDeclarations) { d.Policies[0].Key = "Bad key" },
		"policy version":           func(d *core.SystemDeclarations) { d.Policies[0].Version = -1 },
		"policy lifecycle":         func(d *core.SystemDeclarations) { d.Policies[0].Lifecycle = "paused" },
		"nil policy requirements":  func(d *core.SystemDeclarations) { d.Policies[0].ContextRequirements = nil },
		"nil policy obligations":   func(d *core.SystemDeclarations) { d.Policies[0].Obligations = nil },
		"unregistered validator":   func(d *core.SystemDeclarations) { d.Policies[1].ContextRequirements[0].Validator = "other@1" },
		"nil validator parameters": func(d *core.SystemDeclarations) { d.Policies[1].ContextRequirements[0].Parameters = nil },
		"zero validator parameter": func(d *core.SystemDeclarations) {
			d.Policies[1].ContextRequirements[0].Parameters["minimum"] = core.Scalar{}
		},
		"unregistered obligation": func(d *core.SystemDeclarations) { d.Policies[1].Obligations[0].Handler = "other@1" },
		"template declared twice": func(d *core.SystemDeclarations) { d.Templates = append(d.Templates, d.Templates[0]) },
		"template key":            func(d *core.SystemDeclarations) { d.Templates[0].Key = "Bad key" },
		"template version":        func(d *core.SystemDeclarations) { d.Templates[0].Version = 0 },
		"template resource":       func(d *core.SystemDeclarations) { d.Templates[0].Resource = "invoice" },
		"nil template parameters": func(d *core.SystemDeclarations) { d.Templates[0].Parameters = nil },
		"template parameter name": func(d *core.SystemDeclarations) { d.Templates[0].Parameters["Bad name"] = core.FieldString },
		"template parameter kind": func(d *core.SystemDeclarations) { d.Templates[0].Parameters["limit"] = "money" },
		"limit zero":              func(d *core.SystemDeclarations) { d.Limits.MaxRules = new(0) },
		"limit negative":          func(d *core.SystemDeclarations) { d.Limits.MaxExpressionNodes = new(-1) },
		"limit above the ceiling": func(d *core.SystemDeclarations) { d.Limits.MaxExpressionNodes = new(10001) },
		"path limit above 8":      func(d *core.SystemDeclarations) { d.Limits.MaxPathDepth = new(9) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			source := declarations()
			mutate(&source)
			validationFails(t, source)
		})
	}
	nodes := declarations()
	nodes.Limits.MaxExpressionNodes = new(1)
	nodes.Templates = append(nodes.Templates, template("probe", "submission", core.LogicalExpr{Op: core.OpAnd, Args: []core.Expr{everything, everything}}, nil))
	validationFails(t, nodes)
}
