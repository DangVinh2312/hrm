package gateway

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

func (g *Gateway) buildListSQL(plan *core.AuthorizedPlan, query ListQuery, tx *database.Tx) (string, []compiler.Param, core.ResourceDeclaration, compiler.ResourceBinding, error) {
	prepared, err := g.prepare(plan, query.Filter, tx)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	limit := DefaultLimit
	if query.Limit != nil {
		limit = *query.Limit
	}
	if limit < 1 || limit > MaxLimit {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, fmt.Errorf("%w: limit must be 1-%d", apperror.ErrInvalidRequest, MaxLimit)
	}
	if query.Offset < 0 || query.Offset > MaxOffset {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, fmt.Errorf("%w: offset must be 0-%d", apperror.ErrInvalidRequest, MaxOffset)
	}
	direction := query.Direction
	if direction == "" {
		direction = SortAsc
	}
	if direction != SortAsc && direction != SortDesc {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, fmt.Errorf("%w: direction must be asc or desc", apperror.ErrInvalidRequest)
	}
	qKeyCol, err := compiler.QuoteIdentifier(prepared.binding.KeyColumn)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	keyExpr := "r." + qKeyCol
	order := fmt.Sprintf("%s %s", keyExpr, direction)
	if query.OrderBy != "" {
		projCol, err := g.projectedColumn(prepared.binding, query.OrderBy)
		if err != nil {
			return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
		}
		order = fmt.Sprintf("%s %s, %s %s", projCol, direction, keyExpr, direction)
	}
	proj, err := g.projection(prepared.declared, prepared.binding)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	qTable, err := compiler.QuoteIdentifier(prepared.binding.Table)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	params := append(slices.Clone(prepared.bound.Parameters), compiler.IntParam(int64(limit)), compiler.IntParam(int64(query.Offset)))
	lim := fmt.Sprintf("CAST($%d AS int8)", len(params)-1)
	off := fmt.Sprintf("CAST($%d AS int8)", len(params))
	sql := fmt.Sprintf(
		`SELECT * FROM (SELECT %s, count(*) OVER () AS "$total", row_number() OVER (ORDER BY %s) AS "$n" FROM %s r WHERE %s%s) p WHERE ("$n" > %s AND "$n" <= %s + %s) OR ("$n" = "$total" AND "$total" <= %s) ORDER BY "$n"`,
		proj, order, qTable, prepared.bound.SQL, prepared.where, off, off, lim, off,
	)
	return sql, params, prepared.declared, prepared.binding, nil
}

func (g *Gateway) buildCountSQL(plan *core.AuthorizedPlan, query CountQuery, tx *database.Tx) (string, []compiler.Param, error) {
	prepared, err := g.prepare(plan, query.Filter, tx)
	if err != nil {
		return "", nil, err
	}
	qTable, err := compiler.QuoteIdentifier(prepared.binding.Table)
	if err != nil {
		return "", nil, err
	}
	sql := fmt.Sprintf("SELECT count(*)::text AS n FROM %s r WHERE %s%s", qTable, prepared.bound.SQL, prepared.where)
	return sql, slices.Clone(prepared.bound.Parameters), nil
}

func (g *Gateway) buildDetailSQL(plan *core.AuthorizedPlan, key core.Key, tx *database.Tx) (string, []compiler.Param, core.ResourceDeclaration, compiler.ResourceBinding, error) {
	prepared, err := g.prepare(plan, nil, tx)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	if key.Kind != prepared.declared.KeyKind {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, fmt.Errorf("%w: %s keys are %s", apperror.ErrInvalidRequest, plan.Resource(), prepared.declared.KeyKind)
	}
	parsed, err := g.registry.Core().ParseKey(key.Kind, key.Value)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, fmt.Errorf("%w: %v", apperror.ErrInvalidRequest, err)
	}
	keyType, ok := compiler.KeyPgType(key.Kind)
	if !ok {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, fmt.Errorf("%w: unsupported key kind %s", apperror.ErrInvalidRequest, key.Kind)
	}
	proj, err := g.projection(prepared.declared, prepared.binding)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	qTable, err := compiler.QuoteIdentifier(prepared.binding.Table)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	qKeyCol, err := compiler.QuoteIdentifier(prepared.binding.KeyColumn)
	if err != nil {
		return "", nil, core.ResourceDeclaration{}, compiler.ResourceBinding{}, err
	}
	params := append(slices.Clone(prepared.bound.Parameters), compiler.TextParam(parsed.Value))
	sql := fmt.Sprintf(
		"SELECT %s FROM %s r WHERE %s AND r.%s = CAST($%d AS %s) LIMIT 1",
		proj, qTable, prepared.bound.SQL, qKeyCol, len(params), keyType,
	)
	return sql, params, prepared.declared, prepared.binding, nil
}

