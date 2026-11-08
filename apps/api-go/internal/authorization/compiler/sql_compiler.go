package compiler

import (
	"errors"
	"fmt"
	"strings"

	"hrm/api-go/internal/authorization/core"
)

func CompileExpression(
	expr core.PlanExpr,
	registry *Registry,
	scope Scope,
	bind BindFunc,
	nextAlias NextAliasFunc,
) (string, error) {
	if registry == nil || registry.Core() == nil || registry.Declarations() == nil {
		return "", errors.New("storage binding registry is required")
	}
	if bind == nil || nextAlias == nil {
		return "", errors.New("compiler callbacks are required")
	}
	if resScope, isRes := scope.(ResourceScope); isRes {
		if err := checkAlias(resScope.Alias); err != nil {
			return "", err
		}
	}
	c := expressionCompiler{registry: registry, bind: bind, nextAlias: nextAlias}
	return c.compile(expr, scope)
}

type expressionCompiler struct {
	registry  *Registry
	bind      BindFunc
	nextAlias NextAliasFunc
}

func (c expressionCompiler) compile(node core.PlanExpr, current Scope) (string, error) {
	switch n := node.(type) {
	case core.PlanConstant:
		if n.Value {
			return "TRUE", nil
		}
		return "FALSE", nil
	case core.PlanLogical:
		if (n.Op != core.OpAnd && n.Op != core.OpOr) || len(n.Args) == 0 {
			return "", fmt.Errorf("invalid logical operator %q", n.Op)
		}
		parts := make([]string, len(n.Args))
		for i, arg := range n.Args {
			part, err := c.compile(arg, current)
			if err != nil {
				return "", err
			}
			parts[i] = part
		}
		sep := " OR "
		if n.Op == core.OpAnd {
			sep = " AND "
		}
		return "(" + strings.Join(parts, sep) + ")", nil
	case core.PlanNot:
		if n.Arg == nil {
			return "", errors.New("plan not expression requires an operand")
		}
		inner, err := c.compile(n.Arg, current)
		if err != nil {
			return "", err
		}
		return "(NOT " + inner + ")", nil
	case core.PlanIsNull:
		col, err := c.column(current, n.Field)
		if err != nil {
			return "", err
		}
		return col + " IS NULL", nil
	case core.PlanCompare:
		return c.compare(n, current)
	case core.PlanExists:
		return c.exists(n, current)
	case core.PlanException:
		return c.exception(n, current)
	default:
		return "", fmt.Errorf("unsupported plan expression %T", node)
	}
}

func (c expressionCompiler) column(current Scope, field string) (string, error) {
	switch s := current.(type) {
	case IdentityScope:
		if field != "identityId" {
			return "", fmt.Errorf("unknown identity field %s", field)
		}
		if s.Column == "" {
			return "", errors.New("identity scope column is required")
		}
		return s.Column, nil
	case ResourceScope:
		if err := checkAlias(s.Alias); err != nil {
			return "", err
		}
		declared, ok := c.registry.Declarations().Resource(s.Binding.Resource)
		if !ok {
			return "", fmt.Errorf("unknown resource %s", s.Binding.Resource)
		}
		if _, hasField := declared.Fields[field]; !hasField {
			return "", fmt.Errorf("unknown field %s.%s", s.Binding.Resource, field)
		}
		name, ok := s.Binding.Columns[field]
		if !ok || name == "" {
			return "", fmt.Errorf("unknown field %s.%s", s.Binding.Resource, field)
		}
		quoted, err := QuoteIdentifier(name)
		if err != nil {
			return "", err
		}
		return s.Alias + "." + quoted, nil
	default:
		return "", errors.New("unsupported compilation scope")
	}
}

