package authority

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/gateway"
	"hrm/api/internal/database"
)

func (a *Authorization) List(ctx context.Context, secret, resource, action string, query gateway.ListQuery) (gateway.Page, error) {
	return access(ctx, a, secret, Probe{resource, action}, database.ModeRead, func(tx *database.Tx, plan *core.AuthorizedPlan, _ session) (gateway.Page, *audit.Event, error) {
		page, err := a.gateway.List(plan, query, tx)
		return page, rootAccess(plan, nil, false), err
	})
}

func (a *Authorization) Detail(ctx context.Context, secret, resource, action, key string) (gateway.Row, error) {
	return access(ctx, a, secret, Probe{resource, action}, database.ModeRead, func(tx *database.Tx, plan *core.AuthorizedPlan, _ session) (gateway.Row, *audit.Event, error) {
		parsed, err := a.requestKey(resource, key)
		if err != nil {
			return nil, nil, err
		}
		row, err := a.gateway.Detail(plan, parsed, tx)
		return row, rootAccess(plan, &audit.RequestedKey{Resource: resource, KeyKind: parsed.Kind, Key: parsed.Value}, row == nil), err
	})
}

func (a *Authorization) Count(ctx context.Context, secret, resource, action string) (string, error) {
	return access(ctx, a, secret, Probe{resource, action}, database.ModeRead, func(tx *database.Tx, plan *core.AuthorizedPlan, _ session) (string, *audit.Event, error) {
		count, err := a.gateway.Count(plan, gateway.CountQuery{}, tx)
		return count, rootAccess(plan, nil, false), err
	})
}

func (a *Authorization) Permits(ctx context.Context, secret, resource, action string) (bool, error) {
	answers, err := a.permits(ctx, secret, []PermitQuery{{{Resource: resource, Action: action}}}, false)
	if err != nil {
		return false, err
	}
	return answers[0], nil
}

func (a *Authorization) PermitsMany(ctx context.Context, secret string, queries []PermitQuery) ([]bool, error) {
	return a.permits(ctx, secret, queries, true)
}

func (a *Authorization) permits(ctx context.Context, secret string, queries []PermitQuery, menu bool) ([]bool, error) {
	if !ValidPermitQueries(queries) {
		return nil, apperror.ErrInvalidRequest
	}
	pairs := make([]Probe, 0, MaxPermitProbes)
	for _, group := range queries {
		pairs = append(pairs, group...)
	}
	return database.Run(ctx, a.runner, database.ModeRead, func(_ context.Context, tx *database.Tx) ([]bool, error) {
		s, f, err := a.readSession(tx, secret, pairs)
		if err != nil {
			return nil, err
		}
		answers := make([]bool, len(pairs))
		var params []compiler.Param
		var probes []string
		var indices []int
		for i, pair := range pairs {
			decision, err := a.decide(tx, s, f, pair)
			if err != nil {
				return nil, err
			}
			if !decision.Allowed() {
				continue
			}
			if menu && s.kind == "root" {
				answers[i] = true
				continue
			}
			binding, err := a.bindings.Resource(pair.Resource)
			if err != nil {
				return nil, err
			}
			table, err := compiler.QuoteIdentifier(binding.Table)
			if err != nil {
				return nil, err
			}
			bound, err := compiler.CompilePlanAt(decision.Plan(), a.bindings, "r", len(params)+1)
			if err != nil {
				return nil, err
			}
			params = append(params, bound.Parameters...)
			probes = append(probes, fmt.Sprintf("EXISTS (SELECT 1 FROM %s r WHERE %s)", table, bound.SQL))
			indices = append(indices, i)
		}
		if len(probes) > 0 {
			rows, err := tx.Query("SELECT "+strings.Join(probes, ","), driverArgs(params)...)
			if err != nil {
				return nil, err
			}
			_, err = pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (struct{}, error) {
				dest := make([]any, len(indices))
				for i, index := range indices {
					dest[i] = &answers[index]
				}
				return struct{}{}, row.Scan(dest...)
			})
			if err != nil {
				return nil, err
			}
		}
		result := make([]bool, len(queries))
		next := 0
		for i, group := range queries {
			for range group {
				result[i] = result[i] || answers[next]
				next++
			}
		}
		return result, nil
	}, database.RunOptions{})
}

func (a *Authorization) ReachesTarget(ctx context.Context, secret, resource, action, key string) (bool, error) {
	return database.Run(ctx, a.runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (bool, error) {
		s, f, err := a.readSession(tx, secret, []Probe{{Resource: resource, Action: action}})
		if err != nil {
			return false, err
		}
		d, err := a.decide(tx, s, f, Probe{resource, action})
		if err != nil {
			return false, err
		}
		if !d.Allowed() {
			return false, apperror.ErrAccessDenied
		}
		if s.kind == "root" {
			return true, nil
		}
		id, err := a.target(tx, d.Plan(), key, false)
		return id != "", err
	}, database.RunOptions{})
}

func (a *Authorization) AllowsAll(ctx context.Context, secret string, pairs []Probe) (bool, error) {
	if !ValidPermitQueries([]PermitQuery{pairs}) {
		return false, apperror.ErrInvalidRequest
	}
	return database.Run(ctx, a.runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (bool, error) {
		s, f, err := a.readSession(tx, secret, pairs)
		if err != nil {
			return false, err
		}
		for _, pair := range pairs {
			d, err := a.decide(tx, s, f, pair)
			if err != nil {
				return false, err
			}
			if !d.Allowed() {
				return false, nil
			}
		}
		return true, nil
	}, database.RunOptions{})
}
