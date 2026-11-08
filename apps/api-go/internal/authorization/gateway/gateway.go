package gateway

import (
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

var orderedKinds = []core.FieldKind{
	core.FieldInteger,
	core.FieldDecimal,
	core.FieldString,
	core.FieldTimestamp,
}

type Gateway struct {
	registry *compiler.Registry
}

func New(registry *compiler.Registry) (*Gateway, error) {
	if registry == nil || registry.Core() == nil || registry.Declarations() == nil {
		return nil, errors.New("product data gateway requires a valid storage binding registry")
	}
	return &Gateway{registry: registry}, nil
}

func (g *Gateway) List(plan *core.AuthorizedPlan, query ListQuery, tx *database.Tx) (Page, error) {
	sql, params, declared, binding, err := g.buildListSQL(plan, query, tx)
	if err != nil {
		return Page{}, err
	}
	return g.queryPage(tx, sql, params, declared, binding, int64(query.Offset))
}

func (g *Gateway) Count(plan *core.AuthorizedPlan, query CountQuery, tx *database.Tx) (string, error) {
	sql, params, err := g.buildCountSQL(plan, query, tx)
	if err != nil {
		return "", err
	}
	rows, err := tx.Query(sql, driverArgs(params)...)
	if err != nil {
		return "", err
	}
	counts, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	if len(counts) == 0 {
		return "0", nil
	}
	return counts[0], nil
}

func (g *Gateway) Detail(plan *core.AuthorizedPlan, key core.Key, tx *database.Tx) (Row, error) {
	sql, params, declared, binding, err := g.buildDetailSQL(plan, key, tx)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(sql, driverArgs(params)...)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Row, error) {
		item, _, _, err := scanProjectedRow(row, declared, binding, false)
		return item, err
	})
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return items[0], nil
}

type preparedQuery struct {
	binding  compiler.ResourceBinding
	declared core.ResourceDeclaration
	bound    compiler.Bound
	where    string
}

func (g *Gateway) prepare(plan *core.AuthorizedPlan, filter Filter, tx *database.Tx) (preparedQuery, error) {
	if g == nil || g.registry == nil || !g.registry.Core().Issued(plan) {
		return preparedQuery{}, errors.New("authorized plan was not issued by this authorization core")
	}
	if tx == nil || plan.Revision() != tx.Revision {
		return preparedQuery{}, errors.New("plan revision does not match the fenced transaction")
	}
	binding, err := g.registry.Resource(plan.Resource())
	if err != nil {
		return preparedQuery{}, err
	}
	declared, ok := g.registry.Declarations().Resource(plan.Resource())
	if !ok {
		return preparedQuery{}, fmt.Errorf("unknown declared resource %s", plan.Resource())
	}
	bound, err := compiler.CompilePlan(plan, g.registry)
	if err != nil {
		return preparedQuery{}, err
	}
	if filter == nil {
		return preparedQuery{binding: binding, declared: declared, bound: bound}, nil
	}
	expr, err := g.normalizeFilter(binding, declared, filter)
	if err != nil {
		return preparedQuery{}, err
	}
	params := slices.Clone(bound.Parameters)
	filterSQL, err := compiler.CompileExpression(
		expr,
		g.registry,
		compiler.ResourceScope{Alias: "r", Binding: binding},
		func(value compiler.Param, pgType string) string {
			params = append(params, value)
			return fmt.Sprintf("CAST($%d AS %s)", len(params), pgType)
		},
		func(string) string {
			return ""
		},
	)
	if err != nil {
		return preparedQuery{}, err
	}
	return preparedQuery{
		binding:  binding,
		declared: declared,
		bound:    compiler.Bound{SQL: bound.SQL, Parameters: params},
		where:    " AND (" + filterSQL + ")",
	}, nil
}

func (g *Gateway) normalizeFilter(binding compiler.ResourceBinding, declared core.ResourceDeclaration, input Filter) (core.PlanExpr, error) {
	nodes := 0
	var visit func(Filter) (core.PlanExpr, error)
	visit = func(node Filter) (core.PlanExpr, error) {
		nodes++
		if nodes > MaxFilterNodes {
			return nil, fmt.Errorf("%w: filter is too large", apperror.ErrInvalidRequest)
		}
		switch n := node.(type) {
		case LogicalFilter:
			if (n.Op != core.OpAnd && n.Op != core.OpOr) || len(n.Args) == 0 {
				return nil, fmt.Errorf("%w: logical filter requires arguments", apperror.ErrInvalidRequest)
			}
			args := make([]core.PlanExpr, len(n.Args))
			for i, child := range n.Args {
				lowered, err := visit(child)
				if err != nil {
					return nil, err
				}
				args[i] = lowered
			}
			return core.PlanLogical{Op: n.Op, Args: args}, nil
		case IsNullFilter:
			if !slices.Contains(binding.Projection, n.Field) {
				return nil, fmt.Errorf("%w: filter field %s is not readable", apperror.ErrInvalidRequest, n.Field)
			}
			if _, ok := declared.Fields[n.Field]; !ok {
				return nil, fmt.Errorf("%w: filter field %s is not readable", apperror.ErrInvalidRequest, n.Field)
			}
			return core.PlanIsNull{Field: n.Field}, nil
		case CompareFilter:
			if !slices.Contains(binding.Projection, n.Field) {
				return nil, fmt.Errorf("%w: filter field %s is not readable", apperror.ErrInvalidRequest, n.Field)
			}
			field, ok := declared.Fields[n.Field]
			if !ok {
				return nil, fmt.Errorf("%w: filter field %s is not readable", apperror.ErrInvalidRequest, n.Field)
			}
			if n.Op != core.OpEq && ((n.Op != core.OpLt && n.Op != core.OpLte) || !slices.Contains(orderedKinds, field.Kind)) {
				return nil, fmt.Errorf("%w: unsupported filter operator %s", apperror.ErrInvalidRequest, n.Op)
			}
			scalar, err := g.registry.Core().NormalizeValue(field.Kind, n.Value)
			if err != nil {
				if errors.Is(err, core.ErrInvalidValue) {
					return nil, fmt.Errorf("%w: filter value for %s must be a %s", apperror.ErrInvalidRequest, n.Field, field.Kind)
				}
				return nil, err
			}
			return core.PlanCompare{Op: n.Op, Field: n.Field, Kind: field.Kind, Value: scalar}, nil
		default:
			return nil, fmt.Errorf("%w: unsupported filter node", apperror.ErrInvalidRequest)
		}
	}
	return visit(input)
}
