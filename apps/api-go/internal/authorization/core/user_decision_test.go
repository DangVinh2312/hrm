package core_test

import (
	"testing"

	"hrm/api-go/internal/authorization/core"
)

func recordFacts(amount string) core.CompleteFacts {
	return factsOf(submission("record", "1", map[string]core.FieldValue{"amount": core.TextValue(amount)}))
}

func limitBoundary() *core.ValidatedDeclarations {
	source := declarations()
	source.Boundaries = []core.PermissionBoundary{{
		Key: "limit", Version: 1,
		Entries: []core.BoundaryEntry{{
			Permission:          "submission.read",
			ContextRequirements: []core.ContextRequirement{},
			RequiredScope:       core.CompareExpr{Op: core.OpLte, Field: "amount", Value: literal("20")},
		}},
	}}
	return validated(source)
}

func TestPolicyBoundaryAndDenyShareOneAlgebra(t *testing.T) {
	root := core.RuleSubject{Kind: core.SubjectRole, Role: "system.root"}
	authority := func(rules ...core.RuleFact) core.AuthoritySnapshot {
		return snapshotWith(func(s *core.AuthoritySnapshot) {
			s.Declarations = limitBoundary()
			s.Roles = []string{"system.root"}
			s.Boundaries = []core.BoundaryBindingFact{{
				Identity: alice, Permission: "submission.read",
				Boundary: core.RelationRef{Key: "limit", Version: 1}, Lifecycle: core.LifecycleActive,
			}}
			s.Rules = rules
		})
	}
	allow := read(root, core.EffectAllow, "all@1", nil)
	plan := planned(t, fixtureCore.Plan(input(), authority(allow)))
	if plan.UserID() != alice {
		t.Fatalf("user %q", plan.UserID())
	}
	if !fixtureCore.Evaluate(plan, recordFacts("10.00")).Allowed() {
		t.Error("inside the boundary was denied")
	}
	if fixtureCore.Evaluate(plan, recordFacts("21")).Allowed() {
		t.Error("outside the boundary was allowed")
	}
	missing := recordFacts("10.00")
	delete(missing.Record.Fields, "amount")
	wantReason(t, fixtureCore.Evaluate(plan, missing), "missing_fact")

	denied := planned(t, fixtureCore.Plan(input(), authority(allow, read(personal, core.EffectDeny, "all@1", nil))))
	if fixtureCore.Evaluate(denied, recordFacts("10.00")).Allowed() {
		t.Error("a deny did not win inside the boundary")
	}

	ungranted := planned(t, fixtureCore.Plan(input(), authority()))
	if fixtureCore.Evaluate(ungranted, recordFacts("10.00")).Allowed() {
		t.Error("allowed without a grant")
	}
	exception := core.ExceptionFact{
		ObjectID: "record", Permission: "submission.read", Subject: personal,
		Effect: core.EffectAllow, Purpose: core.PurposeManual, StartsAt: now,
	}
	inside := recordFacts("10.00")
	inside.Exceptions = []core.ExceptionFact{exception}
	if !fixtureCore.Evaluate(ungranted, inside).Allowed() {
		t.Error("a record allow inside the boundary was denied")
	}
	outside := recordFacts("21")
	outside.Exceptions = []core.ExceptionFact{exception}
	if fixtureCore.Evaluate(ungranted, outside).Allowed() {
		t.Error("a record allow passed the boundary")
	}
}

func TestRecordAllowsStayInsidePolicyAndRecordDenyWins(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(approveInput(2), snapshot()))
	allow := core.ExceptionFact{
		ObjectID: "record", Permission: "submission.approve", Subject: personal,
		Effect: core.EffectAllow, Purpose: core.PurposeManual, StartsAt: now,
	}
	complete := recordFacts("10.00")
	complete.Exceptions = []core.ExceptionFact{allow}
	if !fixtureCore.Evaluate(plan, complete).Allowed() {
		t.Fatal("a record allow was denied")
	}
	closed := complete
	closed.Record = submission("record", "1", map[string]core.FieldValue{"status": core.TextValue("closed")})
	if fixtureCore.Evaluate(plan, closed).Allowed() {
		t.Error("a record allow passed the policy scope")
	}
	both := complete
	deny := allow
	deny.Effect = core.EffectDeny
	both.Exceptions = []core.ExceptionFact{allow, deny}
	if fixtureCore.Evaluate(plan, both).Allowed() {
		t.Error("a record deny did not win")
	}
	emergency := complete
	urgent := allow
	urgent.Purpose = core.PurposeEmergency
	emergency.Exceptions = []core.ExceptionFact{urgent}
	if fixtureCore.Evaluate(plan, emergency).Allowed() {
		t.Error("an emergency allow granted")
	}
}

func TestAssigneeRelationChecksVersionExpiryAndPresence(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(personal, core.EffectAllow, "assignedToMe@1", nil)))))
	assigned := core.EdgeFact{
		Source: "record", Relation: core.RelationRef{Key: "submission.assignee", Version: 1},
		Target: identityTarget(alice), StartsAt: now,
	}
	facts := func(edges ...core.EdgeFact) core.CompleteFacts {
		f := recordFacts("10.00")
		f.Edges = edges
		return f
	}
	if !fixtureCore.Evaluate(plan, facts(assigned)).Allowed() {
		t.Error("the assignee was denied")
	}
	if fixtureCore.Evaluate(plan, facts()).Allowed() {
		t.Error("allowed without an edge")
	}
	expired := assigned
	expired.ExpiresAt = ptr(now)
	if fixtureCore.Evaluate(plan, facts(expired)).Allowed() {
		t.Error("an expired edge granted")
	}
	versioned := assigned
	versioned.Relation.Version = 2
	if fixtureCore.Evaluate(plan, facts(versioned)).Allowed() {
		t.Error("another relation version granted")
	}
}

func TestFactsMustIdentifyTheActivePrincipalAndRootHasNoGrantBypass(t *testing.T) {
	for name, user := range map[string]*core.AuthorityUser{
		"absent":    nil,
		"other":     {ID: bob, State: core.UserActive},
		"suspended": {ID: alice, State: core.UserSuspended},
		"pending":   {ID: alice, State: core.UserPending},
		"no state":  {ID: alice},
		"odd state": {ID: alice, State: "active "},
	} {
		t.Run(name, func(t *testing.T) {
			wantReason(t, fixtureCore.Plan(input(), snapshotWith(func(s *core.AuthoritySnapshot) { s.User = user })), "inactive_user")
		})
	}
	root := snapshotWith(func(s *core.AuthoritySnapshot) { s.Roles = []string{"system.root"} })
	plan := planned(t, fixtureCore.Plan(input(), root))
	if fixtureCore.Evaluate(plan, recordFacts("10.00")).Allowed() {
		t.Fatal("the role name system.root created a bypass")
	}
}
