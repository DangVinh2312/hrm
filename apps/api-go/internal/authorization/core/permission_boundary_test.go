package core_test

import (
	"fmt"
	"math/rand/v2"
	"strconv"
	"testing"

	"hrm/api-go/internal/authorization/core"
)

// Permission boundary. Three application fixtures (role assignment, amount approval, regional
// export) share one core; names are fixture data.

var (
	boundaryBaseline = core.RelationRef{Key: "baseline", Version: 1}
	adminSubject     = core.RuleSubject{Kind: core.SubjectRole, Role: "admin"}
)

func anyOf(field string, options ...string) core.Expr {
	args := make([]core.Expr, len(options))
	for i, option := range options {
		args[i] = eq(field, literal(option))
	}
	return core.LogicalExpr{Op: core.OpOr, Args: args}
}

func assignOperationalRoles() core.PermissionBoundary {
	return core.PermissionBoundary{
		Key: "assignOperationalRoles", Version: 1,
		Entries: []core.BoundaryEntry{{
			Permission: "applicationRole.assign", ContextRequirements: []core.ContextRequirement{},
			RequiredScope: anyOf("roleKey", "reviewer", "editor"),
		}},
	}
}

func approvalAmount(version int, limit, assurance string) core.PermissionBoundary {
	requirements := []core.ContextRequirement{}
	if assurance != "" {
		requirements = append(requirements, minimumAssurance(assurance))
	}
	return core.PermissionBoundary{
		Key: "approvalAmount", Version: version,
		Entries: []core.BoundaryEntry{{
			Permission: "contract.approve", ContextRequirements: requirements,
			RequiredScope: core.LogicalExpr{Op: core.OpAnd, Args: []core.Expr{
				eq("currency", literal("VND")),
				core.CompareExpr{Op: core.OpLt, Field: "amount", Value: literal(limit)},
			}},
		}},
	}
}

func regionalExport() core.PermissionBoundary {
	return core.PermissionBoundary{
		Key: "regionalExport", Version: 1,
		Entries: []core.BoundaryEntry{{
			Permission: "customer.export", ContextRequirements: []core.ContextRequirement{},
			RequiredScope: anyOf("region", "north", "central"),
		}},
	}
}

func boundarySource() core.SystemDeclarations {
	return core.SystemDeclarations{
		Resources: []core.ResourceDeclaration{
			{
				Key: "applicationRole", KeyKind: core.KeyString,
				Fields:  map[string]core.FieldType{"roleKey": {Kind: core.FieldString}},
				Actions: map[string]core.ActionDeclaration{"assign": {Policy: boundaryBaseline, Boundary: core.BoundaryRequired}},
			},
			{
				Key: "contract", KeyKind: core.KeyInteger,
				Fields: map[string]core.FieldType{
					"amount": {Kind: core.FieldDecimal}, "currency": {Kind: core.FieldString}, "status": {Kind: core.FieldString},
				},
				Actions: map[string]core.ActionDeclaration{
					"approve": {Policy: core.RelationRef{Key: "contractApproval", Version: 1}, Boundary: core.BoundaryRequired},
				},
			},
			{
				Key: "customer", KeyKind: core.KeyUUID,
				Fields:  map[string]core.FieldType{"region": {Kind: core.FieldString}},
				Actions: map[string]core.ActionDeclaration{"export": {Policy: boundaryBaseline, Boundary: core.BoundaryOptional}},
			},
		},
		Relations: []core.RelationDeclaration{},
		Policies: []core.PermissionPolicy{
			baselinePolicy(),
			{
				Key: "contractApproval", Version: 1,
				ContextRequirements: []core.ContextRequirement{minimumAssurance("2")},
				RequiredScope:       eq("status", literal("pending")),
				Obligations:         []core.Obligation{},
			},
		},
		Templates: []core.ScopeTemplate{
			template("allRoles", "applicationRole", everything, nil),
			template("roleIs", "applicationRole", eq("roleKey", parameter("role")), map[string]core.FieldKind{"role": core.FieldString}),
			template("allContracts", "contract", everything, nil),
			template("contractsBelow", "contract", core.CompareExpr{Op: core.OpLt, Field: "amount", Value: parameter("limit")},
				map[string]core.FieldKind{"limit": core.FieldDecimal}),
			template("allCustomers", "customer", everything, nil),
			template("regionIs", "customer", eq("region", parameter("region")), map[string]core.FieldKind{"region": core.FieldString}),
		},
		Boundaries: []core.PermissionBoundary{
			assignOperationalRoles(), approvalAmount(1, "100000000", ""), approvalAmount(2, "50000000", "3"), regionalExport(),
		},
		Capabilities: core.Capabilities{Validators: []string{"minimumAssurance@1"}, ObligationHandlers: []string{}},
	}
}

