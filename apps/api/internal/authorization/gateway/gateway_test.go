package gateway_test

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/gateway"
	"hrm/api/internal/authorization/values"
	"hrm/api/internal/database"
)

const alice core.IdentityID = "a0000000-0000-4000-8000-000000000001"

const (
	now   = "2026-10-13T10:00:00.000000Z"
	later = "2026-10-13T10:00:02.000000Z"
)

type spyCodec struct {
	kind  string
	inner core.ScalarCodec
	calls *[]string
}

func (s spyCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	*s.calls = append(*s.calls, s.kind)
	return s.inner.Normalize(input)
}

func (s spyCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	return s.inner.Compare(left, right)
}

func declarationsSource() core.SystemDeclarations {
	baseline := core.RelationRef{Key: "baseline", Version: 1}
	everything := core.ConstantExpr{Value: true}
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
					"ownerId":  {Kind: core.FieldUUID, Nullable: true},
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
			{
				Key:     "tag",
				KeyKind: core.KeyString,
				Fields:  map[string]core.FieldType{"label": {Kind: core.FieldString}},
				Actions: map[string]core.ActionDeclaration{
					"read": {Policy: baseline, Boundary: core.BoundaryOptional},
				},
			},
		},
		Relations: []core.RelationDeclaration{
			{
				Key:        "site.manager",
				Version:    1,
				SourceType: "site",
				Target:     core.RelationTarget{Kind: core.RelationTargetIdentity},
				Binding:    core.RelationBinding{Kind: core.BindingDomain, Key: "siteManagers"},
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
				Key:        "allSites",
				Version:    1,
				Resource:   "site",
				Parameters: map[string]core.FieldKind{},
				Expression: everything,
			},
			{
				Key:        "allTags",
				Version:    1,
				Resource:   "tag",
				Parameters: map[string]core.FieldKind{},
				Expression: everything,
			},
		},
		Boundaries:   []core.PermissionBoundary{},
		Capabilities: core.Capabilities{Validators: []string{}, ObligationHandlers: []string{}},
	}
}

