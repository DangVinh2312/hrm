package core

import (
	"errors"
	"slices"
)

const reasonUnsupportedNode = "unsupported_plan_node"

// pathPosition is where a predicate reads its fields: an object, or an identity reached through a relation.
type pathPosition struct {
	object   *FactObject
	identity IdentityID
}

type evaluation struct {
	core  *Core
	facts CompleteFacts
	now   string
}

func (c *Core) evaluate(plan *AuthorizedPlan, facts CompleteFacts) (bool, error) {
	now, err := c.timestampOr(facts.Now, "invalid_now")
	if err != nil {
		return false, err
	}
	order, err := c.CompareValues(FieldTimestamp, Text(now), Text(plan.validUntil))
	if err != nil {
		return false, err
	}
	if order != Less {
		return false, deny("plan_expired")
	}
	if facts.Record.Type != plan.resource {
		return false, deny("resource_mismatch")
	}
	e := evaluation{core: c, facts: facts, now: now}
	return e.test(plan.predicate, pathPosition{object: &e.facts.Record})
}

func (e evaluation) test(expr PlanExpr, position pathPosition) (bool, error) {
	switch node := expr.(type) {
	case PlanConstant:
		return node.Value, nil
	case PlanLogical:
		return e.logical(node, position)
	case PlanNot:
		result, err := e.test(node.Arg, position)
		return !result, err
	case PlanIsNull:
		return e.isNull(node, position)
	case PlanCompare:
		return e.compare(node, position)
	case PlanExists:
		return e.exists(node, position)
	case PlanException:
		return e.exception(node)
	}
	return false, deny(reasonUnsupportedNode)
}

func (e evaluation) logical(node PlanLogical, position pathPosition) (bool, error) {
	if node.Op != OpAnd && node.Op != OpOr {
		return false, deny(reasonUnsupportedNode)
	}
	for _, arg := range node.Args {
		result, err := e.test(arg, position)
		if err != nil {
			return false, err
		}
		if result == (node.Op == OpOr) {
			return result, nil
		}
	}
	return node.Op == OpAnd, nil
}

func field(position pathPosition, name string) (FieldValue, error) {
	if position.object == nil {
		if name == "identityId" {
			return TextValue(string(position.identity)), nil
		}
		return FieldValue{}, deny("missing_fact")
	}
	value, known := position.object.Fields[name]
	if !known {
		return FieldValue{}, deny("missing_fact")
	}
	return value, nil
}

// isNull refuses the zero FieldValue instead of reading it as not NULL: under a deny that would open the record.
func (e evaluation) isNull(node PlanIsNull, position pathPosition) (bool, error) {
	value, err := field(position, node.Field)
	if err != nil {
		return false, err
	}
	if value.IsNull() {
		return true, nil
	}
	if value == (FieldValue{}) {
		return false, deny("invalid_fact")
	}
	return false, nil
}

// compare never matches NULL.
func (e evaluation) compare(node PlanCompare, position pathPosition) (bool, error) {
	if node.Op != OpEq && node.Op != OpLt && node.Op != OpLte {
		return false, deny(reasonUnsupportedNode)
	}
	raw, err := field(position, node.Field)
	if err != nil {
		return false, err
	}
	if raw.IsNull() {
		return false, nil
	}
	value, err := e.core.NormalizeValue(node.Kind, raw)
	if errors.Is(err, ErrInvalidValue) {
		return false, deny("invalid_" + string(node.Kind) + "_fact")
	}
	if err != nil {
		return false, err
	}
	order, err := e.core.CompareValues(node.Kind, value, node.Value)
	if err != nil {
		return false, err
	}
	switch node.Op {
	case OpEq:
		return order == Equal, nil
	case OpLt:
		return order == Less, nil
	case OpLte:
		return order != Greater, nil
	}
	return false, deny(reasonUnsupportedNode)
}

// active reads both instants before comparing either: a malformed one denies even when the other alone
// would rule the fact out, because that fact could be a deny.
func (e evaluation) active(startsAt string, expiresAt *string) (bool, error) {
	start, err := e.core.timestampOr(startsAt, "invalid_time")
	if err != nil {
		return false, err
	}
	var end string
	if expiresAt != nil {
		end, err = e.core.timestampOr(*expiresAt, "invalid_time")
		if err != nil {
			return false, err
		}
	}
	order, err := e.core.CompareValues(FieldTimestamp, Text(start), Text(e.now))
	if err != nil {
		return false, err
	}
	if order == Greater {
		return false, nil
	}
	if expiresAt == nil {
		return true, nil
	}
	order, err = e.core.CompareValues(FieldTimestamp, Text(end), Text(e.now))
	if err != nil {
		return false, err
	}
	return order == Greater, nil
}

// exists walks one step of a relation path. Depth is bounded by the plan, whose declaration passed the
// path limit, and each edge checks its relation, exact version, source, validity and target type.
func (e evaluation) exists(node PlanExists, position pathPosition) (bool, error) {
	if position.object == nil || position.object.Type != node.Source {
		return false, nil
	}
	if node.Target.Kind != RelationTargetResource && node.Target.Kind != RelationTargetIdentity {
		return false, deny(reasonUnsupportedNode)
	}
	for _, edge := range e.facts.Edges {
		if edge.Relation != node.Relation || edge.Source != position.object.ObjectID {
			continue
		}
		active, err := e.active(edge.StartsAt, edge.ExpiresAt)
		if err != nil {
			return false, err
		}
		if !active {
			continue
		}
		next, reached := e.edgeTarget(node.Target, edge.Target)
		if !reached {
			continue
		}
		matched, err := e.test(node.Where, next)
		if err != nil {
			return false, err
		}
		if matched {
			return true, nil
		}
	}
	return false, nil
}

func (e evaluation) edgeTarget(want RelationTarget, target EdgeTarget) (pathPosition, bool) {
	if want.Kind == RelationTargetIdentity {
		return pathPosition{identity: target.Identity}, target.Kind == EdgeTargetIdentity
	}
	if target.Kind != EdgeTargetObject {
		return pathPosition{}, false
	}
	index := slices.IndexFunc(e.facts.Objects, func(o FactObject) bool {
		return o.ObjectID == target.ObjectID && o.Type == want.Type
	})
	if index < 0 {
		return pathPosition{}, false
	}
	return pathPosition{object: &e.facts.Objects[index]}, true
}

// exception looks up record exceptions of the requested object. An exception of this object and permission
// with an unknown effect or subject denies: it could be a deny. Emergency allows never grant.
func (e evaluation) exception(node PlanException) (bool, error) {
	for _, fact := range e.facts.Exceptions {
		if fact.ObjectID != e.facts.Record.ObjectID || fact.Permission != node.Permission {
			continue
		}
		if fact.Effect != EffectAllow && fact.Effect != EffectDeny {
			return false, deny("invalid_exception")
		}
		var subjectMatches bool
		switch fact.Subject.Kind {
		case SubjectIdentity:
			subjectMatches = fact.Subject.Identity == node.Identity
		case SubjectRole:
			subjectMatches = slices.Contains(node.Roles, fact.Subject.Role)
		default:
			return false, deny("invalid_exception")
		}
		if fact.Effect != node.Effect || !subjectMatches || fact.RevokedAt != nil {
			continue
		}
		if fact.Effect == EffectAllow && fact.Purpose != PurposeManual {
			continue
		}
		active, err := e.active(fact.StartsAt, fact.ExpiresAt)
		if err != nil {
			return false, err
		}
		if active {
			return true, nil
		}
	}
	return false, nil
}
