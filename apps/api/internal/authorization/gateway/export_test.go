package gateway

import (
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/database"
)

func (g *Gateway) BuildListSQLForTest(plan *core.AuthorizedPlan, query ListQuery, tx *database.Tx) (string, []compiler.Param, error) {
	sql, params, _, _, err := g.buildListSQL(plan, query, tx)
	return sql, params, err
}

func (g *Gateway) BuildCountSQLForTest(plan *core.AuthorizedPlan, query CountQuery, tx *database.Tx) (string, []compiler.Param, error) {
	return g.buildCountSQL(plan, query, tx)
}

func (g *Gateway) BuildDetailSQLForTest(plan *core.AuthorizedPlan, key core.Key, tx *database.Tx) (string, []compiler.Param, error) {
	sql, params, _, _, err := g.buildDetailSQL(plan, key, tx)
	return sql, params, err
}
