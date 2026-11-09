package declarations

import (
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/keys"
)

func policies() []core.PermissionPolicy {
	return []core.PermissionPolicy{
		{Key: string(keys.WorkRequestPolicyApprovedFresh), Version: 1, ContextRequirements: []core.ContextRequirement{{Validator: string(keys.ProductValidatorFresh), Parameters: map[string]core.Scalar{}}}, RequiredScope: core.CompareExpr{Op: "eq", Field: "state", Value: core.ValueRef{From: "literal", Literal: core.TextValue("approved")}}, Obligations: []core.Obligation{}},
		{Key: string(keys.AccountPolicyAuditedRead), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.ConstantExpr{Value: true}, Obligations: []core.Obligation{{Handler: string(keys.ProductObligationAudit)}}},
		{Key: string(keys.DocumentPolicyEditable), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.CompareExpr{Op: "eq", Field: "state", Value: core.ValueRef{From: "literal", Literal: core.TextValue("draft")}}, Obligations: []core.Obligation{{Handler: string(keys.ProductObligationAudit)}}},
		{Key: string(keys.WorkRequestPolicyFinalStage), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.CompareExpr{Op: "eq", Field: "state", Value: core.ValueRef{From: "literal", Literal: core.TextValue("pending_final")}}, Obligations: []core.Obligation{}},
		{Key: string(keys.AccountPolicyFreshAuthentication), Version: 1, ContextRequirements: []core.ContextRequirement{{Validator: string(keys.ProductValidatorFresh), Parameters: map[string]core.Scalar{}}}, RequiredScope: core.ConstantExpr{Value: true}, Obligations: []core.Obligation{{Handler: string(keys.ProductObligationAudit)}}},
		{Key: string(keys.PermissionPolicyFresh), Version: 1, ContextRequirements: []core.ContextRequirement{{Validator: string(keys.ProductValidatorFresh), Parameters: map[string]core.Scalar{}}}, RequiredScope: core.ConstantExpr{Value: true}, Obligations: []core.Obligation{}},
		{Key: string(keys.PermissionPolicyRead), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.ConstantExpr{Value: true}, Obligations: []core.Obligation{}},
		{Key: string(keys.PermissionPolicySubmit), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.ConstantExpr{Value: true}, Obligations: []core.Obligation{}},
		{Key: string(keys.PermissionPolicyWrite), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.ConstantExpr{Value: true}, Obligations: []core.Obligation{}},
		{Key: string(keys.WorkRequestPolicyLeadStage), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.CompareExpr{Op: "eq", Field: "state", Value: core.ValueRef{From: "literal", Literal: core.TextValue("pending_lead")}}, Obligations: []core.Obligation{}},
		{Key: string(keys.WorkRequestPolicyPendingStage), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.LogicalExpr{Op: "or", Args: []core.Expr{core.CompareExpr{Op: "eq", Field: "state", Value: core.ValueRef{From: "literal", Literal: core.TextValue("pending_lead")}}, core.CompareExpr{Op: "eq", Field: "state", Value: core.ValueRef{From: "literal", Literal: core.TextValue("pending_final")}}}}, Obligations: []core.Obligation{}},
		{Key: string(keys.DocumentPolicyReadable), Version: 1, ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.ConstantExpr{Value: true}, Obligations: []core.Obligation{}},
	}
}