func (c expressionCompiler) exists(n core.PlanExists, current Scope) (string, error) {
	resScope, ok := current.(ResourceScope)
	if !ok || resScope.Binding.Resource != n.Source {
		return "", fmt.Errorf("relation %s does not start at this scope", n.Relation)
	}
	if err := checkAlias(resScope.Alias); err != nil {
		return "", err
	}
	relation, ok := c.registry.Declarations().Relation(n.Relation)
	if !ok {
		return "", fmt.Errorf("unknown relation %s", n.Relation)
	}
	outer := resScope.Alias
	src := resScope.Binding
	e := c.nextAlias("e")
	if err := checkAlias(e); err != nil {
		return "", err
	}
	if relation.Binding.Kind == core.BindingDomain {
		d, hasDomain := c.registry.Domain(n.Relation.String())
		if !hasDomain || n.Target.Kind != core.RelationTargetIdentity {
			return "", fmt.Errorf("relation %s has no usable domain binding", n.Relation)
		}
		window := ""
		if d.StartsColumn != "" && d.ExpiresColumn != "" {
			act, err := activeWindow(e, d.StartsColumn, d.ExpiresColumn)
			if err != nil {
				return "", err
			}
			window = " AND " + act
		}
		qTable, err := QuoteIdentifier(d.Table)
		if err != nil {
			return "", err
		}
		qSource, err := QuoteIdentifier(d.SourceColumn)
		if err != nil {
			return "", err
		}
		qKey, err := QuoteIdentifier(src.KeyColumn)
		if err != nil {
			return "", err
		}
		qTarget, err := QuoteIdentifier(d.TargetColumn)
		if err != nil {
			return "", err
		}
		whereSQL, err := c.compile(n.Where, IdentityScope{Column: e + "." + qTarget})
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM %s %s WHERE %s.%s = %s.%s%s AND %s)", qTable, e, e, qSource, outer, qKey, window, whereSQL), nil
	}
	if n.Target.Kind == core.RelationTargetIdentity {
		sourceObject := c.nextAlias("t")
		if err := checkAlias(sourceObject); err != nil {
			return "", err
		}
		pSource := c.bind(BytesParam([]byte(n.Source)), "bytea")
		pRelKey := c.bind(BytesParam([]byte(n.Relation.Key)), "bytea")
		pRelVer := c.bind(IntParam(int64(n.Relation.Version)), "int4")
		qObjID, err := QuoteIdentifier(src.ObjectIDColumn)
		if err != nil {
			return "", err
		}
		act, err := activeWindow(e, "starts_at", "expires_at")
		if err != nil {
			return "", err
		}
		whereSQL, err := c.compile(n.Where, IdentityScope{Column: e + ".user_id"})
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM user_relation %s JOIN object_ref %s ON %s.object_id=%s.object_id WHERE %s.type_key = %s AND %s.relation_key = %s AND %s.relation_version = %s AND %s.object_id = %s.%s AND %s AND %s)", e, sourceObject, sourceObject, e, sourceObject, pSource, e, pRelKey, e, pRelVer, e, outer, qObjID, act, whereSQL), nil
	}
	if n.Target.Kind == core.RelationTargetResource {
		target, err := c.registry.Resource(n.Target.Type)
		if err != nil {
			return "", err
		}
		t := c.nextAlias("t")
		if err := checkAlias(t); err != nil {
			return "", err
		}
		qTargetTable, err := QuoteIdentifier(target.Table)
		if err != nil {
			return "", err
		}
		qTargetObjID, err := QuoteIdentifier(target.ObjectIDColumn)
		if err != nil {
			return "", err
		}
		qSrcObjID, err := QuoteIdentifier(src.ObjectIDColumn)
		if err != nil {
			return "", err
		}
		pRelKey := c.bind(BytesParam([]byte(n.Relation.Key)), "bytea")
		pRelVer := c.bind(IntParam(int64(n.Relation.Version)), "int4")
		pSrcType := c.bind(BytesParam([]byte(n.Source)), "bytea")
		pTgtType := c.bind(BytesParam([]byte(n.Target.Type)), "bytea")
		act, err := activeWindow(e, "starts_at", "expires_at")
		if err != nil {
			return "", err
		}
		whereSQL, err := c.compile(n.Where, ResourceScope{Alias: t, Binding: target})
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("EXISTS (SELECT 1 FROM relation_edge %s JOIN %s %s ON %s.%s = %s.target_object WHERE %s.relation_key = %s AND %s.relation_version = %s AND %s.source_object = %s.%s AND %s.source_type = %s AND %s.target_type = %s AND %s AND %s)", e, qTargetTable, t, t, qTargetObjID, e, e, pRelKey, e, pRelVer, e, outer, qSrcObjID, e, pSrcType, e, pTgtType, act, whereSQL), nil
	}
	return "", fmt.Errorf("unsupported relation target kind %q", n.Target.Kind)
}

func (c expressionCompiler) exception(n core.PlanException, current Scope) (string, error) {
	resScope, ok := current.(ResourceScope)
	if !ok {
		return "", errors.New("record exceptions apply to the requested resource only")
	}
	if err := checkAlias(resScope.Alias); err != nil {
		return "", err
	}
	if n.Permission == "" || (n.Effect != core.EffectAllow && n.Effect != core.EffectDeny) || n.Identity == "" {
		return "", errors.New("invalid record exception plan node")
	}
	x := c.nextAlias("x")
	if err := checkAlias(x); err != nil {
		return "", err
	}
	src := resScope.Binding
	roles := make([]string, len(n.Roles))
	for i, role := range n.Roles {
		roles[i] = c.bind(BytesParam([]byte(role)), "bytea")
	}
	var subject string
	if len(roles) > 0 {
		subject = fmt.Sprintf("(%s.user_id = %s OR %s.role_key IN (%s))", x, c.bind(TextParam(string(n.Identity)), "uuid"), x, strings.Join(roles, ", "))
	} else {
		subject = fmt.Sprintf("%s.user_id = %s", x, c.bind(TextParam(string(n.Identity)), "uuid"))
	}
	purpose := ""
	if n.Effect == core.EffectAllow {
		purpose = fmt.Sprintf(" AND %s.purpose = %s", x, c.bind(TextParam("manual"), "text"))
	}
	qObjID, err := QuoteIdentifier(src.ObjectIDColumn)
	if err != nil {
		return "", err
	}
	pTypeKey := c.bind(BytesParam([]byte(src.Resource)), "bytea")
	pPermKey := c.bind(BytesParam([]byte(n.Permission)), "bytea")
	pEffect := c.bind(TextParam(string(n.Effect)), "text")
	act, err := activeWindow(x, "starts_at", "expires_at")
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("EXISTS (SELECT 1 FROM record_exception %s WHERE %s.object_id = %s.%s AND %s.type_key = %s AND %s.permission_key = %s AND %s.effect = %s%s AND %s.revoked_at IS NULL AND %s AND %s)", x, x, resScope.Alias, qObjID, x, pTypeKey, x, pPermKey, x, pEffect, purpose, x, act, subject), nil
}
