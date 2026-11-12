package core

import (
	"maps"
	"slices"
)

func cloneExpr(expr Expr) Expr {
	switch node := expr.(type) {
	case ConstantExpr, CompareExpr, IsNullExpr:
		return node
	case LogicalExpr:
		args := make([]Expr, len(node.Args))
		for i, arg := range node.Args {
			args[i] = cloneExpr(arg)
		}
		return LogicalExpr{Op: node.Op, Args: args}
	case ExistsExpr:
		return ExistsExpr{Relation: node.Relation, Where: cloneExpr(node.Where)}
	}
	return nil
}

func clonePlanExpr(expr PlanExpr) PlanExpr {
	switch node := expr.(type) {
	case PlanConstant, PlanCompare, PlanIsNull:
		return node
	case PlanLogical:
		args := make([]PlanExpr, len(node.Args))
		for i, arg := range node.Args {
			args[i] = clonePlanExpr(arg)
		}
		return PlanLogical{Op: node.Op, Args: args}
	case PlanNot:
		return PlanNot{Arg: clonePlanExpr(node.Arg)}
	case PlanExists:
		node.Where = clonePlanExpr(node.Where)
		return node
	case PlanException:
		node.Roles = slices.Clone(node.Roles)
		return node
	}
	return nil
}

func cloneResource(resource ResourceDeclaration) ResourceDeclaration {
	resource.Fields = maps.Clone(resource.Fields)
	resource.Actions = maps.Clone(resource.Actions)
	return resource
}

func cloneRequirements(requirements []ContextRequirement) []ContextRequirement {
	cloned := make([]ContextRequirement, len(requirements))
	for i, requirement := range requirements {
		cloned[i] = ContextRequirement{Validator: requirement.Validator, Parameters: maps.Clone(requirement.Parameters)}
	}
	return cloned
}

func clonePolicy(policy PermissionPolicy) PermissionPolicy {
	policy.ContextRequirements = cloneRequirements(policy.ContextRequirements)
	policy.RequiredScope = cloneExpr(policy.RequiredScope)
	policy.Obligations = slices.Clone(policy.Obligations)
	return policy
}

func cloneTemplate(template ScopeTemplate) ScopeTemplate {
	template.Parameters = maps.Clone(template.Parameters)
	template.Expression = cloneExpr(template.Expression)
	return template
}

func cloneBoundary(boundary PermissionBoundary) PermissionBoundary {
	entries := make([]BoundaryEntry, len(boundary.Entries))
	for i, entry := range boundary.Entries {
		entries[i] = BoundaryEntry{
			Permission:          entry.Permission,
			ContextRequirements: cloneRequirements(entry.ContextRequirements),
			RequiredScope:       cloneExpr(entry.RequiredScope),
		}
	}
	boundary.Entries = entries
	return boundary
}