func storageBindings() compiler.StorageBindings {
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
					"ownerId":  "owner_id",
				},
				Projection: []string{"status", "amount", "title", "ownerId"},
			},
			{
				Resource:       "site",
				Table:          "site",
				ObjectIDColumn: "object_id",
				KeyColumn:      "id",
				Columns:        map[string]string{"name": "name"},
				Projection:     []string{"name"},
			},
			{
				Resource:       "tag",
				Table:          "tag",
				ObjectIDColumn: "object_id",
				KeyColumn:      "code",
				Columns:        map[string]string{"label": "label"},
				Projection:     []string{"label"},
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

func issueResourcePlan(t *testing.T, c *core.Core, d *core.ValidatedDeclarations, resource, template string) *core.AuthorizedPlan {
	t.Helper()
	perm := resource + ".read"
	in := core.TrustedInput{
		Principal:  core.TrustedPrincipal{ID: alice, Assurance: 2},
		Resource:   resource,
		Action:     "read",
		Context:    map[string]core.Scalar{},
		Now:        now,
		ValidUntil: later,
	}
	snap := core.AuthoritySnapshot{
		Revision:     "1",
		Declarations: d,
		User:         &core.AuthorityUser{ID: alice, State: core.UserActive},
		Roles:        []string{"reviewer"},
		Permissions: []core.PermissionFact{
			{
				Key:       perm,
				Resource:  resource,
				Action:    "read",
				Policy:    core.RelationRef{Key: "baseline", Version: 1},
				Boundary:  core.BoundaryOptional,
				Lifecycle: core.LifecycleActive,
			},
		},
		Rules: []core.RuleFact{
			{
				ID:         "r1",
				Permission: perm,
				Subject:    core.RuleSubject{Kind: core.SubjectRole, Role: "reviewer"},
				Effect:     core.EffectAllow,
				Template:   core.RelationRef{Key: template, Version: 1},
				Parameters: map[string]core.Scalar{},
			},
		},
		Boundaries: []core.BoundaryBindingFact{},
		Registry: core.Registry{
			Validators:         map[string]core.ContextValidator{},
			ObligationHandlers: []string{},
		},
	}
	decision := c.Plan(in, snap)
	if !decision.Allowed() {
		t.Fatalf("plan denied: %s", decision.Reason())
	}
	return decision.Plan()
}

func issuePlan(t *testing.T, c *core.Core, d *core.ValidatedDeclarations) *core.AuthorizedPlan {
	t.Helper()
	return issueResourcePlan(t, c, d, "submission", "all")
}

func TestGatewayFiltersAndKeysAreNormalizedByTheRegistryCore(t *testing.T) {
	var calls []string
	standard := values.Codecs()
	spiedCodecs := core.ValueCodecs{
		Integer:   spyCodec{kind: "integer", inner: standard.Integer, calls: &calls},
		Decimal:   spyCodec{kind: "decimal", inner: standard.Decimal, calls: &calls},
		String:    spyCodec{kind: "string", inner: standard.String, calls: &calls},
		UUID:      spyCodec{kind: "uuid", inner: standard.UUID, calls: &calls},
		Boolean:   spyCodec{kind: "boolean", inner: standard.Boolean, calls: &calls},
		Timestamp: spyCodec{kind: "timestamp", inner: standard.Timestamp, calls: &calls},
	}
	spied, err := core.New(spiedCodecs)
	if err != nil {
		t.Fatal(err)
	}
	d, err := spied.Validate(declarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	reg, err := compiler.NewRegistry(spied, d, storageBindings())
	if err != nil {
		t.Fatal(err)
	}
	plan := issuePlan(t, spied, d)
	sitePlan := issueResourcePlan(t, spied, d, "site", "allSites")
	tagPlan := issueResourcePlan(t, spied, d, "tag", "allTags")
	gw, err := gateway.New(reg)
	if err != nil {
		t.Fatal(err)
	}

	tx := &database.Tx{Mode: database.ModeRead, Revision: plan.Revision()}
	calls = nil
	listSQL, listParams, err := gw.BuildListSQLForTest(plan, gateway.ListQuery{
		Filter: gateway.LogicalFilter{
			Op: core.OpAnd,
			Args: []gateway.Filter{
				gateway.CompareFilter{Op: core.OpEq, Field: "status", Value: core.TextValue("pending")},
				gateway.CompareFilter{Op: core.OpLte, Field: "amount", Value: core.TextValue("20.5")},
				gateway.CompareFilter{Op: core.OpEq, Field: "ownerId", Value: core.TextValue("A0000000-0000-4000-8000-000000000001")},
			},
		},
	}, tx)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(calls)
	if !slices.Equal(calls, []string{"decimal", "string", "uuid"}) {
		t.Fatalf("expected calls [decimal string uuid], got %v", calls)
	}
	hasPending := slices.ContainsFunc(listParams, func(p compiler.Param) bool { return p.Equal(compiler.TextParam("pending")) })
	hasAmount := slices.ContainsFunc(listParams, func(p compiler.Param) bool { return p.Equal(compiler.TextParam("20.5")) })
	hasOwner := slices.ContainsFunc(listParams, func(p compiler.Param) bool { return p.Equal(compiler.TextParam(string(alice))) })
	if !hasPending || !hasAmount || !hasOwner {
		t.Fatalf("parameters missing normalized filter values: %#v", listParams)
	}
	if !strings.Contains(listSQL, ` AND ((r."status" = CAST(`) || !strings.Contains(listSQL, `r."owner_id" = CAST(`) {
		t.Fatalf("filter SQL not wrapped or missing owner_id: %s", listSQL)
	}

	calls = nil
	detailIntSQL, detailIntParams, err := gw.BuildDetailSQLForTest(plan, core.Key{Kind: core.KeyInteger, Value: "9007199254740993"}, tx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(calls, []string{"integer"}) || !strings.Contains(detailIntSQL, `r."id" = CAST(`) || !strings.Contains(detailIntSQL, `AS int8) LIMIT 1`) {
		t.Fatalf("unexpected integer Detail SQL/calls: calls=%v sql=%s params=%#v", calls, detailIntSQL, detailIntParams)
	}

	calls = nil
	detailUUIDSQL, detailUUIDParams, err := gw.BuildDetailSQLForTest(sitePlan, core.Key{Kind: core.KeyUUID, Value: "D97EECC9-8F23-4A76-A9AA-82B9D4EF33AC"}, tx)
	if err != nil {
		t.Fatal(err)
	}
	hasCanonicalSiteID := slices.ContainsFunc(detailUUIDParams, func(p compiler.Param) bool {
		return p.Equal(compiler.TextParam("d97eecc9-8f23-4a76-a9aa-82b9d4ef33ac"))
	})
	if !slices.Equal(calls, []string{"uuid"}) || !hasCanonicalSiteID || !strings.Contains(detailUUIDSQL, `AS uuid) LIMIT 1`) {
		t.Fatalf("unexpected UUID Detail SQL/calls: calls=%v sql=%s params=%#v", calls, detailUUIDSQL, detailUUIDParams)
	}

	calls = nil
	detailTagSQL, detailTagParams, err := gw.BuildDetailSQLForTest(tagPlan, core.Key{Kind: core.KeyString, Value: "plain"}, tx)
	if err != nil {
		t.Fatal(err)
	}
	hasTagKey := slices.ContainsFunc(detailTagParams, func(p compiler.Param) bool {
		return p.Equal(compiler.TextParam("plain"))
	})
	if !slices.Equal(calls, []string{"string"}) || !hasTagKey || !strings.Contains(detailTagSQL, `r."code" = CAST(`) || !strings.Contains(detailTagSQL, `AS text) LIMIT 1`) {
		t.Fatalf("unexpected string Detail SQL/calls: calls=%v sql=%s params=%#v", calls, detailTagSQL, detailTagParams)
	}

	_, err = gw.List(plan, gateway.ListQuery{
		Filter: gateway.CompareFilter{Op: core.OpLte, Field: "amount", Value: core.BoolValue(true)},
	}, tx)
	if !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("expected ErrInvalidRequest for invalid filter value, got %v", err)
	}
	if _, err := gw.List(plan, gateway.ListQuery{
		Filter: gateway.CompareFilter{Op: core.OpLt, Field: "ownerId", Value: core.TextValue(string(alice))},
	}, tx); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("expected ErrInvalidRequest for ordered comparison on UUID field, got %v", err)
	}
}

type foreignFilter struct{ gateway.Filter }

func TestGatewayGuardsLimitsAndFilterParenthesization(t *testing.T) {
	c, err := core.New(values.Codecs())
	if err != nil {
		t.Fatal(err)
	}
	d, err := c.Validate(declarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	reg, err := compiler.NewRegistry(c, d, storageBindings())
	if err != nil {
		t.Fatal(err)
	}
	gw, err := gateway.New(reg)
	if err != nil {
		t.Fatal(err)
	}

	plan := issuePlan(t, c, d)
	tx := &database.Tx{Mode: database.ModeRead, Revision: plan.Revision()}

	// Revision mismatch and unissued plans must fail with a non-400 error (503).
	badTx := &database.Tx{Mode: database.ModeRead, Revision: "2"}
	if _, err := gw.List(plan, gateway.ListQuery{}, badTx); err == nil || errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("expected non-ErrInvalidRequest on revision mismatch, got %v", err)
	}
	if _, err := gw.Count(plan, gateway.CountQuery{}, badTx); err == nil || errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("expected non-ErrInvalidRequest on Count revision mismatch, got %v", err)
	}
	if _, err := gw.Detail(plan, core.Key{Kind: core.KeyInteger, Value: "1"}, badTx); err == nil || errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("expected non-ErrInvalidRequest on Detail revision mismatch, got %v", err)
	}
	copied := *plan
	if _, err := gw.List(&copied, gateway.ListQuery{}, tx); err == nil || errors.Is(err, apperror.ErrInvalidRequest) {
		t.Fatalf("expected non-ErrInvalidRequest on copied plan, got %v", err)
	}

	// OR filter must be parenthesized as AND ((... OR ...)) so it cannot escape the plan predicate.
	countSQL, _, err := gw.BuildCountSQLForTest(plan, gateway.CountQuery{
		Filter: gateway.LogicalFilter{
			Op: core.OpOr,
			Args: []gateway.Filter{
				gateway.CompareFilter{Op: core.OpEq, Field: "status", Value: core.TextValue("pending")},
				gateway.IsNullFilter{Field: "title"},
			},
		},
	}, tx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(countSQL, ` AND ((r."status" = CAST(`) || !strings.Contains(countSQL, ` OR r."title" IS NULL))`) {
		t.Fatalf("OR filter was not parenthesized inside AND (...): %s", countSQL)
	}

	// OrderBy and Direction (SortAsc / SortDesc) include deterministic key tie-breaker.
	ascSQL, _, err := gw.BuildListSQLForTest(plan, gateway.ListQuery{
		OrderBy:   "amount",
		Direction: gateway.SortAsc,
	}, tx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ascSQL, `OVER (ORDER BY r."amount" asc, r."id" asc)`) {
		t.Fatalf("expected ascending OrderBy with key tie-breaker, got: %s", ascSQL)
	}
	descSQL, _, err := gw.BuildListSQLForTest(plan, gateway.ListQuery{
		OrderBy:   "amount",
		Direction: gateway.SortDesc,
	}, tx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(descSQL, `OVER (ORDER BY r."amount" desc, r."id" desc)`) {
		t.Fatalf("expected descending OrderBy with key tie-breaker, got: %s", descSQL)
	}

	// Bounds checks on Limit, Offset, OrderBy, Direction, Filter nodes.
	for name, q := range map[string]gateway.ListQuery{
		"limit 0":              {Limit: gateway.Limit(0)},
		"limit 101":            {Limit: gateway.Limit(101)},
		"offset -1":            {Offset: -1},
		"offset 10001":         {Offset: 10_001},
		"unprojected orderBy":  {OrderBy: "priority"},
		"unknown orderBy":      {OrderBy: "missing"},
		"invalid direction":    {Direction: "sideways"},
		"unprojected filter":   {Filter: gateway.CompareFilter{Op: core.OpEq, Field: "priority", Value: core.TextValue("1")}},
		"foreign filter":       {Filter: foreignFilter{}},
		"empty logical filter": {Filter: gateway.LogicalFilter{Op: core.OpAnd}},
		"unknown compare op":   {Filter: gateway.CompareFilter{Op: "like", Field: "status", Value: core.TextValue("a")}},
	} {
		if _, err := gw.List(plan, q, tx); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: expected ErrInvalidRequest, got %v", name, err)
		}
	}

	// Exactly 32 filter nodes (1 LogicalFilter + 31 CompareFilters) is allowed; 33 is rejected.
	args31 := make([]gateway.Filter, 31)
	for i := range args31 {
		args31[i] = gateway.CompareFilter{Op: core.OpEq, Field: "status", Value: core.TextValue("pending")}
	}
	if _, _, err := gw.BuildListSQLForTest(plan, gateway.ListQuery{
		Limit:  gateway.Limit(100),
		Offset: 10_000,
		Filter: gateway.LogicalFilter{Op: core.OpAnd, Args: args31},
	}, tx); err != nil {
		t.Errorf("expected 32 filter nodes with max limit/offset to succeed, got %v", err)
	}
	args32 := append(slices.Clone(args31), gateway.CompareFilter{Op: core.OpEq, Field: "status", Value: core.TextValue("pending")})
	if _, err := gw.List(plan, gateway.ListQuery{
		Filter: gateway.LogicalFilter{Op: core.OpAnd, Args: args32},
	}, tx); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("expected 33 filter nodes to fail with ErrInvalidRequest, got %v", err)
	}
}
