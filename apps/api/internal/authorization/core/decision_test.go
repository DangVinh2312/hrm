package core_test

import (
	"math/rand/v2"
	"reflect"
	"strconv"
	"testing"

	"hrm/api/internal/authorization/core"
)

func exception(effect core.Effect, objectID string, mutate func(*core.ExceptionFact)) core.ExceptionFact {
	fact := core.ExceptionFact{
		ObjectID: objectID, Permission: "submission.read",
		Subject: personal, Effect: effect, Purpose: core.PurposeManual,
		StartsAt: "2026-10-01T00:00:00.000000Z",
	}
	if mutate != nil {
		mutate(&fact)
	}
	return fact
}

const (
	objectOne = "51000000-0000-4000-8000-000000000001"
	objectTwo = "51000000-0000-4000-8000-000000000002"
)

func pendingRecord() core.FactObject {
	return submission(objectOne, "1", map[string]core.FieldValue{"status": core.TextValue("pending")})
}

func approvedRecord() core.FactObject {
	return submission(objectTwo, "2", map[string]core.FieldValue{"status": core.TextValue("approved")})
}

func withExceptions(record core.FactObject, exceptions ...core.ExceptionFact) core.CompleteFacts {
	f := factsOf(record)
	f.Exceptions = exceptions
	return f
}

func recordWith(objectID string, name string, value core.FieldValue) core.FactObject {
	return submission(objectID, "9", map[string]core.FieldValue{name: value})
}

