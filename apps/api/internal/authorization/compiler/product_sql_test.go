package compiler_test

import (
	"slices"
	"strings"
	"testing"

	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/values"
)

const alice core.IdentityID = "a0000000-0000-4000-8000-000000000001"

const (
	now   = "2026-10-13T10:00:00.000000Z"
	later = "2026-10-13T10:00:02.000000Z"
)

func newTestCore(t *testing.T) *core.Core {
	t.Helper()
	c, err := core.New(values.Codecs())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func fixtureDeclarationsSource() core.SystemDeclarations {
	baseline := core.RelationRef{Key: "baseline", Version: 1}
	everything := core.ConstantExpr{Value: true}
	principalID := core.CompareExpr{
		Op:    core.OpEq,
		Field: "identityId",
		Value: core.ValueRef{From: core.SourcePrincipal, Name: "id"},
	}
	return core.SystemDeclarations{
		Resources: []core.ResourceDeclaration{
			{
				Key:     "submission",
				KeyKind: core.KeyInteger,
				Fields: map[string]core.FieldType{
					"status":   {Kind: core.FieldString},
					"amount":   {Kind: core.FieldDecimal},
					"title":    {Kind: core.FieldString, Nullable: true},
					"priority": {Kind: core.FieldInteger, Nullable: true},
				},
				Actions: map[string]core.ActionDeclaration{
					"read": {Policy: baseline, Boundary: core.BoundaryOptional},
				},
			},
			{
				Key:     "site",
				KeyKind: core.KeyUUID,
				Fields:  map[string]core.FieldType{"name": {Kind: core.FieldString}},
				Actions: map[string]core.ActionDeclaration{
					"read": {Policy: baseline, Boundary: core.BoundaryOptional},
				},
			},
		},
		Relations: []core.RelationDeclaration{
			{
				Key:        "submission.site",
				Version:    1,
				SourceType: "submission",
				Target:     core.RelationTarget{Kind: core.RelationTargetResource, Type: "site"},
				Binding:    core.RelationBinding{Kind: core.BindingEdgeStore},
			},
			{
				Key:        "site.manager",
				Version:    1,
				SourceType: "site",
				Target:     core.RelationTarget{Kind: core.RelationTargetIdentity},
				Binding:    core.RelationBinding{Kind: core.BindingDomain, Key: "siteManagers"},
			},
			{
				Key:        "submission.assignee",
				Version:    1,
				SourceType: "submission",
				Target:     core.RelationTarget{Kind: core.RelationTargetIdentity},
				Binding:    core.RelationBinding{Kind: core.BindingEdgeStore},
			},
		},
		Policies: []core.PermissionPolicy{
			{
				Key:                 "baseline",
				Version:             1,
				ContextRequirements: []core.ContextRequirement{},
				RequiredScope:       everything,
				Obligations:         []core.Obligation{},
			},
		},
		Templates: []core.ScopeTemplate{
			{
				Key:        "all",
				Version:    1,
				Resource:   "submission",
				Parameters: map[string]core.FieldKind{},
				Expression: everything,
			},
			{
				Key:        "assignedToMe",
				Version:    1,
				Resource:   "submission",
				Parameters: map[string]core.FieldKind{},
				Expression: core.ExistsExpr{Relation: "submission.assignee@1", Where: principalID},
			},
			{
				Key:        "managedSite",
				Version:    1,
				Resource:   "submission",
				Parameters: map[string]core.FieldKind{},
				Expression: core.ExistsExpr{
					Relation: "submission.site@1",
					Where:    core.ExistsExpr{Relation: "site.manager@1", Where: principalID},
				},
			},
			{
				Key:        "titleBefore",
				Version:    1,
				Resource:   "submission",
				Parameters: map[string]core.FieldKind{"title": core.FieldString},
				Expression: core.CompareExpr{
					Op:    core.OpLt,
					Field: "title",
					Value: core.ValueRef{From: core.SourceParameter, Name: "title"},
				},
			},
		},
		Boundaries:   []core.PermissionBoundary{},
		Capabilities: core.Capabilities{Validators: []string{}, ObligationHandlers: []string{}},
	}
}

func fixtureStorageBindings() compiler.StorageBindings {
	return compiler.StorageBindings{
		Resources: []compiler.ResourceBinding{
			{
				Resource:       "submission",
				Table:          "submission",
				ObjectIDColumn: "object_id",
				KeyColumn:      "id",
				Columns: map[string]string{
					"status":   "status",
					"amount":   "amount",
					"title":    "title",
					"priority": "priority",
				},
				Projection: []string{"status"},
			},
			{
				Resource:       "site",
				Table:          "site",
				ObjectIDColumn: "object_id",
				KeyColumn:      "id",
				Columns:        map[string]string{"name": "name"},
				Projection:     []string{"name"},
			},
		},
		Domains: map[string]compiler.DomainRelationBinding{
			"siteManagers": {
				Table:        "site_manager",
				SourceColumn: "site_id",
				TargetColumn: "user_id",
			},
		},
	}
}

func fixtureInput() core.TrustedInput {
	return core.TrustedInput{
		Principal:  core.TrustedPrincipal{ID: alice, Assurance: 2},
		Resource:   "submission",
		Action:     "read",
		Context:    map[string]core.Scalar{},
		Now:        now,
		ValidUntil: later,
	}
}

func fixtureSnapshot(declarations *core.ValidatedDeclarations, rules []core.RuleFact) core.AuthoritySnapshot {
	return core.AuthoritySnapshot{
		Revision:     "1",
		Declarations: declarations,
		User:         &core.AuthorityUser{ID: alice, State: core.UserActive},
		Roles:        []string{"reviewer"},
		Permissions: []core.PermissionFact{
			{
				Key:       "submission.read",
				Resource:  "submission",
				Action:    "read",
				Policy:    core.RelationRef{Key: "baseline", Version: 1},
				Boundary:  core.BoundaryOptional,
				Lifecycle: core.LifecycleActive,
			},
		},
		Rules:      rules,
		Boundaries: []core.BoundaryBindingFact{},
		Registry: core.Registry{
			Validators:         map[string]core.ContextValidator{},
			ObligationHandlers: []string{},
		},
	}
}

func TestProductSQLUsesNativeKeysAndBoundValuesWithoutAnyTenantContract(t *testing.T) {
	c := newTestCore(t)
	d, err := c.Validate(fixtureDeclarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	registry, err := compiler.NewRegistry(c, d, fixtureStorageBindings())
	if err != nil {
		t.Fatal(err)
	}
	decision := c.Plan(fixtureInput(), fixtureSnapshot(d, nil))
	if !decision.Allowed() {
		t.Fatalf("decision denied: %s", decision.Reason())
	}
	sql, err := compiler.CompilePlan(decision.Plan(), registry)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sql.SQL, "tenant") {
		t.Errorf("SQL mentions tenant: %s", sql.SQL)
	}
	if !strings.Contains(sql.SQL, "statement_timestamp() < CAST(") {
		t.Errorf("SQL missing validUntil statement_timestamp guard: %s", sql.SQL)
	}
	if !strings.Contains(sql.SQL, "record_exception") {
		t.Errorf("SQL missing record_exception: %s", sql.SQL)
	}
	if !strings.Contains(sql.SQL, "purpose = CAST(") {
		t.Errorf("SQL missing manual purpose check on allow exception: %s", sql.SQL)
	}
	hasUserID := slices.ContainsFunc(sql.Parameters, func(p compiler.Param) bool {
		return p.Equal(compiler.TextParam(string(decision.Plan().UserID())))
	})
	if !hasUserID {
		t.Errorf("parameters do not include userId %s: %#v", decision.Plan().UserID(), sql.Parameters)
	}
	hasValidUntil := slices.ContainsFunc(sql.Parameters, func(p compiler.Param) bool {
		return p.Equal(compiler.TextParam(decision.Plan().ValidUntil()))
	})
	if !hasValidUntil {
		t.Errorf("parameters do not include validUntil %s: %#v", decision.Plan().ValidUntil(), sql.Parameters)
	}
}

func TestQuoteIdentifierAndPgTypes(t *testing.T) {
	for _, valid := range []string{"a", "_id", "submission_1", strings.Repeat("a", 63)} {
		got, err := compiler.QuoteIdentifier(valid)
		if err != nil || got != `"`+valid+`"` {
			t.Errorf("QuoteIdentifier(%q) = %q, %v", valid, got, err)
		}
	}
	for _, unsafe := range []string{"", "1col", "Upper", "a-b", "a;b", `a"b`, "a b", strings.Repeat("a", 64)} {
		if got, err := compiler.QuoteIdentifier(unsafe); err == nil {
			t.Errorf("QuoteIdentifier(%q) succeeded with %q", unsafe, got)
		}
	}
	for wantKind, wantPg := range map[core.FieldKind]string{
		core.FieldInteger:   "int8",
		core.FieldDecimal:   "numeric",
		core.FieldString:    "text",
		core.FieldUUID:      "uuid",
		core.FieldBoolean:   "boolean",
		core.FieldTimestamp: "timestamptz",
	} {
		if pg, ok := compiler.FieldPgType(wantKind); !ok || pg != wantPg {
			t.Errorf("FieldPgType(%s) = %q, %v; want %q, true", wantKind, pg, ok, wantPg)
		}
	}
	if _, ok := compiler.FieldPgType("money"); ok {
		t.Error("FieldPgType accepted unknown kind")
	}
	for wantKind, wantPg := range map[core.KeyKind]string{
		core.KeyInteger: "int8",
		core.KeyUUID:    "uuid",
		core.KeyString:  "text",
	} {
		if pg, ok := compiler.KeyPgType(wantKind); !ok || pg != wantPg {
			t.Errorf("KeyPgType(%s) = %q, %v; want %q, true", wantKind, pg, ok, wantPg)
		}
	}
	if _, ok := compiler.KeyPgType("composite"); ok {
		t.Error("KeyPgType accepted unknown kind")
	}
}

func TestRegistryValidationAndImmutability(t *testing.T) {
	c := newTestCore(t)
	otherCore := newTestCore(t)
	d, err := c.Validate(fixtureDeclarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := compiler.NewRegistry(nil, d, fixtureStorageBindings()); err == nil {
		t.Error("accepted nil core")
	}
	if _, err := compiler.NewRegistry(otherCore, d, fixtureStorageBindings()); err == nil {
		t.Error("accepted declarations from another core")
	}

	cases := map[string]func(*compiler.StorageBindings){
		"missing resource": func(b *compiler.StorageBindings) {
			b.Resources = b.Resources[:1]
		},
		"undeclared resource": func(b *compiler.StorageBindings) {
			b.Resources = append(b.Resources, compiler.ResourceBinding{
				Resource: "other", Table: "other", ObjectIDColumn: "object_id", KeyColumn: "id",
			})
		},
		"duplicate resource": func(b *compiler.StorageBindings) {
			b.Resources = append(b.Resources, b.Resources[0])
		},
		"unsafe table identifier": func(b *compiler.StorageBindings) {
			b.Resources[0].Table = "submission;DROP"
		},
		"missing field column": func(b *compiler.StorageBindings) {
			delete(b.Resources[0].Columns, "amount")
		},
		"unsafe field column": func(b *compiler.StorageBindings) {
			b.Resources[0].Columns["amount"] = "Amount"
		},
		"undeclared projection field": func(b *compiler.StorageBindings) {
			b.Resources[0].Projection = []string{"secret"}
		},
		"undeclared column mapping": func(b *compiler.StorageBindings) {
			b.Resources[0].Columns["undeclaredField"] = "status"
		},
		"missing domain binding": func(b *compiler.StorageBindings) {
			delete(b.Domains, "siteManagers")
		},
		"unused domain binding": func(b *compiler.StorageBindings) {
			b.Domains["unusedDomain"] = compiler.DomainRelationBinding{
				Table: "site_manager", SourceColumn: "site_id", TargetColumn: "user_id",
			}
		},
		"unsafe domain column": func(b *compiler.StorageBindings) {
			d := b.Domains["siteManagers"]
			d.TargetColumn = "user-id"
			b.Domains["siteManagers"] = d
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			b := fixtureStorageBindings()
			mutate(&b)
			if _, err := compiler.NewRegistry(c, d, b); err == nil {
				t.Fatalf("expected error for %s", name)
			}
		})
	}

	b := fixtureStorageBindings()
	reg, err := compiler.NewRegistry(c, d, b)
	if err != nil {
		t.Fatal(err)
	}
	b.Resources[0].Columns["status"] = "mutated"
	b.Resources[0].Projection[0] = "mutated"
	res, err := reg.Resource("submission")
	if err != nil {
		t.Fatal(err)
	}
	if res.Columns["status"] != "status" || res.Projection[0] != "status" {
		t.Fatalf("registry mutated through caller input: %#v", res)
	}
	res.Columns["status"] = "mutated_again"
	res.Projection[0] = "mutated_again"
	fresh, err := reg.Resource("submission")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Columns["status"] != "status" || fresh.Projection[0] != "status" {
		t.Fatalf("registry mutated through returned ResourceBinding: %#v", fresh)
	}
	if _, ok := reg.Domain("site.manager@1"); !ok {
		t.Fatal("expected Domain(\"site.manager@1\") to exist")
	}
	if _, ok := reg.Domain("siteManagers"); ok {
		t.Fatal("Domain should only be indexed by canonical relation ref, not raw binding key")
	}
}

type foreignPlanExpr struct{ core.PlanExpr }

func TestCompileExpressionAndProvenanceChecks(t *testing.T) {
	c := newTestCore(t)
	otherCore := newTestCore(t)
	d, err := c.Validate(fixtureDeclarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	b := fixtureStorageBindings()
	b.Domains["siteManagers"] = compiler.DomainRelationBinding{
		Table: "site_manager", SourceColumn: "site_id", TargetColumn: "user_id",
		StartsColumn: "starts_at", ExpiresColumn: "expires_at",
	}
	reg, err := compiler.NewRegistry(c, d, b)
	if err != nil {
		t.Fatal(err)
	}

	rules := []core.RuleFact{
		{
			ID: "r1", Permission: "submission.read",
			Subject:    core.RuleSubject{Kind: core.SubjectRole, Role: "reviewer"},
			Effect:     core.EffectAllow,
			Template:   core.RelationRef{Key: "managedSite", Version: 1},
			Parameters: map[string]core.Scalar{},
		},
		{
			ID: "r2", Permission: "submission.read",
			Subject:    core.RuleSubject{Kind: core.SubjectRole, Role: "reviewer"},
			Effect:     core.EffectAllow,
			Template:   core.RelationRef{Key: "titleBefore", Version: 1},
			Parameters: map[string]core.Scalar{"title": core.Text("Zeta")},
		},
	}
	decision := c.Plan(fixtureInput(), fixtureSnapshot(d, rules))
	if !decision.Allowed() {
		t.Fatalf("plan denied: %s", decision.Reason())
	}
	plan := decision.Plan()
	bound, err := compiler.CompilePlan(plan, reg)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`statement_timestamp() < CAST(`,
		`FROM relation_edge r_e1 JOIN "site" r_t1`,
		`r_e1.source_type = CAST(`,
		`r_e1.target_type = CAST(`,
		`r_e1."starts_at" <= statement_timestamp() AND (r_e1."expires_at" IS NULL OR r_e1."expires_at" > statement_timestamp())`,
		`FROM "site_manager" r_e2`,
		`r_e2."starts_at" <= statement_timestamp() AND (r_e2."expires_at" IS NULL OR r_e2."expires_at" > statement_timestamp())`,
		`r."title" COLLATE "C" < CAST(`,
		`r_x1.type_key = CAST(`,
		`r_x1.purpose = CAST(`,
		`r_x1."starts_at" <= statement_timestamp() AND (r_x1."expires_at" IS NULL OR r_x1."expires_at" > statement_timestamp())`,
	} {
		if !strings.Contains(bound.SQL, want) {
			t.Errorf("compiled SQL missing %q:\n%s", want, bound.SQL)
		}
	}

	atBound, err := compiler.CompilePlanAt(plan, reg, "s", 3)
	if err != nil {
		t.Fatalf("CompilePlanAt(plan, reg, \"s\", 3) failed: %v", err)
	}
	if len(atBound.Parameters) != len(bound.Parameters) {
		t.Fatalf("CompilePlanAt parameters len = %d, want %d", len(atBound.Parameters), len(bound.Parameters))
	}
	for i := range bound.Parameters {
		if !atBound.Parameters[i].Equal(bound.Parameters[i]) {
			t.Fatalf("parameter %d mismatch: %#v != %#v", i, atBound.Parameters[i], bound.Parameters[i])
		}
	}
	for _, wantAt := range []string{
		`statement_timestamp() < CAST($20 AS timestamptz)`,
		`FROM relation_edge s_e1 JOIN "site" s_t1`,
		`s_e1.relation_key = CAST($3 AS bytea)`,
		`s_e1.source_object = s."object_id"`,
		`FROM "site_manager" s_e2`,
		`s."title" COLLATE "C" < CAST(`,
		`FROM record_exception s_x1 WHERE s_x1.object_id = s."object_id"`,
	} {
		if !strings.Contains(atBound.SQL, wantAt) {
			t.Errorf("CompilePlanAt SQL missing %q:\n%s", wantAt, atBound.SQL)
		}
	}
	if strings.Contains(atBound.SQL, "$1 ") || strings.Contains(atBound.SQL, "$2 ") || strings.Contains(atBound.SQL, "r.") {
		t.Errorf("CompilePlanAt SQL still contains unshifted params or default alias:\n%s", atBound.SQL)
	}

	copied := *plan
	otherD, err := otherCore.Validate(fixtureDeclarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	otherPlan := otherCore.Plan(fixtureInput(), fixtureSnapshot(otherD, nil)).Plan()
	for name, badPlan := range map[string]*core.AuthorizedPlan{
		"nil":        nil,
		"zero":       {},
		"copied":     &copied,
		"other core": otherPlan,
	} {
		if _, err := compiler.CompilePlan(badPlan, reg); err == nil {
			t.Errorf("CompilePlan accepted %s plan", name)
		}
	}
	for _, badAlias := range []string{"", "R", "r1", "r;"} {
		if _, err := compiler.CompilePlanAt(plan, reg, badAlias, 1); err == nil {
			t.Errorf("CompilePlanAt accepted alias %q", badAlias)
		}
	}
	if _, err := compiler.CompilePlanAt(plan, reg, "r", 0); err == nil {
		t.Error("CompilePlanAt accepted firstIndex 0")
	}

	subBinding, err := reg.Resource("submission")
	if err != nil {
		t.Fatal(err)
	}
	scope := compiler.ResourceScope{Alias: "r", Binding: subBinding}
	bind := func(_ compiler.Param, pgType string) string { return "CAST($1 AS " + pgType + ")" }
	nextAlias := func(prefix string) string { return prefix + "1" }
	if _, err := compiler.CompileExpression(foreignPlanExpr{}, reg, scope, bind, nextAlias); err == nil {
		t.Error("CompileExpression accepted foreign PlanExpr")
	}
	if _, err := compiler.CompileExpression(
		core.PlanCompare{Op: core.OpEq, Field: "amount", Kind: core.FieldInteger, Value: core.Text("10")},
		reg, scope, bind, nextAlias,
	); err == nil {
		t.Error("CompileExpression accepted mismatched field kind")
	}
	if _, err := compiler.CompileExpression(
		core.PlanCompare{Op: core.OpEq, Field: "ghost", Kind: core.FieldString, Value: core.Text("x")},
		reg,
		compiler.ResourceScope{Alias: "r", Binding: compiler.ResourceBinding{Resource: "submission", Columns: map[string]string{"ghost": "status"}}},
		bind, nextAlias,
	); err == nil {
		t.Error("CompileExpression accepted undeclared field in custom ResourceBinding")
	}
	if _, err := compiler.CompileExpression(
		core.PlanIsNull{Field: "ghost"}, reg,
		compiler.ResourceScope{Alias: "r", Binding: compiler.ResourceBinding{Resource: "submission", Columns: map[string]string{"ghost": "status"}}},
		bind, nextAlias,
	); err == nil {
		t.Error("CompileExpression accepted undeclared isNull field in custom ResourceBinding")
	}
	if _, err := compiler.CompileExpression(
		core.PlanCompare{Op: core.OpEq, Field: "status", Kind: core.FieldString, Value: core.Text("x")},
		reg,
		compiler.ResourceScope{Alias: "r", Binding: compiler.ResourceBinding{Resource: "ghost", Columns: map[string]string{"status": "status"}}},
		bind, nextAlias,
	); err == nil {
		t.Error("CompileExpression accepted undeclared resource in custom ResourceBinding")
	}
	for _, badScopeAlias := range []string{"", "r;DROP", "1r", "r space"} {
		if _, err := compiler.CompileExpression(
			core.PlanConstant{Value: true},
			reg,
			compiler.ResourceScope{Alias: badScopeAlias, Binding: subBinding},
			bind, nextAlias,
		); err == nil {
			t.Errorf("CompileExpression accepted unsafe ResourceScope.Alias %q", badScopeAlias)
		}
	}
	for _, badNext := range []string{"", "bad;alias", "1bad", "R_upper"} {
		for _, tc := range []struct {
			name, prefix string
			expr         core.PlanExpr
		}{
			{"edge alias", "e", plan.Predicate()},
			{"resource target alias", "t", plan.Predicate()},
			{"identity source alias", "t", core.PlanExists{
				Relation: core.RelationRef{Key: "submission.assignee", Version: 1}, Source: "submission",
				Target: core.RelationTarget{Kind: core.RelationTargetIdentity}, Where: core.PlanConstant{Value: true},
			}},
			{"exception alias", "x", core.PlanException{Permission: "submission.read", Effect: core.EffectAllow, Identity: fixtureInput().Principal.ID}},
		} {
			if _, err := compiler.CompileExpression(tc.expr, reg, scope, bind, func(prefix string) string {
				if prefix == tc.prefix {
					return badNext
				}
				return "r_" + prefix + "1"
			}); err == nil {
				t.Errorf("%s accepted unsafe nextAlias result %q", tc.name, badNext)
			}
		}
	}
}
