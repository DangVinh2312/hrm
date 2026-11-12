package authority

import (
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/database"
)

func driverArgs(params []compiler.Param) []any {
	args := make([]any, len(params))
	for i, p := range params {
		switch p.Kind() {
		case compiler.ParamText:
			args[i], _ = p.AsText()
		case compiler.ParamBool:
			args[i], _ = p.AsBool()
		case compiler.ParamInt:
			args[i], _ = p.AsInt()
		case compiler.ParamBytes:
			args[i], _ = p.AsBytes()
		}
	}
	return args
}

type targetSQL struct {
	table, keyColumn, objectColumn, keyType string
	bound                                   compiler.Bound
	key                                     core.Key
}

func (a *Authorization) targetSQL(tx *database.Tx, plan *core.AuthorizedPlan, key string) (targetSQL, error) {
	if tx == nil || plan == nil || plan.Revision() != tx.Revision {
		return targetSQL{}, errors.New("plan revision differs from transaction")
	}
	bound, err := compiler.CompilePlan(plan, a.bindings)
	if err != nil {
		return targetSQL{}, err
	}
	binding, err := a.bindings.Resource(plan.Resource())
	if err != nil {
		return targetSQL{}, err
	}
	typed, err := a.requestKey(plan.Resource(), key)
	if err != nil {
		return targetSQL{}, err
	}
	keyType, ok := compiler.KeyPgType(typed.Kind)
	if !ok {
		return targetSQL{}, errors.New("invalid key type")
	}
	table, err := compiler.QuoteIdentifier(binding.Table)
	if err != nil {
		return targetSQL{}, err
	}
	keyColumn, err := compiler.QuoteIdentifier(binding.KeyColumn)
	if err != nil {
		return targetSQL{}, err
	}
	objectColumn, err := compiler.QuoteIdentifier(binding.ObjectIDColumn)
	if err != nil {
		return targetSQL{}, err
	}
	return targetSQL{table: table, keyColumn: keyColumn, objectColumn: objectColumn, keyType: keyType, bound: bound, key: typed}, nil
}

func (a *Authorization) target(tx *database.Tx, plan *core.AuthorizedPlan, key string, lock bool) (string, error) {
	prepared, err := a.targetSQL(tx, plan, key)
	if err != nil {
		return "", err
	}
	params := append(prepared.bound.Parameters, compiler.TextParam(prepared.key.Value))
	sql := fmt.Sprintf("SELECT r.%s::text FROM %s r WHERE %s AND r.%s=CAST($%d AS %s)", prepared.objectColumn, prepared.table, prepared.bound.SQL, prepared.keyColumn, len(params), prepared.keyType)
	if lock {
		sql += " FOR NO KEY UPDATE OF r"
	}
	rows, err := tx.Query(sql, driverArgs(params)...)
	if err != nil {
		return "", err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	if len(found) == 0 {
		return "", nil
	}
	return found[0], nil
}

func (a *Authorization) reachesIn(tx *database.Tx, s session, pair Probe, key string, fulfil bool) (bool, error) {
	f, err := a.readFacts(tx, s, pair.Resource+"."+pair.Action)
	if err != nil {
		return false, err
	}
	d, err := a.decide(tx, s, f, pair)
	if err != nil || !d.Allowed() {
		return false, err
	}
	id, err := a.target(tx, d.Plan(), key, false)
	if err != nil || id == "" {
		return false, err
	}
	if fulfil {
		if err := a.fulfill(tx, d.Plan()); err != nil {
			return false, err
		}
	}
	return true, nil
}
