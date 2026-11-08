package core

import (
	"errors"
	"slices"
	"strconv"
	"unicode/utf8"
)

// MaxPathDepth is the longest relation path a declaration may have.
const MaxPathDepth = 8

var (
	fieldKinds   = []FieldKind{FieldInteger, FieldDecimal, FieldString, FieldUUID, FieldBoolean, FieldTimestamp}
	orderedKinds = []FieldKind{FieldInteger, FieldDecimal, FieldString, FieldTimestamp}
)

const identityType = "identity"

type declarationTables struct {
	resources map[string]ResourceDeclaration
	relations map[string]RelationDeclaration
}

// relationTarget returns the type and fields a relation reaches, false when its target is not declared.
func relationTarget(relation RelationDeclaration, tables declarationTables) (string, map[string]FieldType, bool) {
	switch relation.Target.Kind {
	case RelationTargetIdentity:
		return identityType, map[string]FieldType{"identityId": {Kind: FieldUUID}}, true
	case RelationTargetResource:
		resource, known := tables.resources[relation.Target.Type]
		return relation.Target.Type, resource.Fields, known
	}
	return "", nil, false
}

type exprScope struct {
	typeName string
	fields   map[string]FieldType
	// parameters is nil in a required scope, where no parameter resolves.
	parameters map[string]FieldKind
}

// checkExpr type-checks a declaration expression. Unknown shapes are errors, and the node count bounds
// the walk even over an expression that contains itself.
func (c *declarationChecker) checkExpr(expr Expr, scope exprScope, at string) {
	nodes := 0
	var visit func(Expr, string, map[string]FieldType, int, string)
	visit = func(node Expr, typeName string, fields map[string]FieldType, depth int, path string) {
		nodes++
		if nodes > c.limits.MaxExpressionNodes {
			if nodes == c.limits.MaxExpressionNodes+1 {
				c.report(at + ": more than " + strconv.Itoa(c.limits.MaxExpressionNodes) + " expression nodes")
			}
			return
		}
		switch n := node.(type) {
		case nil:
			c.report(path + ": expression is missing")
		case ConstantExpr:
		case LogicalExpr:
			if n.Op != OpAnd && n.Op != OpOr {
				c.report(path + ": unsupported operator " + string(n.Op))
				return
			}
			if len(n.Args) == 0 {
				c.report(path + ": " + string(n.Op) + " needs arguments")
				return
			}
			for i, arg := range n.Args {
				visit(arg, typeName, fields, depth, path+"."+string(n.Op)+"["+strconv.Itoa(i)+"]")
			}
		case CompareExpr:
			c.checkCompare(n, typeName, fields, scope.parameters, path)
		case IsNullExpr:
			if !fields[n.Field].Nullable {
				c.report(path + ": isNull needs a nullable field")
			}
		case ExistsExpr:
			relation, known := c.tables.relations[n.Relation]
			if !known {
				c.report(path + ": unknown relation " + n.Relation)
				return
			}
			if relation.SourceType != typeName {
				c.report(path + ": relation " + n.Relation + " starts at " + relation.SourceType + ", not " + typeName)
				return
			}
			if depth+1 > c.limits.MaxPathDepth {
				c.report(path + ": relation path deeper than " + strconv.Itoa(c.limits.MaxPathDepth))
				return
			}
			targetType, targetFields, declared := relationTarget(relation, c.tables)
			if !declared {
				c.report(path + ": relation target is not declared")
				return
			}
			visit(n.Where, targetType, targetFields, depth+1, path+".exists")
		default:
			c.report(path + ": unsupported expression node")
		}
	}
	visit(expr, scope.typeName, scope.fields, 0, at)
}

func (c *declarationChecker) checkCompare(node CompareExpr, typeName string, fields map[string]FieldType, parameters map[string]FieldKind, path string) {
	if node.Op != OpEq && node.Op != OpLt && node.Op != OpLte {
		c.report(path + ": unsupported operator " + string(node.Op))
		return
	}
	field, known := fields[node.Field]
	if !known {
		c.report(path + ": unknown field " + node.Field + " on " + typeName)
		return
	}
	if node.Op != OpEq && !slices.Contains(orderedKinds, field.Kind) {
		c.report(path + ": " + string(node.Op) + " is not defined for " + string(field.Kind))
	}
	c.checkValueRef(node.Value, field.Kind, parameters, path)
}

// unusedFields is a field the source never reads. It would still reach the canonical form, so two
// declarations that decide alike would hash apart.
func unusedFields(ref ValueRef) bool {
	if ref.From == SourceLiteral {
		return ref.Name != ""
	}
	return ref.Literal != (FieldValue{})
}

func (c *declarationChecker) checkValueRef(ref ValueRef, kind FieldKind, parameters map[string]FieldKind, path string) {
	if unusedFields(ref) {
		c.report(path + ": value reference has a field its source does not use")
		return
	}
	switch ref.From {
	case SourceLiteral:
		_, err := c.core.NormalizeValue(kind, ref.Literal)
		if errors.Is(err, ErrInvalidValue) {
			c.report(path + ": literal is not a valid " + string(kind))
		} else if err != nil {
			c.fault = err
		}
	case SourcePrincipal:
		if ref.Name != "id" || kind != FieldUUID {
			c.report(path + ": only principal.id (uuid) is available")
		}
	case SourceContext:
		if ref.Name == "" || !utf8.ValidString(ref.Name) {
			c.report(path + ": context name required, in valid UTF-8")
		}
	case SourceParameter:
		declared, known := parameters[ref.Name]
		if !known || declared != kind {
			c.report(path + ": parameter " + ref.Name + " is not declared as " + string(kind))
		}
	default:
		c.report(path + ": unsupported value source " + string(ref.From))
	}
}

