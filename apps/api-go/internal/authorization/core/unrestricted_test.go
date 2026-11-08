package core_test

import (
	"reflect"
	"testing"

	"hrm/api-go/internal/authorization/core"
)

func closedRecord() core.CompleteFacts {
	record := submission("record", "1", map[string]core.FieldValue{
		"amount": core.TextValue("999.00"), "status": core.TextValue("closed"),
	})
	return core.CompleteFacts{Now: "2026-10-13T10:00:01.000000Z", Record: record, Objects: []core.FactObject{record}}
}

func TestUnrestrictedPlanSharesTheTargetAndBypassesGrantsDenyAndScope(t *testing.T) {
	i := approveInput(2)
	plan := planned(t, fixtureCore.PlanUnrestricted(i, snapshotWith(func(s *core.AuthoritySnapshot) {
		s.Roles = []string{}
		s.Rules = []core.RuleFact{rule("submission.approve", personal, core.EffectDeny, "all@1", nil)}
	})))
	if !reflect.DeepEqual(plan.Predicate(), core.PlanExpr(core.PlanConstant{Value: true})) {
		t.Fatalf("predicate %#v", plan.Predicate())
	}
	if len(plan.Obligations()) != 0 {
		t.Fatalf("obligations %#v", plan.Obligations())
	}
	if plan.UserID() != alice || plan.Resource() != "submission" || plan.Action() != "approve" ||
		plan.Permission() != "submission.approve" || plan.Revision() != "7" {
		t.Fatalf("plan %#v", plan)
	}
	user := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(reviewer, core.EffectAllow, "all@1", nil)))))
	unrestricted := planned(t, fixtureCore.PlanUnrestricted(input(), snapshot()))
	if unrestricted.Resource() != user.Resource() || unrestricted.Action() != user.Action() ||
		unrestricted.Permission() != user.Permission() || unrestricted.ValidUntil() != user.ValidUntil() {
		t.Fatalf("user %#v, unrestricted %#v", user, unrestricted)
	}
	if !fixtureCore.Evaluate(unrestricted, closedRecord()).Allowed() {
		t.Fatal("the evaluator refused an unrestricted plan")
	}
}

func TestPlanNeverGrantsWhatPlanUnrestrictedDoes(t *testing.T) {
	root := snapshotWith(func(s *core.AuthoritySnapshot) { s.Roles = []string{"system.root"} })
	plan := planned(t, fixtureCore.Plan(input(), root))
	if fixtureCore.Evaluate(plan, closedRecord()).Allowed() {
		t.Fatal("a role name created a bypass")
	}
}

func TestUnrestrictedPlanFailsClosed(t *testing.T) {
	upper := input()
	upper.Principal.ID = core.IdentityID("A0000000-0000-4000-8000-000000000001")
	unknownResource, unknownAction, badNow, badUntil, sameInstant, reversed := input(), input(), input(), input(), input(), input()
	unknownResource.Resource = "missing"
	unknownAction.Action = "delete"
	badNow.Now = "not-a-time"
	badUntil.ValidUntil = "2026-10-13T24:00:00Z"
	sameInstant.ValidUntil = sameInstant.Now
	reversed.Now, reversed.ValidUntil = later, now
	cases := []struct {
		reason   string
		input    core.TrustedInput
		snapshot func(*core.AuthoritySnapshot)
	}{
		{"unknown_resource", unknownResource, nil},
		{"unknown_action", unknownAction, nil},
		{"invalid_principal", upper, nil},
		{"inactive_user", input(), func(s *core.AuthoritySnapshot) { s.User = &core.AuthorityUser{ID: alice, State: core.UserSuspended} }},
		{"inactive_user", input(), func(s *core.AuthoritySnapshot) { s.User = nil }},
		{"invalid_now", badNow, nil},
		{"invalid_valid_until", badUntil, nil},
		{"invalid_validity_window", sameInstant, nil},
		{"invalid_validity_window", reversed, nil},
		{"permission_not_in_catalog", input(), func(s *core.AuthoritySnapshot) { s.Permissions = nil }},
	}
	for _, revision := range []string{"", "0", "-1", "07", "x", "9223372036854775808"} {
		cases = append(cases, struct {
			reason   string
			input    core.TrustedInput
			snapshot func(*core.AuthoritySnapshot)
		}{"invalid_revision", input(), func(s *core.AuthoritySnapshot) { s.Revision = revision }})
	}
	for _, c := range cases {
		wantReason(t, fixtureCore.PlanUnrestricted(c.input, snapshotWith(c.snapshot)), c.reason)
	}
	other := newCore()
	wantReason(t, other.PlanUnrestricted(input(), snapshot()), "unvalidated_declarations")
	plan := planned(t, fixtureCore.PlanUnrestricted(input(), snapshot()))
	wantReason(t, other.Evaluate(plan, closedRecord()), "foreign_plan")
}

