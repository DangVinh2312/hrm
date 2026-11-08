package core

import (
	"errors"
	"slices"
	"strings"
)

type valueResolver func(ref ValueRef, kind FieldKind) (Scalar, error)

// binder resolves a value of the declaration AST. A nil parameters map resolves no parameter, which is
// what a required scope gets.
func (c *Core) binder(principal TrustedPrincipal, context, parameters map[string]Scalar) valueResolver {
	return func(ref ValueRef, kind FieldKind) (Scalar, error) {
		var value FieldValue
		found := false
		switch ref.From {
		case SourceLiteral:
			value, found = ref.Literal, true
		case SourcePrincipal:
			value, found = TextValue(string(principal.ID)), ref.Name == "id"
		case SourceContext:
			var scalar Scalar
			scalar, found = context[ref.Name]
			value = Value(scalar)
		case SourceParameter:
			var scalar Scalar
			scalar, found = parameters[ref.Name]
			value = Value(scalar)
		}
		unresolved := deny("unresolved_value:" + string(ref.From))
		if !found {
			return Scalar{}, unresolved
		}
		scalar, err := c.NormalizeValue(kind, value)
		if errors.Is(err, ErrInvalidValue) {
			return Scalar{}, unresolved
		}
		return scalar, err
	}
}

// uniqueSorted never returns nil: a plan's role list reaches SQL as an array bind, where NULL is not empty.
func uniqueSorted(items []string) []string {
	sorted := append([]string{}, items...)
	slices.Sort(sorted)
	return slices.Compact(sorted)
}

// applicableRules keeps the rules of this permission for an assigned role or this identity. A subject of
// an unknown kind denies instead of being skipped, because the rule could be a deny.
func applicableRules(target resolvedTarget, snapshot AuthoritySnapshot, roles []string) ([]RuleFact, error) {
	var applicable []RuleFact
	for _, rule := range snapshot.Rules {
		if rule.Permission != target.permissionKey {
			continue
		}
		var applies bool
		switch rule.Subject.Kind {
		case SubjectRole:
			applies = slices.Contains(roles, rule.Subject.Role)
		case SubjectIdentity:
			applies = rule.Subject.Identity == target.principal.ID
		default:
			return nil, deny("unknown_subject")
		}
		if applies {
			applicable = append(applicable, rule)
		}
	}
	if len(applicable) > target.declarations.limits.MaxRules {
		return nil, deny("too_many_rules")
	}
	return applicable, nil
}

func sameKeys[A, B any](left map[string]A, right map[string]B) bool {
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if _, ok := right[key]; !ok {
			return false
		}
	}
	return true
}

// lowerRules lowers every applicable rule. One broken rule denies the whole decision.
func (c *Core) lowerRules(target resolvedTarget, input TrustedInput, rules []RuleFact, tables declarationTables) (allows, denies []PlanExpr, err error) {
	for _, rule := range rules {
		template, known := target.declarations.templates[rule.Template.String()]
		if !known {
			return nil, nil, deny("unknown_template")
		}
		if template.Resource != target.resource.Key {
			return nil, nil, deny("template_resource_mismatch")
		}
		if !sameKeys(template.Parameters, rule.Parameters) {
			return nil, nil, deny("rule_parameters_mismatch")
		}
		if rule.Effect != EffectAllow && rule.Effect != EffectDeny {
			return nil, nil, deny("unknown_effect")
		}
		if rule.Effect == EffectDeny && !isDenySafe(template.Expression, target.resource.Fields) {
			return nil, nil, deny("unsafe_deny_template")
		}
		resolve := c.binder(target.principal, input.Context, rule.Parameters)
		lowered, err := lowerExpr(template.Expression, target.resource.Key, target.resource.Fields, tables, resolve)
		if err != nil {
			return nil, nil, err
		}
		if rule.Effect == EffectAllow {
			allows = append(allows, lowered)
		} else {
			denies = append(denies, lowered)
		}
	}
	return allows, denies, nil
}

func (c *Core) planUser(input TrustedInput, snapshot AuthoritySnapshot) (*AuthorizedPlan, error) {
	target, err := c.resolveTarget(input, snapshot)
	if err != nil {
		return nil, err
	}
	policy, err := resolvePolicy(target)
	if err != nil {
		return nil, err
	}
	if err := requireContext(snapshot, target.principal, input.Context, policy.ContextRequirements); err != nil {
		return nil, err
	}
	entry, err := resolveBoundary(target, snapshot, input.Context)
	if err != nil {
		return nil, err
	}
	for _, obligation := range policy.Obligations {
		if !slices.Contains(snapshot.Registry.ObligationHandlers, obligation.Handler) {
			return nil, deny("obligation_handler_unavailable")
		}
	}
	roles := uniqueSorted(snapshot.Roles)
	rules, err := applicableRules(target, snapshot, roles)
	if err != nil {
		return nil, err
	}
	tables := declarationTables{resources: target.declarations.resources, relations: target.declarations.relations}
	allows, denies, err := c.lowerRules(target, input, rules, tables)
	if err != nil {
		return nil, err
	}
	resolve := c.binder(target.principal, input.Context, nil)
	required, err := lowerExpr(policy.RequiredScope, target.resource.Key, target.resource.Fields, tables, resolve)
	if err != nil {
		return nil, err
	}
	var boundaryScope PlanExpr = PlanConstant{Value: true}
	if entry != nil {
		boundaryScope, err = lowerExpr(entry.RequiredScope, target.resource.Key, target.resource.Fields, tables, resolve)
		if err != nil {
			return nil, err
		}
	}
	exception := func(effect Effect) PlanExpr {
		return PlanException{Effect: effect, Permission: target.permissionKey, Identity: target.principal.ID, Roles: slices.Clone(roles)}
	}
	predicate := simplify(PlanLogical{Op: OpAnd, Args: []PlanExpr{
		required,
		boundaryScope,
		PlanLogical{Op: OpOr, Args: append(allows, exception(EffectAllow))},
		PlanNot{Arg: PlanLogical{Op: OpOr, Args: append(denies, exception(EffectDeny))}},
	}})
	return c.issue(target.resource.Key, input.Action, target.permissionKey, snapshot.Revision, target.principal.ID,
		target.validUntil, predicate, slices.Clone(policy.Obligations)), nil
}

func (c *Core) planUnrestricted(input TrustedInput, snapshot AuthoritySnapshot) (*AuthorizedPlan, error) {
	target, err := c.resolveTarget(input, snapshot)
	if err != nil {
		return nil, err
	}
	policy, err := resolvePolicy(target)
	if err != nil {
		return nil, err
	}
	if err := requireContext(snapshot, target.principal, input.Context, policy.ContextRequirements); err != nil {
		return nil, err
	}
	revision, err := c.CanonicalInt64(snapshot.Revision)
	if errors.Is(err, ErrInvalidValue) || (err == nil && (revision != snapshot.Revision || revision == "0" || strings.HasPrefix(revision, "-"))) {
		return nil, deny("invalid_revision")
	}
	if err != nil {
		return nil, err
	}
	return c.issue(target.resource.Key, input.Action, target.permissionKey, snapshot.Revision, target.principal.ID,
		target.validUntil, PlanConstant{Value: true}, []Obligation{}), nil
}