func TestDecisionPrecedence(t *testing.T) {
	inTen := func(x *core.ExceptionFact) {
		x.Purpose = core.PurposeEmergency
		x.ExpiresAt = ptr("2026-10-13T10:10:00.000000Z")
	}
	exact := string(rune(0xc5)) + "ngstr" + string(rune(0xf6)) + "m's \"draft\""
	folded := string(rune(0xe5)) + "ngstr" + string(rune(0xf6)) + "m's \"draft\""
	allowAll := read(reviewer, core.EffectAllow, "all@1", nil)
	pendingOnly := read(reviewer, core.EffectAllow, "statusIs@1", text("status", "pending"))
	cases := []struct {
		name     string
		snapshot func(*core.AuthoritySnapshot)
		facts    core.CompleteFacts
		want     bool
	}{
		{"role grant matches", withRules(pendingOnly), factsOf(pendingRecord()), true},
		{"role grant scope does not match", withRules(pendingOnly), factsOf(approvedRecord()), false},
		{"inactive user even with record allow", func(s *core.AuthoritySnapshot) {
			s.User = &core.AuthorityUser{ID: alice, State: core.UserSuspended}
			s.Rules = []core.RuleFact{allowAll}
		}, withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, nil)), false},
		{"user of another identity", func(s *core.AuthoritySnapshot) {
			s.User = &core.AuthorityUser{ID: bob, State: core.UserActive}
			s.Rules = []core.RuleFact{allowAll}
		}, factsOf(pendingRecord()), false},
		{"empty grant", nil, factsOf(pendingRecord()), false},
		{"role allow + personal deny", withRules(allowAll, read(personal, core.EffectDeny, "all@1", nil)), factsOf(pendingRecord()), false},
		{
			"personal allow + role deny",
			withRules(read(personal, core.EffectAllow, "all@1", nil), read(reviewer, core.EffectDeny, "statusIs@1", text("status", "pending"))),
			factsOf(pendingRecord()), false,
		},
		{
			"role deny outside its scope leaves allow",
			withRules(read(personal, core.EffectAllow, "all@1", nil), read(reviewer, core.EffectDeny, "statusIs@1", text("status", "pending"))),
			factsOf(approvedRecord()), true,
		},
		{
			"rule for an unassigned role is ignored",
			withRules(read(core.RuleSubject{Kind: core.SubjectRole, Role: "manager"}, core.EffectAllow, "all@1", nil)),
			factsOf(pendingRecord()), false,
		},
		{"record allow outside grant scope", withRules(pendingOnly), withExceptions(approvedRecord(), exception(core.EffectAllow, objectTwo, nil)), true},
		{"record deny wins over role allow", withRules(allowAll), withExceptions(pendingRecord(), exception(core.EffectDeny, objectOne, nil)), false},
		{"record deny wins over record allow of another subject", nil, withExceptions(pendingRecord(),
			exception(core.EffectAllow, objectOne, nil),
			exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) { x.Subject = reviewer })), false},
		{"emergency record allow never grants", nil, withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, inTen)), false},
		{"emergency record deny still denies", withRules(allowAll), withExceptions(pendingRecord(), exception(core.EffectDeny, objectOne, inTen)), false},
		{"expired record allow", nil, withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.ExpiresAt = ptr(now)
		})), false},
		{"record allow not started", nil, withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.StartsAt = later
		})), false},
		{"revoked record allow", nil, withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.RevokedAt = ptr("2026-10-02T00:00:00.000000Z")
		})), false},
		{"role record allow after role removed", func(s *core.AuthoritySnapshot) { s.Roles = []string{} }, withExceptions(pendingRecord(),
			exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) { x.Subject = reviewer })), false},
		{"record allow on another object", nil, withExceptions(pendingRecord(), exception(core.EffectAllow, objectTwo, nil)), false},
		{"record allow for another permission", nil, withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.Permission = "submission.approve"
		})), false},
		{"record allow of another identity", nil, withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, func(x *core.ExceptionFact) {
			x.Subject = core.RuleSubject{Kind: core.SubjectIdentity, Identity: bob}
		})), false},
		{"null field never matches a grant", withRules(read(reviewer, core.EffectAllow, "priorityBelow@1", text("limit", "5"))), factsOf(pendingRecord()), false},
		{
			"a null comparison is false, not an error, so a record allow still applies",
			withRules(read(reviewer, core.EffectAllow, "priorityBelow@1", text("limit", "5"))),
			withExceptions(pendingRecord(), exception(core.EffectAllow, objectOne, nil)), true,
		},
		{
			"explicit null branch grants", withRules(read(reviewer, core.EffectAllow, "untitled@1", nil)),
			factsOf(recordWith(objectOne, "title", core.NullValue())), true,
		},
		{
			"exact decimal comparison", withRules(read(reviewer, core.EffectAllow, "amountAtMost@1", text("limit", "10.000"))),
			factsOf(recordWith(objectOne, "amount", core.TextValue("10.0001"))), false,
		},
		{
			"decimal equal at different scale", withRules(read(reviewer, core.EffectAllow, "amountAtMost@1", text("limit", "10.000"))),
			factsOf(recordWith(objectOne, "amount", core.TextValue("10"))), true,
		},
		{
			"integer lt is strict", withRules(read(reviewer, core.EffectAllow, "priorityBelow@1", text("limit", "5"))),
			factsOf(recordWith(objectOne, "priority", core.TextValue("5"))), false,
		},
		{
			"integer lt above 2^53 stays exact", withRules(read(reviewer, core.EffectAllow, "priorityBelow@1", text("limit", "9007199254740993"))),
			factsOf(recordWith(objectOne, "priority", core.TextValue("9007199254740992"))), true,
		},
		{
			"string equality is exact (Unicode, quotes, case)", withRules(read(reviewer, core.EffectAllow, "titleIs@1", text("title", exact))),
			factsOf(recordWith(objectOne, "title", core.TextValue(folded))), false,
		},
		{
			"string equality matches identical Unicode", withRules(read(reviewer, core.EffectAllow, "titleIs@1", text("title", exact))),
			factsOf(recordWith(objectOne, "title", core.TextValue(exact))), true,
		},
		{"plan expired before evaluation", withRules(allowAll), func() core.CompleteFacts {
			f := factsOf(pendingRecord())
			f.Now = "2026-10-13T10:00:05.000000Z"
			return f
		}(), false},
		{"plan expires exactly at validUntil", withRules(allowAll), func() core.CompleteFacts {
			f := factsOf(pendingRecord())
			f.Now = later
			return f
		}(), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := decide(fixtureCore, input(), snapshotWith(c.snapshot), c.facts); got != c.want {
				t.Fatalf("allowed = %v, want %v", got, c.want)
			}
		})
	}
}