func boundarySnapshot(mutate func(*core.AuthoritySnapshot)) core.AuthoritySnapshot {
	approval := core.RelationRef{Key: "contractApproval", Version: 1}
	s := core.AuthoritySnapshot{
		Revision:     "3",
		Declarations: validated(boundarySource()),
		User:         &core.AuthorityUser{ID: alice, State: core.UserActive},
		Roles:        []string{"admin"},
		Permissions: []core.PermissionFact{
			catalogRow("applicationRole.assign", boundaryBaseline, core.BoundaryRequired),
			catalogRow("contract.approve", approval, core.BoundaryRequired),
			catalogRow("customer.export", boundaryBaseline, core.BoundaryOptional),
		},
		Rules:      []core.RuleFact{},
		Boundaries: []core.BoundaryBindingFact{},
		Registry: core.Registry{
			Validators:         map[string]core.ContextValidator{"minimumAssurance@1": assuranceValidator},
			ObligationHandlers: []string{},
		},
	}
	if mutate != nil {
		mutate(&s)
	}
	return s
}

func binding(permission, key string, version int) core.BoundaryBindingFact {
	return core.BoundaryBindingFact{
		Identity: alice, Permission: permission,
		Boundary: core.RelationRef{Key: key, Version: version}, Lifecycle: core.LifecycleActive,
	}
}

func boundaryRule(permission, templateKey string, effect core.Effect, subject core.RuleSubject, parameters map[string]core.Scalar) core.RuleFact {
	return rule(permission, subject, effect, templateKey+"@1", parameters)
}

func grant(permission, templateKey string) core.RuleFact {
	return boundaryRule(permission, templateKey, core.EffectAllow, adminSubject, nil)
}

func request(resource, action string, assurance int) core.TrustedInput {
	return core.TrustedInput{
		Principal: core.TrustedPrincipal{ID: alice, Assurance: assurance},
		Resource:  resource, Action: action, Context: map[string]core.Scalar{}, Now: now, ValidUntil: later,
	}
}

var objectSequence int

func nextObject() (string, string) {
	objectSequence++
	return fmt.Sprintf("5b000000-0000-4000-8000-%012d", objectSequence), strconv.Itoa(objectSequence)
}

func roleObject(roleKey string) core.FactObject {
	objectID, _ := nextObject()
	return core.FactObject{
		Type: "applicationRole", Key: core.Key{Kind: core.KeyString, Value: roleKey}, ObjectID: objectID,
		Fields: map[string]core.FieldValue{"roleKey": core.TextValue(roleKey)},
	}
}

func contract(amount, currency, status string) core.FactObject {
	objectID, number := nextObject()
	return core.FactObject{
		Type: "contract", Key: core.Key{Kind: core.KeyInteger, Value: number}, ObjectID: objectID,
		Fields: map[string]core.FieldValue{
			"amount": core.TextValue(amount), "currency": core.TextValue(currency), "status": core.TextValue(status),
		},
	}
}

func customer(region string) core.FactObject {
	objectID, _ := nextObject()
	return core.FactObject{
		Type: "customer", Key: core.Key{Kind: core.KeyUUID, Value: objectID}, ObjectID: objectID,
		Fields: map[string]core.FieldValue{"region": core.TextValue(region)},
	}
}

func recordException(record core.FactObject, permission string, effect core.Effect) core.ExceptionFact {
	return core.ExceptionFact{
		ObjectID: record.ObjectID, Permission: permission, Subject: personal, Effect: effect,
		Purpose: core.PurposeManual, StartsAt: "2026-10-01T00:00:00.000000Z",
	}
}

