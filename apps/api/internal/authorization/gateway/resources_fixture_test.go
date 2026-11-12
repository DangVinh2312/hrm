//go:build integration

package gateway_test

import (
	"fmt"
	"testing"

	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/values"
)

const (
	bob   core.IdentityID = "b0000000-0000-4000-8000-000000000002"
	carol core.IdentityID = "c0000000-0000-4000-8000-000000000003"

	pastInstant    = "2020-01-01T00:00:00.000000Z"
	expiredInstant = "2021-01-01T00:00:00.000000Z"
	futureInstant  = "2099-01-01T00:00:00.000000Z"

	angstromUpper = "\xc3\x85ngstr\xc3\xb6m"
	angstromLower = "\xc3\xa5ngstr\xc3\xb6m"
	alphaTagCode  = "\xce\xb1-tag"
)

var integrationCore = mustNewIntegrationCore()

func mustNewIntegrationCore() *core.Core {
	c, err := core.New(values.Codecs())
	if err != nil {
		panic(err)
	}
	return c
}

func fullDeclarationsSource() core.SystemDeclarations {
	baseline := core.RelationRef{Key: "baseline", Version: 1}
	approval := core.RelationRef{Key: "approval", Version: 1}
	readAct := core.ActionDeclaration{Policy: baseline, Boundary: core.BoundaryOptional}
	principalID := core.CompareExpr{
		Op:    core.OpEq,
		Field: "identityId",
		Value: core.ValueRef{From: core.SourcePrincipal, Name: "id"},
	}
	tmpl := func(key, res string, expr core.Expr, params map[string]core.FieldKind) core.ScopeTemplate {
		if params == nil {
			params = map[string]core.FieldKind{}
		}
		return core.ScopeTemplate{Key: key, Version: 1, Resource: res, Parameters: params, Expression: expr}
	}
	return core.SystemDeclarations{
		Resources: []core.ResourceDeclaration{
			{
				Key:     "submission",
				KeyKind: core.KeyInteger,
				Fields: map[string]core.FieldType{
					"status":      {Kind: core.FieldString},
					"amount":      {Kind: core.FieldDecimal},
					"title":       {Kind: core.FieldString, Nullable: true},
					"priority":    {Kind: core.FieldInteger, Nullable: true},
					"submittedAt": {Kind: core.FieldTimestamp},
					"archived":    {Kind: core.FieldBoolean},
				},
				Actions: map[string]core.ActionDeclaration{
					"read":    readAct,
					"approve": {Policy: approval, Boundary: core.BoundaryOptional},
				},
			},
			{
				Key:     "site",
				KeyKind: core.KeyUUID,
				Fields:  map[string]core.FieldType{"name": {Kind: core.FieldString}},
				Actions: map[string]core.ActionDeclaration{"read": readAct},
			},
			{
				Key:     "tag",
				KeyKind: core.KeyString,
				Fields:  map[string]core.FieldType{"label": {Kind: core.FieldString}},
				Actions: map[string]core.ActionDeclaration{"read": readAct},
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
			{
				Key: "baseline", Version: 1,
				ContextRequirements: []core.ContextRequirement{},
				RequiredScope:       core.ConstantExpr{Value: true},
				Obligations:         []core.Obligation{},
			},
			{
				Key: "approval", Version: 1,
				ContextRequirements: []core.ContextRequirement{},
				RequiredScope: core.CompareExpr{
					Op:    core.OpEq,
					Field: "status",
					Value: core.ValueRef{From: core.SourceLiteral, Literal: core.TextValue("pending")},
				},
				Obligations: []core.Obligation{},
			},
		},
		Templates: []core.ScopeTemplate{
			tmpl("all", "submission", core.ConstantExpr{Value: true}, nil),
			tmpl("allSites", "site", core.ConstantExpr{Value: true}, nil),
			tmpl("allTags", "tag", core.ConstantExpr{Value: true}, nil),
			tmpl("tagLabel", "tag", core.CompareExpr{
				Op: core.OpEq, Field: "label", Value: core.ValueRef{From: core.SourceParameter, Name: "label"},
			}, map[string]core.FieldKind{"label": core.FieldString}),
			tmpl("assignedToMe", "submission", core.ExistsExpr{Relation: "submission.assignee@1", Where: principalID}, nil),
			tmpl("managedSite", "submission", core.ExistsExpr{
				Relation: "submission.site@1",
				Where:    core.ExistsExpr{Relation: "site.manager@1", Where: principalID},
			}, nil),
			tmpl("mySites", "site", core.ExistsExpr{Relation: "site.manager@1", Where: principalID}, nil),
			tmpl("statusIs", "submission", core.CompareExpr{
				Op: core.OpEq, Field: "status", Value: core.ValueRef{From: core.SourceParameter, Name: "status"},
			}, map[string]core.FieldKind{"status": core.FieldString}),
			tmpl("amountAtMost", "submission", core.CompareExpr{
				Op: core.OpLte, Field: "amount", Value: core.ValueRef{From: core.SourceParameter, Name: "limit"},
			}, map[string]core.FieldKind{"limit": core.FieldDecimal}),
			tmpl("priorityBelow", "submission", core.CompareExpr{
				Op: core.OpLt, Field: "priority", Value: core.ValueRef{From: core.SourceParameter, Name: "limit"},
			}, map[string]core.FieldKind{"limit": core.FieldInteger}),
			tmpl("titleIs", "submission", core.CompareExpr{
				Op: core.OpEq, Field: "title", Value: core.ValueRef{From: core.SourceParameter, Name: "title"},
			}, map[string]core.FieldKind{"title": core.FieldString}),
			tmpl("titleBefore", "submission", core.CompareExpr{
				Op: core.OpLt, Field: "title", Value: core.ValueRef{From: core.SourceParameter, Name: "title"},
			}, map[string]core.FieldKind{"title": core.FieldString}),
			tmpl("untitled", "submission", core.IsNullExpr{Field: "title"}, nil),
			tmpl("submittedBefore", "submission", core.CompareExpr{
				Op: core.OpLt, Field: "submittedAt", Value: core.ValueRef{From: core.SourceParameter, Name: "at"},
			}, map[string]core.FieldKind{"at": core.FieldTimestamp}),
			tmpl("notArchived", "submission", core.CompareExpr{
				Op: core.OpEq, Field: "archived", Value: core.ValueRef{From: core.SourceLiteral, Literal: core.BoolValue(false)},
			}, nil),
			tmpl("pendingOrCheap", "submission", core.LogicalExpr{
				Op: core.OpOr,
				Args: []core.Expr{
					core.CompareExpr{Op: core.OpEq, Field: "status", Value: core.ValueRef{From: core.SourceLiteral, Literal: core.TextValue("pending")}},
					core.CompareExpr{Op: core.OpLte, Field: "amount", Value: core.ValueRef{From: core.SourceLiteral, Literal: core.TextValue("0.5")}},
				},
			}, nil),
		},
		Boundaries:   []core.PermissionBoundary{},
		Capabilities: core.Capabilities{Validators: []string{}, ObligationHandlers: []string{}},
	}
}

func fixtureDeclarations(t *testing.T) *core.ValidatedDeclarations {
	t.Helper()
	d, err := integrationCore.Validate(fullDeclarationsSource())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func fullStorageBindings() compiler.StorageBindings {
	return compiler.StorageBindings{
		Resources: []compiler.ResourceBinding{
			{
				Resource: "submission", Table: "submission", ObjectIDColumn: "object_id", KeyColumn: "id",
				Columns: map[string]string{
					"status": "status", "amount": "amount", "title": "title",
					"priority": "priority", "submittedAt": "submitted_at", "archived": "archived",
				},
				Projection: []string{"status", "amount", "title", "priority", "submittedAt", "archived"},
			},
			{
				Resource: "site", Table: "site", ObjectIDColumn: "object_id", KeyColumn: "id",
				Columns: map[string]string{"name": "name"}, Projection: []string{"name"},
			},
			{
				Resource: "tag", Table: "tag", ObjectIDColumn: "object_id", KeyColumn: "code",
				Columns: map[string]string{"label": "label"}, Projection: []string{"label"},
			},
		},
		Domains: map[string]compiler.DomainRelationBinding{
			"siteManagers": {
				Table: "site_manager", SourceColumn: "site_id", TargetColumn: "user_id",
				StartsColumn: "starts_at", ExpiresColumn: "expires_at",
			},
		},
	}
}

type relationAssignment struct {
	identity  core.IdentityID
	startsAt  string
	expiresAt *string
}

type submissionRow struct {
	id           string
	objectID     string
	status       string
	amount       string
	title        *string
	priority     *string
	submittedAt  string
	archived     bool
	internalNote string
	sites        []string
	assignees    []relationAssignment
}

type siteRow struct {
	id       string
	objectID string
	name     string
	managers []relationAssignment
}

type tagRow struct {
	code     string
	objectID string
	label    string
}

type productFixture struct {
	sites       []siteRow
	submissions []submissionRow
	tags        []tagRow
	exceptions  []core.ExceptionFact
}

func strPtr(s string) *string { return &s }

func objUUID(n int) string {
	return fmt.Sprintf("c0000000-0000-4000-8000-%012d", n)
}

func buildProductFixture() productFixture {
	siteA := siteRow{
		id: "d97eecc9-8f23-4a76-a9aa-82b9d4ef33ac", objectID: objUUID(1), name: "Product site A",
		managers: []relationAssignment{
			{identity: alice, startsAt: pastInstant},
			{identity: carol, startsAt: pastInstant},
		},
	}
	siteB := siteRow{
		id: "5e0c2f1e-3b7a-4c1d-9f0e-1a2b3c4d5e6f", objectID: objUUID(2), name: "Product site B",
		managers: []relationAssignment{
			{identity: bob, startsAt: pastInstant},
			{identity: alice, startsAt: pastInstant, expiresAt: strPtr(expiredInstant)},
			{identity: carol, startsAt: pastInstant},
		},
	}
	sub := func(n int, id string, mutate func(*submissionRow)) submissionRow {
		r := submissionRow{
			id: id, objectID: objUUID(n), status: "pending", amount: "1",
			title: strPtr("Product #" + id), submittedAt: "2026-01-01T00:00:00.000000Z",
			internalNote: "Product internal " + id,
		}
		mutate(&r)
		return r
	}
	exc := func(objectID string, effect core.Effect, subject core.RuleSubject, mutate func(*core.ExceptionFact)) core.ExceptionFact {
		f := core.ExceptionFact{
			ObjectID: objectID, Permission: "submission.read", Subject: subject,
			Effect: effect, Purpose: core.PurposeManual, StartsAt: pastInstant,
		}
		if mutate != nil {
			mutate(&f)
		}
		return f
	}
	aliceSubj := core.RuleSubject{Kind: core.SubjectIdentity, Identity: alice}
	return productFixture{
		sites: []siteRow{siteA, siteB},
		submissions: []submissionRow{
			sub(10, "1", func(r *submissionRow) {
				r.amount, r.title, r.priority = "100.10", strPtr("Alpha"), strPtr("1")
				r.sites = []string{siteA.id}
				r.assignees = []relationAssignment{{identity: alice, startsAt: pastInstant}}
			}),
			sub(11, "2", func(r *submissionRow) {
				r.status, r.amount, r.title = "approved", "100.1000", strPtr(angstromUpper)
				r.sites = []string{siteB.id}
			}),
			sub(12, "9007199254740993", func(r *submissionRow) {
				r.amount, r.title, r.priority = "0.0001", strPtr(`O'Reilly "quoted"`), strPtr("5")
				r.sites = []string{siteA.id, siteB.id}
				r.assignees = []relationAssignment{{identity: alice, startsAt: pastInstant}}
				r.submittedAt = "2025-06-01T12:00:00.123456Z"
			}),
			sub(13, "9007199254740992", func(r *submissionRow) {
				r.amount, r.title, r.priority, r.archived = "99999999.9999", nil, strPtr("2"), true
			}),
			sub(14, "5", func(r *submissionRow) {
				r.status, r.amount, r.title, r.priority = "rejected", "-3.5", strPtr("'; DROP TABLE submission; --"), strPtr("3")
				r.sites = []string{siteA.id}
				r.assignees = []relationAssignment{{identity: bob, startsAt: pastInstant}}
			}),
			sub(15, "6", func(r *submissionRow) {
				r.amount, r.title = "100.10", strPtr("Alpha")
				r.assignees = []relationAssignment{{identity: alice, startsAt: pastInstant, expiresAt: strPtr(expiredInstant)}}
			}),
			sub(16, "7", func(r *submissionRow) {
				r.title = strPtr(angstromLower)
				r.assignees = []relationAssignment{{identity: alice, startsAt: futureInstant}}
				r.submittedAt = "2026-03-01T00:00:00.000000Z"
			}),
			sub(17, "8", func(r *submissionRow) {
				r.status, r.amount, r.title = "approved", "0.5", strPtr("Zeta")
				r.sites = []string{siteB.id}
			}),
		},
		tags: []tagRow{
			{code: alphaTagCode, objectID: objUUID(30), label: "Greek"},
			{code: "x' OR '1'='1", objectID: objUUID(31), label: "Injection"},
			{code: "plain", objectID: objUUID(32), label: "Plain"},
		},
		exceptions: []core.ExceptionFact{
			exc(objUUID(11), core.EffectAllow, aliceSubj, nil),
			exc(objUUID(12), core.EffectDeny, aliceSubj, nil),
			exc(objUUID(17), core.EffectAllow, core.RuleSubject{Kind: core.SubjectRole, Role: "custom.reviewer"}, nil),
			exc(objUUID(13), core.EffectAllow, aliceSubj, func(f *core.ExceptionFact) { f.ExpiresAt = strPtr(expiredInstant) }),
			exc(objUUID(15), core.EffectAllow, aliceSubj, func(f *core.ExceptionFact) { f.RevokedAt = strPtr(pastInstant) }),
			exc(objUUID(16), core.EffectAllow, aliceSubj, func(f *core.ExceptionFact) {
				f.Purpose = core.PurposeEmergency
				f.ExpiresAt = strPtr(futureInstant)
			}),
			exc(objUUID(14), core.EffectAllow, aliceSubj, func(f *core.ExceptionFact) { f.Permission = "submission.approve" }),
		},
	}
}