func TestAListDecisionIsAPredicateNotAllowAll(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(reviewer, core.EffectAllow, "statusIs@1", text("status", "pending"))))))
	if _, constant := plan.Predicate().(core.PlanConstant); constant {
		t.Fatal("the predicate folded to a constant")
	}
	if fixtureCore.Evaluate(plan, factsOf(approvedRecord())).Allowed() {
		t.Fatal("a record outside the scope was allowed")
	}
}

func TestUnknownOrBrokenFactsDenyTheWholePlan(t *testing.T) {
	allowAll := read(reviewer, core.EffectAllow, "all@1", nil)
	unknownResource, unknownAction := input(), input()
	unknownResource.Resource = "invoice"
	unknownAction.Action = "export"
	cases := []struct {
		name     string
		input    core.TrustedInput
		snapshot func(*core.AuthoritySnapshot)
		reason   string
	}{
		{"unknown resource", unknownResource, nil, "unknown_resource"},
		{"unknown action", unknownAction, nil, "unknown_action"},
		{"unknown template", input(), withRules(read(reviewer, core.EffectAllow, "nope@1", nil)), "unknown_template"},
		{"unknown template version", input(), withRules(read(reviewer, core.EffectAllow, "all@2", nil)), "unknown_template"},
		{"missing rule parameter", input(), withRules(read(reviewer, core.EffectAllow, "statusIs@1", nil)), "rule_parameters_mismatch"},
		{"extra rule parameter", input(), withRules(read(reviewer, core.EffectAllow, "all@1", text("x", "y"))), "rule_parameters_mismatch"},
		{"other rule parameter name", input(), withRules(read(reviewer, core.EffectAllow, "statusIs@1", text("state", "x"))), "rule_parameters_mismatch"},
		{
			"boolean for a string parameter", input(),
			withRules(read(reviewer, core.EffectAllow, "statusIs@1", map[string]core.Scalar{"status": core.Bool(true)})), "unresolved_value:parameter",
		},
		{
			"exponent for a decimal parameter", input(),
			withRules(read(reviewer, core.EffectAllow, "amountAtMost@1", text("limit", "1e3"))), "unresolved_value:parameter",
		},
		{
			"zero scalar for a parameter", input(),
			withRules(read(reviewer, core.EffectAllow, "statusIs@1", map[string]core.Scalar{"status": {}})), "unresolved_value:parameter",
		},
		{"permission absent from catalog", input(), func(s *core.AuthoritySnapshot) { s.Permissions = nil }, "permission_not_in_catalog"},
		{"broken deny rule", input(), withRules(allowAll, read(personal, core.EffectDeny, "missing@1", nil)), "unknown_template"},
		{
			"deny rule comparing a nullable field without a null branch", input(),
			withRules(allowAll, read(personal, core.EffectDeny, "priorityBelow@1", text("limit", "3"))), "unsafe_deny_template",
		},
		{"unknown effect", input(), func(s *core.AuthoritySnapshot) {
			broken := allowAll
			broken.Effect = "maybe"
			s.Rules = []core.RuleFact{broken}
		}, "unknown_effect"},
		{"empty effect", input(), func(s *core.AuthoritySnapshot) {
			broken := allowAll
			broken.Effect = ""
			s.Rules = []core.RuleFact{broken}
		}, "unknown_effect"},
		{"unknown rule subject is not skipped, it could be a deny", input(), func(s *core.AuthoritySnapshot) {
			broken := read(core.RuleSubject{Kind: "group", Identity: alice}, core.EffectDeny, "all@1", nil)
			s.Rules = []core.RuleFact{allowAll, broken}
		}, "unknown_subject"},
		{"empty rule subject", input(), func(s *core.AuthoritySnapshot) {
			s.Rules = []core.RuleFact{read(core.RuleSubject{}, core.EffectDeny, "all@1", nil)}
		}, "unknown_subject"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			wantReason(t, fixtureCore.Plan(c.input, snapshotWith(c.snapshot)), c.reason)
		})
	}
}