func boundaryDecide(i core.TrustedInput, s core.AuthoritySnapshot, record core.FactObject, exceptions ...core.ExceptionFact) bool {
	return decide(fixtureCore, i, s, withExceptions(record, exceptions...))
}

func assignInput() core.TrustedInput { return request("applicationRole", "assign", 2) }

func approveContract() core.TrustedInput { return request("contract", "approve", 2) }

func exportInput() core.TrustedInput { return request("customer", "export", 2) }

func TestEveryActionDeclaresItsBoundaryRequirementExplicitly(t *testing.T) {
	for _, boundary := range []core.BoundaryRequirement{"", "sometimes"} {
		source := boundarySource()
		source.Resources[2].Actions["export"] = core.ActionDeclaration{Policy: boundaryBaseline, Boundary: boundary}
		validationFails(t, source)
	}
	missing := boundarySource()
	missing.Boundaries = nil
	validationFails(t, missing)
}

func TestBoundaryEntriesAreTypedASTOnADeclaredPermission(t *testing.T) {
	entry := func(permission string, scope core.Expr, requirements ...core.ContextRequirement) core.BoundaryEntry {
		if requirements == nil {
			requirements = []core.ContextRequirement{}
		}
		return core.BoundaryEntry{Permission: permission, ContextRequirements: requirements, RequiredScope: scope}
	}
	single := func(entries ...core.BoundaryEntry) []core.PermissionBoundary {
		return []core.PermissionBoundary{{Key: "probe", Version: 1, Entries: entries}}
	}
	cases := map[string][]core.PermissionBoundary{
		"undeclared action":      single(entry("customer.delete", everything)),
		"resource only":          single(entry("customer", everything)),
		"undeclared resource":    single(entry("ghost.export", everything)),
		"extra segment":          single(entry("customer.export.more", everything)),
		"unknown field":          single(entry("customer.export", eq("missing", literal("x")))),
		"parameter":              single(entry("customer.export", eq("region", parameter("r")))),
		"nil scope":              single(entry("customer.export", nil)),
		"unsupported node":       single(entry("customer.export", referenceExpr{})),
		"unregistered validator": single(entry("customer.export", everything, core.ContextRequirement{Validator: "unregistered@1", Parameters: map[string]core.Scalar{}})),
		"nil requirements":       single(core.BoundaryEntry{Permission: "customer.export", RequiredScope: everything}),
		"empty entries":          {{Key: "empty", Version: 1, Entries: []core.BoundaryEntry{}}},
		"nil entries":            {{Key: "empty", Version: 1}},
		"entry twice":            {{Key: "twice", Version: 1, Entries: []core.BoundaryEntry{regionalExport().Entries[0], regionalExport().Entries[0]}}},
		"boundary twice":         {regionalExport(), regionalExport()},
		"version zero":           {{Key: "regionalExport", Version: 0, Entries: regionalExport().Entries}},
		"invalid key":            {{Key: "Bad key", Version: 1, Entries: regionalExport().Entries}},
		"unknown lifecycle":      {{Key: "regionalExport", Version: 1, Lifecycle: "paused", Entries: regionalExport().Entries}},
	}
	for name, boundaries := range cases {
		t.Run(name, func(t *testing.T) {
			source := boundarySource()
			source.Boundaries = boundaries
			validationFails(t, source)
		})
	}
}

func TestCanonicalFormCoversBoundariesAndIgnoresDeclarationOrder(t *testing.T) {
	base := validated(boundarySource()).Canonical()
	reordered := boundarySource()
	boundaries := reordered.Boundaries
	for i, j := 0, len(boundaries)-1; i < j; i, j = i+1, j-1 {
		boundaries[i], boundaries[j] = boundaries[j], boundaries[i]
	}
	if validated(reordered).Canonical() != base {
		t.Fatal("order changed the canonical form")
	}
	changed := boundarySource()
	changed.Boundaries = []core.PermissionBoundary{assignOperationalRoles(), approvalAmount(1, "100000001", ""), regionalExport()}
	if validated(changed).Canonical() == base {
		t.Fatal("a new limit did not change the canonical form")
	}
}