// wellFormed checks the shape of a scope that no action may ever type-check: a policy nothing binds has
// no resource to read fields from. budget bounds the walk over an expression that contains itself.
func wellFormed(expr Expr, budget *int) bool {
	if *budget <= 0 {
		return false
	}
	*budget--
	switch node := expr.(type) {
	case ConstantExpr:
		return true
	case IsNullExpr:
		return utf8.ValidString(node.Field)
	case CompareExpr:
		known := node.Op == OpEq || node.Op == OpLt || node.Op == OpLte
		literal, _ := node.Value.Literal.AsText()
		return known && !unusedFields(node.Value) && utf8.ValidString(node.Field) && utf8.ValidString(node.Value.Name) && utf8.ValidString(literal) &&
			slices.Contains([]ValueSource{SourceLiteral, SourcePrincipal, SourceContext, SourceParameter}, node.Value.From)
	case LogicalExpr:
		if (node.Op != OpAnd && node.Op != OpOr) || len(node.Args) == 0 {
			return false
		}
		for _, arg := range node.Args {
			if !wellFormed(arg, budget) {
				return false
			}
		}
		return true
	case ExistsExpr:
		return utf8.ValidString(node.Relation) && wellFormed(node.Where, budget)
	}
	return false
}

// isDenySafe keeps a deny scope from evaluating to SQL NULL, which would make NOT(deny) differ between SQL
// and the evaluator: comparisons on nullable fields outside an EXISTS are rejected for deny.
func isDenySafe(expr Expr, fields map[string]FieldType) bool {
	switch node := expr.(type) {
	case LogicalExpr:
		for _, arg := range node.Args {
			if !isDenySafe(arg, fields) {
				return false
			}
		}
		return true
	case CompareExpr:
		return !fields[node.Field].Nullable
	case ConstantExpr, IsNullExpr, ExistsExpr:
		return true
	}
	return false
}

// lowerExpr turns a checked expression into a typed plan expression, binding every value.
func lowerExpr(expr Expr, typeName string, fields map[string]FieldType, tables declarationTables, resolve valueResolver) (PlanExpr, error) {
	switch node := expr.(type) {
	case ConstantExpr:
		return PlanConstant(node), nil
	case LogicalExpr:
		args := make([]PlanExpr, len(node.Args))
		for i, arg := range node.Args {
			lowered, err := lowerExpr(arg, typeName, fields, tables, resolve)
			if err != nil {
				return nil, err
			}
			args[i] = lowered
		}
		return PlanLogical{Op: node.Op, Args: args}, nil
	case CompareExpr:
		field, known := fields[node.Field]
		if !known {
			return nil, &configurationError{message: "unknown field " + node.Field + " on " + typeName}
		}
		value, err := resolve(node.Value, field.Kind)
		if err != nil {
			return nil, err
		}
		return PlanCompare{Op: node.Op, Field: node.Field, Kind: field.Kind, Value: value}, nil
	case IsNullExpr:
		return PlanIsNull(node), nil
	case ExistsExpr:
		relation, known := tables.relations[node.Relation]
		if !known || relation.SourceType != typeName {
			return nil, &configurationError{message: "invalid relation " + node.Relation + " from " + typeName}
		}
		targetType, targetFields, declared := relationTarget(relation, tables)
		if !declared {
			return nil, &configurationError{message: "invalid relation " + node.Relation + " from " + typeName}
		}
		where, err := lowerExpr(node.Where, targetType, targetFields, tables, resolve)
		if err != nil {
			return nil, err
		}
		return PlanExists{
			Relation: RelationRef{Key: relation.Key, Version: relation.Version}, Source: typeName, Target: relation.Target, Where: where,
		}, nil
	}
	return nil, &configurationError{message: "unsupported operator"}
}

// simplify folds constants only; it never reorders or drops a deny branch that is not provably false.
func simplify(expr PlanExpr) PlanExpr {
	switch node := expr.(type) {
	case PlanLogical:
		absorbing := node.Op == OpOr
		var args []PlanExpr
		for _, arg := range node.Args {
			simplified := simplify(arg)
			if constant, isConstant := simplified.(PlanConstant); isConstant {
				if constant.Value == absorbing {
					return constant
				}
				continue
			}
			args = append(args, simplified)
		}
		switch len(args) {
		case 0:
			return PlanConstant{Value: !absorbing}
		case 1:
			return args[0]
		}
		return PlanLogical{Op: node.Op, Args: args}
	case PlanNot:
		arg := simplify(node.Arg)
		if constant, isConstant := arg.(PlanConstant); isConstant {
			return PlanConstant{Value: !constant.Value}
		}
		return PlanNot{Arg: arg}
	case PlanExists:
		node.Where = simplify(node.Where)
		return node
	}
	return expr
}