func TestDeclarationsThatWereNotValidatedAreRefused(t *testing.T) {
	foreign := *validated(declarations())
	for name, d := range map[string]*core.ValidatedDeclarations{
		"nil": nil, "zero": {}, "structural copy": &foreign,
	} {
		t.Run(name, func(t *testing.T) {
			s := snapshot()
			s.Declarations = d
			wantReason(t, fixtureCore.Plan(input(), s), "unvalidated_declarations")
		})
	}
}

func TestRuleCountAboveTheManifestLimitDeniesInsteadOfTruncating(t *testing.T) {
	source := declarations()
	source.Limits.MaxRules = new(2)
	rules := []core.RuleFact{
		read(reviewer, core.EffectAllow, "all@1", nil),
		read(reviewer, core.EffectAllow, "all@1", nil),
		read(personal, core.EffectDeny, "all@1", nil),
	}
	s := snapshotWith(withRules(rules...))
	s.Declarations = validated(source)
	wantReason(t, fixtureCore.Plan(input(), s), "too_many_rules")
	s.Rules = rules[:2]
	planned(t, fixtureCore.Plan(input(), s))
}

func TestMalformedFieldFactsDeny(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(reviewer, core.EffectAllow, "priorityBelow@1", text("limit", "5"))))))
	for name, c := range map[string]struct {
		facts  core.CompleteFacts
		reason string
	}{
		"boolean in an integer field": {factsOf(recordWith(objectOne, "priority", core.BoolValue(true))), "invalid_integer_fact"},
		"exponent in an integer":      {factsOf(recordWith(objectOne, "priority", core.TextValue("1e3"))), "invalid_integer_fact"},
		"zero value is not NULL":      {factsOf(recordWith(objectOne, "priority", core.FieldValue{})), "invalid_integer_fact"},
		"missing field": {func() core.CompleteFacts {
			record := pendingRecord()
			delete(record.Fields, "priority")
			return factsOf(record)
		}(), "missing_fact"},
		"invalid now": {func() core.CompleteFacts {
			f := factsOf(pendingRecord())
			f.Now = "2026-10-13T24:00:00Z"
			return f
		}(), "invalid_now"},
		"other resource": {func() core.CompleteFacts {
			f := factsOf(pendingRecord())
			f.Record.Type = "site"
			return f
		}(), "resource_mismatch"},
	} {
		t.Run(name, func(t *testing.T) { wantReason(t, fixtureCore.Evaluate(plan, c.facts), c.reason) })
	}
}

func TestIsNullOnAMalformedFactDeniesInsteadOfNotMatching(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(
		read(reviewer, core.EffectAllow, "all@1", nil),
		read(personal, core.EffectDeny, "untitled@1", nil),
	))))
	if !fixtureCore.Evaluate(plan, factsOf(pendingRecord())).Allowed() {
		t.Fatal("a titled record is denied")
	}
	if fixtureCore.Evaluate(plan, factsOf(recordWith(objectOne, "title", core.NullValue()))).Allowed() {
		t.Fatal("the deny on a NULL title did not apply")
	}
	wantReason(t, fixtureCore.Evaluate(plan, factsOf(recordWith(objectOne, "title", core.FieldValue{}))), "invalid_fact")
}

