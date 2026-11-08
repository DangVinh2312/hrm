package core_test

import (
	"testing"

	"hrm/api-go/internal/authorization/core"
)

// Every loop over facts must skip a fact that does not apply and look at the next one. Each case puts such
// a fact before the one that decides, so a loop that stops early loses that decision.

func TestARuleOfAnotherPermissionBeforeADenyDoesNotHideIt(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(
		read(reviewer, core.EffectAllow, "all@1", nil),
		rule("submission.approve", personal, core.EffectDeny, "all@1", nil),
		read(personal, core.EffectDeny, "all@1", nil),
	))))
	wantReason(t, fixtureCore.Evaluate(plan, factsOf(pendingRecord())), "predicate_false")
}

func TestABindingOfSomeoneElseBeforeMineDoesNotHideIt(t *testing.T) {
	others := map[string]core.BoundaryBindingFact{
		"another identity": func() core.BoundaryBindingFact {
			fact := binding("customer.export", "regionalExport", 1)
			fact.Identity = bob
			return fact
		}(),
		"another permission": binding("contract.approve", "approvalAmount", 1),
	}
	for name, other := range others {
		t.Run(name, func(t *testing.T) {
			s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
				s.Rules = []core.RuleFact{grant("customer.export", "allCustomers")}
				s.Boundaries = []core.BoundaryBindingFact{other, binding("customer.export", "regionalExport", 1)}
			})
			if !boundaryDecide(exportInput(), s, customer("north")) {
				t.Fatal("inside my boundary was denied")
			}
			if boundaryDecide(exportInput(), s, customer("south")) {
				t.Fatal("my boundary was not applied")
			}
		})
	}
}

func TestAnExceptionThatDoesNotApplyBeforeAnActiveDenyDoesNotHideIt(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(reviewer, core.EffectAllow, "all@1", nil)))))
	active := exception(core.EffectDeny, objectOne, nil)
	before := map[string]core.ExceptionFact{
		"deny on another object": exception(core.EffectDeny, objectTwo, nil),
		"deny of another permission": exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) {
			x.Permission = "submission.approve"
		}),
		"deny of another subject": exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) {
			x.Subject = core.RuleSubject{Kind: core.SubjectIdentity, Identity: bob}
		}),
		"revoked deny": exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) {
			x.RevokedAt = ptr("2026-10-02T00:00:00.000000Z")
		}),
		"emergency allow": exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.Purpose, x.ExpiresAt = core.PurposeEmergency, ptr("2026-10-13T10:10:00.000000Z")
		}),
		"deny not yet active": exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) { x.StartsAt = later }),
		"expired deny":        exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) { x.ExpiresAt = ptr(now) }),
	}
	for name, fact := range before {
		t.Run(name, func(t *testing.T) {
			wantReason(t, fixtureCore.Evaluate(plan, withExceptions(pendingRecord(), fact, active)), "predicate_false")
		})
	}
}

func TestAnExceptionThatDoesNotApplyBeforeAnActiveAllowDoesNotHideIt(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshot()))
	active := exception(core.EffectAllow, objectOne, nil)
	before := map[string]core.ExceptionFact{
		"emergency allow": exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.Purpose, x.ExpiresAt = core.PurposeEmergency, ptr("2026-10-13T10:10:00.000000Z")
		}),
		"allow not yet active": exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) { x.StartsAt = later }),
		"allow of another subject": exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.Subject = core.RuleSubject{Kind: core.SubjectIdentity, Identity: bob}
		}),
	}
	for name, fact := range before {
		t.Run(name, func(t *testing.T) {
			if !fixtureCore.Evaluate(plan, withExceptions(pendingRecord(), fact, active)).Allowed() {
				t.Fatal("the active allow behind it was lost")
			}
		})
	}
}

func TestAnEdgeThatDoesNotApplyBeforeTheMatchingOneDoesNotHideADeny(t *testing.T) {
	const siteB = "54000000-0000-4000-8000-0000000000b2"
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

	other := siteA()
	other.ObjectID, other.Fields = siteB, map[string]core.FieldValue{"name": core.TextValue("Site B")}
	before := map[string]core.EdgeFact{
		"expired edge": submissionSite(func(e *core.EdgeFact) { e.ExpiresAt = ptr(now) }),
		"edge to an object absent from the facts": edge("submission.site", relationRecord,
			objectTarget("54000000-0000-4000-8000-0000000000ff"), nil),
		"edge to a site whose where is false": edge("submission.site", relationRecord, objectTarget(siteB), nil),
		"edge from another source":            edge("submission.site", siteB, objectTarget(siteObject), nil),
		"edge of another relation version":    submissionSite(func(e *core.EdgeFact) { e.Relation.Version = 2 }),
	}
	for name, first := range before {
		t.Run(name, func(t *testing.T) {
			f := graph(first, submissionSite(nil))
			f.Objects = []core.FactObject{relationSubmission(), siteA(), other}
			wantReason(t, fixtureCore.Evaluate(plan, f), "predicate_false")
		})
	}
}