func (g *Gateway) projectedColumn(binding compiler.ResourceBinding, field string) (string, error) {
	if !slices.Contains(binding.Projection, field) {
		return "", fmt.Errorf("%w: field %s is not readable", apperror.ErrInvalidRequest, field)
	}
	col, err := compiler.QuoteIdentifier(binding.Columns[field])
	if err != nil {
		return "", err
	}
	return "r." + col, nil
}

func (g *Gateway) projection(declared core.ResourceDeclaration, binding compiler.ResourceBinding) (string, error) {
	qKey, err := compiler.QuoteIdentifier(binding.KeyColumn)
	if err != nil {
		return "", err
	}
	keyCol := "r." + qKey
	keySelect := keyCol
	if declared.KeyKind == core.KeyInteger {
		keySelect = fmt.Sprintf("CAST(%s AS text)", keyCol)
	}
	parts := make([]string, 0, len(binding.Projection)+1)
	parts = append(parts, keySelect+` AS "key"`)
	for _, field := range binding.Projection {
		col, err := g.projectedColumn(binding, field)
		if err != nil {
			return "", err
		}
		kind := declared.Fields[field].Kind
		expr := col
		switch kind {
		case core.FieldInteger, core.FieldDecimal:
			expr = fmt.Sprintf("CAST(%s AS text)", col)
		case core.FieldTimestamp:
			expr = fmt.Sprintf(`to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, col)
		case core.FieldString, core.FieldUUID, core.FieldBoolean:
		}
		parts = append(parts, fmt.Sprintf(`%s AS "%s"`, expr, field))
	}
	return strings.Join(parts, ", "), nil
}

type pageRow struct {
	item   Row
	total  int64
	rowNum int64
}

func (g *Gateway) queryPage(tx *database.Tx, sql string, params []compiler.Param, declared core.ResourceDeclaration, binding compiler.ResourceBinding, offset int64) (Page, error) {
	rows, err := tx.Query(sql, driverArgs(params)...)
	if err != nil {
		return Page{}, err
	}
	collected, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (pageRow, error) {
		item, total, rowNum, err := scanProjectedRow(row, declared, binding, true)
		return pageRow{item: item, total: total, rowNum: rowNum}, err
	})
	if err != nil {
		return Page{}, err
	}
	total := "0"
	if len(collected) > 0 {
		total = strconv.FormatInt(collected[0].total, 10)
	}
	items := make([]Row, 0, len(collected))
	for _, r := range collected {
		if r.rowNum > offset {
			items = append(items, r.item)
		}
	}
	return Page{Items: items, Total: total}, nil
}

func scanProjectedRow(row pgx.CollectableRow, declared core.ResourceDeclaration, binding compiler.ResourceBinding, withWindow bool) (Row, int64, int64, error) {
	var key string
	boolPtrs := make([]*bool, len(binding.Projection))
	textPtrs := make([]*string, len(binding.Projection))
	extra := 1
	if withWindow {
		extra = 3
	}
	dest := make([]any, 0, len(binding.Projection)+extra)
	dest = append(dest, &key)
	for i, field := range binding.Projection {
		if declared.Fields[field].Kind == core.FieldBoolean {
			dest = append(dest, &boolPtrs[i])
		} else {
			dest = append(dest, &textPtrs[i])
		}
	}
	var total, rowNum int64
	if withWindow {
		dest = append(dest, &total, &rowNum)
	}
	if err := row.Scan(dest...); err != nil {
		return nil, 0, 0, err
	}
	item := make(Row, len(binding.Projection)+1)
	item["key"] = core.TextValue(key)
	for i, field := range binding.Projection {
		if declared.Fields[field].Kind == core.FieldBoolean {
			if boolPtrs[i] == nil {
				item[field] = core.NullValue()
			} else {
				item[field] = core.BoolValue(*boolPtrs[i])
			}
		} else {
			if textPtrs[i] == nil {
				item[field] = core.NullValue()
			} else {
				item[field] = core.TextValue(*textPtrs[i])
			}
		}
	}
	return item, total, rowNum, nil
}

func driverArgs(params []compiler.Param) []any {
	args := make([]any, len(params))
	for i, p := range params {
		switch p.Kind() {
		case compiler.ParamText:
			v, _ := p.AsText()
			args[i] = v
		case compiler.ParamBool:
			v, _ := p.AsBool()
			args[i] = v
		case compiler.ParamInt:
			v, _ := p.AsInt()
			args[i] = v
		case compiler.ParamBytes:
			v, _ := p.AsBytes()
			args[i] = v
		}
	}
	return args
}