func TestMalformedExceptionFactsDenyInsteadOfBeingSkipped(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(read(reviewer, core.EffectAllow, "all@1", nil)))))
	for name, c := range map[string]struct {
		fact   core.ExceptionFact
		reason string
	}{
		"unknown effect":  {exception("maybe", objectOne, nil), "invalid_exception"},
		"empty effect":    {exception("", objectOne, nil), "invalid_exception"},
		"unknown subject": {exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) { x.Subject = core.RuleSubject{Kind: "group"} }), "invalid_exception"},
		"invalid start":   {exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) { x.StartsAt = "2026-02-30T00:00:00Z" }), "invalid_time"},
		"invalid expiry":  {exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) { x.ExpiresAt = ptr("soon") }), "invalid_time"},
		"invalid start behind a past expiry": {exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) {
			x.StartsAt, x.ExpiresAt = "nope", ptr("2026-10-13T09:00:00.000000Z")
		}), "invalid_time"},
		"start at hour 24 behind a past expiry": {exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) {
			x.StartsAt, x.ExpiresAt = "2026-01-01T24:00:00Z", ptr("2026-10-13T09:00:00.000000Z")
		}), "invalid_time"},
		"invalid expiry behind a future start": {exception(core.EffectDeny, objectOne, func(x *core.ExceptionFact) {
			x.StartsAt, x.ExpiresAt = "2026-10-14T00:00:00.000000Z", ptr("soon")
		}), "invalid_time"},
	} {
		t.Run(name, func(t *testing.T) {
			wantReason(t, fixtureCore.Evaluate(plan, withExceptions(pendingRecord(), c.fact)), c.reason)
		})
	}
}

func TestRulesOfAnotherPermissionOrIdentityDoNotApply(t *testing.T) {
	bobSubject := core.RuleSubject{Kind: core.SubjectIdentity, Identity: bob}
	allowAll := read(reviewer, core.EffectAllow, "all@1", nil)
	for name, rule := range map[string]core.RuleFact{
		"allow of another permission": rule("submission.approve", reviewer, core.EffectAllow, "all@1", nil),
		"allow of another identity":   read(bobSubject, core.EffectAllow, "all@1", nil),
	} {
		t.Run(name, func(t *testing.T) {
			plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(rule))))
			wantReason(t, fixtureCore.Evaluate(plan, factsOf(pendingRecord())), "predicate_false")
		})
	}
	for name, rule := range map[string]core.RuleFact{
		"deny of another permission": rule("submission.approve", reviewer, core.EffectDeny, "all@1", nil),
		"deny of another identity":   read(bobSubject, core.EffectDeny, "all@1", nil),
	} {
		t.Run(name, func(t *testing.T) {
			plan := planned(t, fixtureCore.Plan(input(), snapshotWith(withRules(allowAll, rule))))
			if !fixtureCore.Evaluate(plan, factsOf(pendingRecord())).Allowed() {
				t.Fatal("the rule applied to this decision")
			}
		})
	}
}

func TestATemplateOfAnotherResourceDeniesThePlan(t *testing.T) {
	source := declarations()
	source.Templates = append(source.Templates, template("siteAll", "site", everything, nil))
	s := snapshotWith(withRules(read(reviewer, core.EffectAllow, "siteAll@1", nil)))
	s.Declarations = validated(source)
	wantReason(t, fixtureCore.Plan(input(), s), "template_resource_mismatch")
}

func TestPlanExceptionRolesAreNeverNil(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), snapshotWith(func(s *core.AuthoritySnapshot) { s.Roles = nil })))
	var walk func(core.PlanExpr)
	found := 0
	walk = func(node core.PlanExpr) {
		switch n := node.(type) {
		case core.PlanLogical:
			for _, arg := range n.Args {
				walk(arg)
			}
		case core.PlanNot:
			walk(n.Arg)
		case core.PlanException:
			found++
			if n.Roles == nil || len(n.Roles) != 0 {
				t.Errorf("%s roles %#v", n.Effect, n.Roles)
			}
		}
	}
	walk(plan.Predicate())
	if found != 2 {
		t.Fatalf("found %d exception nodes", found)
	}
}