func TestRoleAssignmentStaysInsideTheBoundary(t *testing.T) {
	s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Rules = []core.RuleFact{grant("applicationRole.assign", "allRoles")}
		s.Boundaries = []core.BoundaryBindingFact{binding("applicationRole.assign", "assignOperationalRoles", 1)}
	})
	if !boundaryDecide(assignInput(), s, roleObject("reviewer")) || !boundaryDecide(assignInput(), s, roleObject("editor")) {
		t.Error("a role inside the boundary was denied")
	}
	if boundaryDecide(assignInput(), s, roleObject("owner")) {
		t.Error("a role outside the boundary was allowed")
	}
}

func TestABoundaryNeverGrants(t *testing.T) {
	s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Boundaries = []core.BoundaryBindingFact{binding("applicationRole.assign", "assignOperationalRoles", 1)}
	})
	if boundaryDecide(assignInput(), s, roleObject("reviewer")) {
		t.Fatal("a boundary without a grant allowed")
	}
}

func TestExplicitDenyStillWinsInsideTheBoundary(t *testing.T) {
	s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Rules = []core.RuleFact{
			grant("applicationRole.assign", "allRoles"),
			boundaryRule("applicationRole.assign", "roleIs", core.EffectDeny, personal, text("role", "reviewer")),
		}
		s.Boundaries = []core.BoundaryBindingFact{binding("applicationRole.assign", "assignOperationalRoles", 1)}
	})
	if boundaryDecide(assignInput(), s, roleObject("reviewer")) {
		t.Error("the deny did not win")
	}
	if !boundaryDecide(assignInput(), s, roleObject("editor")) {
		t.Error("the deny reached another role")
	}
}

func TestARecordAllowCannotPassTheBoundaryOrThePolicy(t *testing.T) {
	s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 1)}
	})
	for name, record := range map[string]core.FactObject{
		"at the limit":     contract("100000000", "VND", "pending"),
		"other currency":   contract("10", "USD", "pending"),
		"already approved": contract("10", "VND", "approved"),
	} {
		if boundaryDecide(approveContract(), s, record, recordException(record, "contract.approve", core.EffectAllow)) {
			t.Errorf("%s: a record allow passed", name)
		}
	}
	below := contract("99999999.9999", "VND", "pending")
	if !boundaryDecide(approveContract(), s, below, recordException(below, "contract.approve", core.EffectAllow)) {
		t.Error("a record allow inside the boundary was denied")
	}
	if boundaryDecide(approveContract(), s, below) {
		t.Error("allowed without a grant or a record allow")
	}
}

func TestGrantsFromSeveralRolesAndDirectRulesDoNotWidenTheBoundary(t *testing.T) {
	head := core.RuleSubject{Kind: core.SubjectRole, Role: "head"}
	director := core.RuleSubject{Kind: core.SubjectRole, Role: "director"}
	s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Roles = []string{"admin", "head", "director"}
		s.Rules = []core.RuleFact{
			boundaryRule("contract.approve", "contractsBelow", core.EffectAllow, adminSubject, text("limit", "1000")),
			boundaryRule("contract.approve", "allContracts", core.EffectAllow, head, nil),
			boundaryRule("contract.approve", "allContracts", core.EffectAllow, director, nil),
			boundaryRule("contract.approve", "allContracts", core.EffectAllow, personal, nil),
		}
		s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 1)}
	})
	for amount, want := range map[string]bool{"100000000": false, "500000000": false, "99999999": true} {
		if got := boundaryDecide(approveContract(), s, contract(amount, "VND", "pending")); got != want {
			t.Errorf("amount %s: allowed = %v", amount, got)
		}
	}
}

func TestRequiredWithoutABindingDeniesThePlan(t *testing.T) {
	rules := []core.RuleFact{grant("applicationRole.assign", "allRoles")}
	wantReason(t, fixtureCore.Plan(assignInput(), boundarySnapshot(func(s *core.AuthoritySnapshot) { s.Rules = rules })), "boundary_binding_missing")
	wantReason(t, fixtureCore.Plan(assignInput(), boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Rules = rules
		other := binding("applicationRole.assign", "assignOperationalRoles", 1)
		other.Identity = bob
		s.Boundaries = []core.BoundaryBindingFact{other}
	})), "boundary_binding_missing")
}

