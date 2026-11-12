package declarations

import (
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/keys"
)

func templates() []core.ScopeTemplate {
	return []core.ScopeTemplate{
		{Key: string(keys.AccountTemplateAllAccounts), Version: 1, Resource: string(keys.AccountResourceAccount), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.EmployeeTemplateAllEmployees), Version: 1, Resource: string(keys.EmployeeResourceEmployee), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.EmployeeTemplateAllIdentities), Version: 1, Resource: string(keys.EmployeeResourceEmployeeIdentity), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.EmployeeTemplateAllLeaveRates), Version: 1, Resource: string(keys.EmployeeResourceLeaveRate), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.WorkRequestTemplateAllRequests), Version: 1, Resource: string(keys.WorkRequestResourceWorkRequest), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.TeamTemplateAllTeams), Version: 1, Resource: string(keys.TeamResourceTeam), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.WorkCalendarTemplateCalendar), Version: 1, Resource: string(keys.WorkCalendarResourceWorkCalendar), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.CompanyTemplateCompany), Version: 1, Resource: string(keys.CompanyResourceCompany), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.WorkRequestTemplateDecidedRequests), Version: 1, Resource: string(keys.WorkRequestResourceWorkRequest), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.WorkRequestRelationRequestDecider) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.WorkRequestTemplateFinalQueue), Version: 1, Resource: string(keys.WorkRequestResourceWorkRequest), Parameters: map[string]core.FieldKind{}, Expression: core.CompareExpr{Op: "eq", Field: "state", Value: core.ValueRef{From: "literal", Literal: core.TextValue("pending_final")}}},
		{Key: string(keys.WorkRequestTemplateLeadRejectedLeadRequests), Version: 1, Resource: string(keys.WorkRequestResourceWorkRequest), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.WorkRequestRelationRequestLeadRejectedLeadOwned) + "@1", Where: core.ConstantExpr{Value: true}}},
		{Key: string(keys.EmployeeTemplateLedEmployees), Version: 1, Resource: string(keys.EmployeeResourceEmployee), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.EmployeeRelationEmployeeLead) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.WorkRequestTemplateLedRequests), Version: 1, Resource: string(keys.WorkRequestResourceWorkRequest), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.WorkRequestRelationRequestLead) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.TeamTemplateLedTeams), Version: 1, Resource: string(keys.TeamResourceTeam), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.TeamRelationTeamLead) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.TeamTemplateMemberTeams), Version: 1, Resource: string(keys.TeamResourceTeam), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.TeamRelationTeamMember) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.WorkRequestTemplateOwnRequests), Version: 1, Resource: string(keys.WorkRequestResourceWorkRequest), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.WorkRequestRelationRequestOwner) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.DocumentTemplateOwnedDocuments), Version: 1, Resource: string(keys.DocumentResourceDocument), Parameters: map[string]core.FieldKind{}, Expression: core.CompareExpr{Op: "eq", Field: "ownerId", Value: core.ValueRef{From: "principal", Name: "id"}}},
		{Key: string(keys.RoleTemplateRole), Version: 1, Resource: string(keys.RoleResourceRole), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
		{Key: string(keys.EmployeeTemplateSelfEmployee), Version: 1, Resource: string(keys.EmployeeResourceEmployee), Parameters: map[string]core.FieldKind{}, Expression: core.CompareExpr{Op: "eq", Field: "accountId", Value: core.ValueRef{From: "principal", Name: "id"}}},
		{Key: string(keys.EmployeeTemplateSelfIdentity), Version: 1, Resource: string(keys.EmployeeResourceEmployeeIdentity), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.EmployeeRelationEmployeeIdentityOwner) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.EmployeeTemplateSelfLeaveRates), Version: 1, Resource: string(keys.EmployeeResourceLeaveRate), Parameters: map[string]core.FieldKind{}, Expression: core.ExistsExpr{Relation: string(keys.EmployeeRelationLeaveRateOwner) + "@1", Where: core.CompareExpr{Op: "eq", Field: "identityId", Value: core.ValueRef{From: "principal", Name: "id"}}}},
		{Key: string(keys.SettingTemplateSetting), Version: 1, Resource: string(keys.SettingResourceSetting), Parameters: map[string]core.FieldKind{}, Expression: core.ConstantExpr{Value: true}},
	}
}