func TestPlanningDoesNotChangeItsInputs(t *testing.T) {
	s := snapshotWith(func(s *core.AuthoritySnapshot) {
		s.Roles = []string{"z", "reviewer", "a", "reviewer"}
		s.Rules = []core.RuleFact{read(reviewer, core.EffectAllow, "statusIs@1", text("status", "pending"))}
	})
	i := input()
	i.Context = map[string]core.Scalar{"k": core.Text("v")}
	wantRoles, wantRules, wantContext := []string{"z", "reviewer", "a", "reviewer"}, s.Rules[0], map[string]core.Scalar{"k": core.Text("v")}
	planned(t, fixtureCore.Plan(i, s))
	if !reflect.DeepEqual(s.Roles, wantRoles) {
		t.Errorf("roles became %v", s.Roles)
	}
	if !reflect.DeepEqual(s.Rules[0], wantRules) {
		t.Errorf("rule became %#v", s.Rules[0])
	}
	if !reflect.DeepEqual(i.Context, wantContext) {
		t.Errorf("context became %#v", i.Context)
	}
}

func TestAddingADenyNeverEnlargesTheAllowedSet(t *testing.T) {
	random := rand.New(rand.NewPCG(20261013, 0))
	templates := []struct {
		ref        string
		parameters map[string]core.Scalar
	}{
		{"all@1", nil},
		{"statusIs@1", text("status", "pending")},
		{"statusIs@1", text("status", "approved")},
		{"amountAtMost@1", text("limit", "50.5")},
		{"untitled@1", nil},
	}
	subjects := []core.RuleSubject{reviewer, personal, {Kind: core.SubjectRole, Role: "manager"}}
	statuses, amounts := []string{"pending", "approved"}, []string{"10", "50.50", "50.51", "99"}
	titles := []core.FieldValue{core.NullValue(), core.TextValue("x")}
	allowedRounds, narrowed := 0, 0
	for round := range 300 {
		effect := func() core.Effect {
			if random.Float64() < 0.3 {
				return core.EffectDeny
			}
			return core.EffectAllow
		}
		rules := make([]core.RuleFact, 1+random.IntN(4))
		for i := range rules {
			chosen := templates[random.IntN(len(templates))]
			rules[i] = read(subjects[random.IntN(len(subjects))], effect(), chosen.ref, chosen.parameters)
		}
		record := submission(objectOne, strconv.Itoa(round), map[string]core.FieldValue{
			"status": core.TextValue(statuses[random.IntN(2)]),
			"amount": core.TextValue(amounts[random.IntN(4)]),
			"title":  titles[random.IntN(2)],
		})
		f := factsOf(record)
		if random.Float64() < 0.3 {
			fact := core.EffectAllow
			if random.Float64() < 0.5 {
				fact = core.EffectDeny
			}
			f.Exceptions = []core.ExceptionFact{exception(fact, objectOne, nil)}
		}
		base := decide(fixtureCore, input(), snapshotWith(withRules(rules...)), f)
		chosen := templates[random.IntN(len(templates))]
		extra := read(subjects[random.IntN(len(subjects))], core.EffectDeny, chosen.ref, chosen.parameters)
		denied := decide(fixtureCore, input(), snapshotWith(withRules(append(rules, extra)...)), f)
		if !base && denied {
			t.Fatalf("round %d: a deny enlarged the allowed set", round)
		}
		if base {
			allowedRounds++
			if !denied {
				narrowed++
			}
		}
	}
	if allowedRounds == 0 || narrowed == 0 {
		t.Fatalf("the property saw allowed=%d narrowed=%d", allowedRounds, narrowed)
	}
}