func TestABindingOfAnotherPermissionDoesNotApply(t *testing.T) {
	source := boundarySource()
	source.Boundaries = append(source.Boundaries, core.PermissionBoundary{
		Key: "both", Version: 1,
		Entries: []core.BoundaryEntry{
			{Permission: "applicationRole.assign", ContextRequirements: []core.ContextRequirement{}, RequiredScope: everything},
			{Permission: "customer.export", ContextRequirements: []core.ContextRequirement{}, RequiredScope: eq("region", literal("north"))},
		},
	})
	d := validated(source)
	wantReason(t, fixtureCore.Plan(assignInput(), boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Declarations = d
		s.Rules = []core.RuleFact{grant("applicationRole.assign", "allRoles")}
		s.Boundaries = []core.BoundaryBindingFact{binding("customer.export", "both", 1)}
	})), "boundary_binding_missing")

	unbound := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Declarations = d
		s.Rules = []core.RuleFact{grant("customer.export", "allCustomers")}
		s.Boundaries = []core.BoundaryBindingFact{binding("applicationRole.assign", "both", 1)}
	})
	if !boundaryDecide(exportInput(), unbound, customer("south")) {
		t.Fatal("a binding of another permission restricted this one")
	}
}

func TestOptionalWithoutABindingLeavesGrantsAloneAndABindingIsEnforced(t *testing.T) {
	rules := []core.RuleFact{grant("customer.export", "allCustomers")}
	open := boundarySnapshot(func(s *core.AuthoritySnapshot) { s.Rules = rules })
	if !boundaryDecide(exportInput(), open, customer("south")) {
		t.Error("an optional boundary without a binding restricted the grant")
	}
	bound := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Rules = rules
		s.Boundaries = []core.BoundaryBindingFact{binding("customer.export", "regionalExport", 1)}
	})
	if !boundaryDecide(exportInput(), bound, customer("north")) {
		t.Error("inside the bound boundary was denied")
	}
	south := customer("south")
	if boundaryDecide(exportInput(), bound, south) {
		t.Error("outside the bound boundary was allowed")
	}
	if boundaryDecide(exportInput(), bound, south, recordException(south, "customer.export", core.EffectAllow)) {
		t.Error("a record allow passed a bound optional boundary")
	}
}

func TestMissingOrInvalidBoundaryFactsFailClosed(t *testing.T) {
	rules := []core.RuleFact{grant("contract.approve", "allContracts")}
	withLifecycle := func(lifecycle core.Lifecycle) core.BoundaryBindingFact {
		fact := binding("contract.approve", "approvalAmount", 1)
		fact.Lifecycle = lifecycle
		return fact
	}
	catalogBoundary := func(requirement core.BoundaryRequirement) func(*core.AuthoritySnapshot) {
		return func(s *core.AuthoritySnapshot) {
			s.Permissions[1].Boundary = requirement
			s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 1)}
		}
	}
	cases := map[string]struct {
		mutate func(*core.AuthoritySnapshot)
		reason string
	}{
		"unknown version": {func(s *core.AuthoritySnapshot) {
			s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 9)}
		}, "boundary_definition_missing"},
		"unknown boundary": {func(s *core.AuthoritySnapshot) {
			s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "ghost", 1)}
		}, "boundary_definition_missing"},
		"definition without an entry for this permission": {func(s *core.AuthoritySnapshot) {
			s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "regionalExport", 1)}
		}, "boundary_entry_missing"},
		"retired binding": {func(s *core.AuthoritySnapshot) {
			s.Boundaries = []core.BoundaryBindingFact{withLifecycle(core.LifecycleRetired)}
		}, "boundary_unavailable"},
		"unknown lifecycle": {func(s *core.AuthoritySnapshot) {
			s.Boundaries = []core.BoundaryBindingFact{withLifecycle("paused")}
		}, "boundary_unavailable"},
		"no lifecycle": {func(s *core.AuthoritySnapshot) {
			s.Boundaries = []core.BoundaryBindingFact{withLifecycle("")}
		}, "boundary_unavailable"},
		"two bindings for one permission": {func(s *core.AuthoritySnapshot) {
			s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 1), binding("contract.approve", "approvalAmount", 2)}
		}, "ambiguous_boundary_binding"},
		"catalog requirement not backfilled":    {catalogBoundary(""), "boundary_requirement_mismatch"},
		"catalog requirement differs from code": {catalogBoundary(core.BoundaryOptional), "boundary_requirement_mismatch"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			wantReason(t, fixtureCore.Plan(approveContract(), boundarySnapshot(func(s *core.AuthoritySnapshot) {
				s.Rules = rules
				c.mutate(s)
			})), c.reason)
		})
	}
	retired := approvalAmount(1, "100000000", "")
	retired.Lifecycle = core.LifecycleRetired
	source := boundarySource()
	source.Boundaries = []core.PermissionBoundary{assignOperationalRoles(), retired, regionalExport()}
	wantReason(t, fixtureCore.Plan(approveContract(), boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Declarations = validated(source)
		s.Rules = rules
		s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 1)}
	})), "boundary_unavailable")
}

