package compiler

import (
	"errors"
	"fmt"

	"hrm/api/internal/authorization/core"
)

func (c expressionCompiler) compare(n core.PlanCompare, current Scope) (string, error) {
	col, err := c.column(current, n.Field)
	if err != nil {
		return "", err
	}
	if resScope, isRes := current.(ResourceScope); isRes {
		declared, ok := c.registry.Declarations().Resource(resScope.Binding.Resource)
		if !ok {
			return "", fmt.Errorf("unknown resource %s", resScope.Binding.Resource)
		}
		field, hasField := declared.Fields[n.Field]
		if !hasField || field.Kind != n.Kind {
			return "", fmt.Errorf("plan field kind mismatch on %s.%s", resScope.Binding.Resource, n.Field)
		}
	}
	var op string
	switch n.Op {
	case core.OpEq:
		op = "="
	case core.OpLt:
		op = "<"
	case core.OpLte:
		op = "<="
	default:
		return "", fmt.Errorf("unsupported comparison operator %q", n.Op)
	}
	pgType, ok := FieldPgType(n.Kind)
	if !ok {
		return "", fmt.Errorf("unsupported field kind %q", n.Kind)
	}
	var param Param
	if n.Kind == core.FieldBoolean {
		b, valid := n.Value.AsBool()
		if !valid {
			return "", errors.New("boolean compare requires a boolean scalar")
		}
		param = BoolParam(b)
	} else {
		s, valid := n.Value.AsText()
		if !valid {
			return "", errors.New("scalar compare requires a text scalar")
		}
		param = TextParam(s)
	}
	collate := ""
	if n.Kind == core.FieldString && n.Op != core.OpEq {
		collate = ` COLLATE "C"`
	}
	return fmt.Sprintf("%s%s %s %s", col, collate, op, c.bind(param, pgType)), nil
}
