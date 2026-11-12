package report

import (
	"slices"

	"hrm/api/internal/apperror"
	"hrm/api/internal/httpapi"
	"hrm/api/internal/modules/schedulecore"
)

// MaxMonths is the longest From..To of a monthly report (12 months stay within the 366-day budget);
// report.maxMonths can only lower it, checked where the setting is read.
const MaxMonths = 12

func rangeKeys(kind Kind) []string {
	if kind.monthly() {
		return []string{"from", "to"}
	}
	return []string{"asOn"}
}

// parseQuery is GET /api/hr/reports/:kind: exactly the keys of the kind, each once, plus the page.
func parseQuery(kind Kind, rawQuery string) (Query, error) {
	if !slices.Contains(kinds, kind) {
		return Query{}, apperror.ErrInvalidRequest
	}
	page, err := httpapi.InputPageQuery(rawQuery, rangeKeys(kind)...)
	if err != nil {
		return Query{}, err
	}
	query, err := parseRange(kind, page.Extra)
	if err != nil {
		return Query{}, err
	}
	return Query{ExportQuery: query, Limit: page.Limit, Offset: page.Offset}, nil
}

// parseExportQuery is GET /api/hr/reports/:kind/export: the keys of the kind and no limit or offset.
func parseExportQuery(kind Kind, rawQuery string) (ExportQuery, error) {
	if !slices.Contains(kinds, kind) {
		return ExportQuery{}, apperror.ErrInvalidRequest
	}
	values, err := httpapi.InputQuery(rawQuery, rangeKeys(kind)...)
	if err != nil {
		return ExportQuery{}, err
	}
	return parseRange(kind, values)
}

func parseRange(kind Kind, values map[string]string) (ExportQuery, error) {
	if !kind.monthly() {
		asOn, ok := values["asOn"]
		if _, err := schedulecore.ParseDate(asOn); !ok || err != nil {
			return ExportQuery{}, apperror.ErrInvalidRequest
		}
		return ExportQuery{Kind: kind, AsOn: asOn}, nil
	}
	from, fromOK := values["from"]
	to, toOK := values["to"]
	if !fromOK || !toOK {
		return ExportQuery{}, apperror.ErrInvalidRequest
	}
	if err := checkSpan(from, to, MaxMonths); err != nil {
		return ExportQuery{}, err
	}
	return ExportQuery{Kind: kind, From: from, To: to}, nil
}