func TestBoundaryContextRequirementsAndExactVersionAreEnforced(t *testing.T) {
	s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Rules = []core.RuleFact{grant("contract.approve", "allContracts")}
		s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 2)}
	})
	wantReason(t, fixtureCore.Plan(approveContract(), s), "context_requirement_failed")
	strong := request("contract", "approve", 3)
	if !boundaryDecide(strong, s, contract("49999999", "VND", "pending")) {
		t.Error("inside version 2 was denied")
	}
	if boundaryDecide(strong, s, contract("50000000", "VND", "pending")) {
		t.Error("the limit of version 1 applied, not version 2")
	}
}

func TestClientSuppliedContextCannotFakeBoundaryFacts(t *testing.T) {
	s := boundarySnapshot(func(s *core.AuthoritySnapshot) {
		s.Rules = []core.RuleFact{grant("contract.approve", "allContracts")}
		s.Boundaries = []core.BoundaryBindingFact{binding("contract.approve", "approvalAmount", 1)}
	})
	forged := approveContract()
	forged.Context = text("amount", "1", "currency", "VND", "boundary", "none", "roleKey", "reviewer")
	if boundaryDecide(forged, s, contract("200000000", "VND", "pending")) {
		t.Fatal("the context replaced the record")
	}
}

func TestABoundBoundaryNeverEnlargesTheAllowedSet(t *testing.T) {
	random := rand.New(rand.NewPCG(20261013, 1))
	regions := []string{"north", "south", "central", "west"}
	subjects := []core.RuleSubject{
		adminSubject, {Kind: core.SubjectRole, Role: "other"}, personal, {Kind: core.SubjectIdentity, Identity: bob},
	}
	effect := func(denyChance float64) core.Effect {
		if random.Float64() < denyChance {
			return core.EffectDeny
		}
		return core.EffectAllow
	}
	allowedOpen, narrowed := 0, 0
	for round := range 300 {
		rules := make([]core.RuleFact, 1+random.IntN(4))
		for i := range rules {
			subject := subjects[random.IntN(len(subjects))]
			if random.Float64() < 0.5 {
				rules[i] = boundaryRule("customer.export", "allCustomers", effect(0.2), subject, nil)
			} else {
				rules[i] = boundaryRule("customer.export", "regionIs", effect(0.2), subject, text("region", regions[random.IntN(4)]))
			}
		}
		region := regions[random.IntN(4)]
		record := customer(region)
		var exceptions []core.ExceptionFact
		if random.Float64() < 0.4 {
			exceptions = []core.ExceptionFact{recordException(record, "customer.export", effect(0.3))}
		}
		open := boundaryDecide(exportInput(), boundarySnapshot(func(s *core.AuthoritySnapshot) { s.Rules = rules }), record, exceptions...)
		bound := boundaryDecide(exportInput(), boundarySnapshot(func(s *core.AuthoritySnapshot) {
			s.Rules = rules
			s.Boundaries = []core.BoundaryBindingFact{binding("customer.export", "regionalExport", 1)}
		}), record, exceptions...)
		if !open && bound {
			t.Fatalf("round %d: the boundary enlarged the allowed set", round)
		}
		if bound && region != "north" && region != "central" {
			t.Fatalf("round %d: allowed outside the boundary in %s", round, region)
		}
		if open {
			allowedOpen++
			if !bound {
				narrowed++
			}
		}
	}
	if allowedOpen == 0 || narrowed == 0 {
		t.Fatalf("the property saw allowed=%d narrowed=%d", allowedOpen, narrowed)
	}
}