// freshPolicy returns declarations with a `close` action bound to a policy that requires a fresh
// session, like the product's fresh@1.
func freshPolicy() (core.SystemDeclarations, func(func(*core.AuthoritySnapshot)) core.AuthoritySnapshot) {
	stepUp := core.RelationRef{Key: "stepUp", Version: 1}
	source := declarations()
	source.Resources[0].Actions["close"] = core.ActionDeclaration{Policy: stepUp, Boundary: core.BoundaryOptional}
	source.Policies = append(source.Policies, core.PermissionPolicy{
		Key: "stepUp", Version: 1,
		ContextRequirements: []core.ContextRequirement{{Validator: "fresh@1", Parameters: map[string]core.Scalar{}}},
		RequiredScope:       eq("status", literal("open")),
		Obligations:         []core.Obligation{},
	})
	source.Capabilities.Validators = []string{"minimumAssurance@1", "fresh@1"}
	build := func(mutate func(*core.AuthoritySnapshot)) core.AuthoritySnapshot {
		s := snapshot()
		s.Declarations = validated(source)
		s.Permissions = append(s.Permissions, catalogRow("submission.close", stepUp, core.BoundaryOptional))
		s.Registry.Validators["fresh@1"] = func(_ map[string]core.Scalar, in core.ValidatorInput) core.ValidatorResult {
			if fresh, ok := in.Context["freshAuthentication"].AsBool(); ok && fresh {
				return core.ValidatorTrue
			}
			return core.ValidatorFalse
		}
		if mutate != nil {
			mutate(&s)
		}
		return s
	}
	return source, build
}

func closeInput(context map[string]core.Scalar) core.TrustedInput {
	i := input()
	i.Action = "close"
	i.Context = context
	return i
}

func TestUnrestrictedPlanEnforcesTheActionPolicyContextRequirement(t *testing.T) {
	_, build := freshPolicy()
	fresh := func(value bool) map[string]core.Scalar {
		return map[string]core.Scalar{"freshAuthentication": core.Bool(value)}
	}
	wantReason(t, fixtureCore.PlanUnrestricted(closeInput(fresh(false)), build(nil)), "context_requirement_failed")
	wantReason(t, fixtureCore.PlanUnrestricted(closeInput(nil), build(nil)), "context_requirement_failed")
	plan := planned(t, fixtureCore.PlanUnrestricted(closeInput(fresh(true)), build(nil)))
	if !reflect.DeepEqual(plan.Predicate(), core.PlanExpr(core.PlanConstant{Value: true})) {
		t.Fatalf("predicate %#v", plan.Predicate())
	}
	if plan.Permission() != "submission.close" {
		t.Fatalf("permission %q", plan.Permission())
	}
	for _, context := range []map[string]core.Scalar{{}, fresh(false)} {
		i := input()
		i.Context = context
		planned(t, fixtureCore.PlanUnrestricted(i, build(nil)))
	}
}

func TestUnrestrictedPlanFailsClosedOnThePolicyBindingAndValidatorOutcome(t *testing.T) {
	source, build := freshPolicy()
	rebind := func(change func(*core.PermissionFact)) func(*core.AuthoritySnapshot) {
		return func(s *core.AuthoritySnapshot) {
			for i := range s.Permissions {
				if s.Permissions[i].Key == "submission.close" {
					change(&s.Permissions[i])
				}
			}
		}
	}
	validator := func(v core.ContextValidator) func(*core.AuthoritySnapshot) {
		return func(s *core.AuthoritySnapshot) {
			s.Registry.Validators = map[string]core.ContextValidator{"fresh@1": v}
		}
	}
	answer := func(result core.ValidatorResult) core.ContextValidator {
		return func(map[string]core.Scalar, core.ValidatorInput) core.ValidatorResult { return result }
	}
	cases := []struct {
		reason string
		mutate func(*core.AuthoritySnapshot)
	}{
		{"policy_binding_mismatch", rebind(func(p *core.PermissionFact) { p.Policy = core.RelationRef{Key: "baseline", Version: 1} })},
		{"policy_binding_mismatch", rebind(func(p *core.PermissionFact) { p.Policy.Version = 2 })},
		{"permission_unavailable", rebind(func(p *core.PermissionFact) { p.Lifecycle = core.LifecycleRetired })},
		{"validator_unavailable", func(s *core.AuthoritySnapshot) { s.Registry.Validators = nil }},
		{"context_requirement_failed", validator(answer(core.ValidatorUnknown))},
		{"context_requirement_failed", validator(answer(core.ValidatorFalse))},
		{"validator_failed", validator(func(map[string]core.Scalar, core.ValidatorInput) core.ValidatorResult { panic("fact source down") })},
	}
	fresh := map[string]core.Scalar{"freshAuthentication": core.Bool(true)}
	for _, c := range cases {
		wantReason(t, fixtureCore.PlanUnrestricted(closeInput(fresh), build(c.mutate)), c.reason)
	}
	retired := source
	retired.Policies = append([]core.PermissionPolicy{}, source.Policies...)
	retired.Policies[len(retired.Policies)-1].Lifecycle = core.LifecycleRetired
	validationFails(t, retired)
}

func TestUnrestrictedPlanIgnoresBoundaryEntryRequirementsAndPlanStillAppliesThem(t *testing.T) {
	gated := declarations()
	gated.Boundaries = []core.PermissionBoundary{{
		Key: "gate", Version: 1,
		Entries: []core.BoundaryEntry{{
			Permission: "submission.read", ContextRequirements: []core.ContextRequirement{minimumAssurance("3")}, RequiredScope: everything,
		}},
	}}
	s := snapshotWith(func(s *core.AuthoritySnapshot) {
		s.Declarations = validated(gated)
		s.Boundaries = []core.BoundaryBindingFact{{
			Identity: alice, Permission: "submission.read", Boundary: core.RelationRef{Key: "gate", Version: 1}, Lifecycle: core.LifecycleActive,
		}}
	})
	wantReason(t, fixtureCore.Plan(input(), s), "context_requirement_failed")
	planned(t, fixtureCore.PlanUnrestricted(input(), s))
}
