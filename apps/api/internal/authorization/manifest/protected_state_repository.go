package manifest

import (
	"encoding/json/jsontext"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
)

func codeOwnedQueries() []struct{ table, predicate string } {
	return []struct{ table, predicate string }{
		{"resource_type", "true"}, {"permission_policy", "true"}, {"permission_catalog", "true"},
		{"scope_template", "true"}, {"permission_boundary", "true"}, {"permission_boundary_entry", "true"},
		{"resource_relation_definition", "true"}, {"role_definition", "managed_by='code'"},
		{"policy_rule", "managed_by='code'"}, {"relation_edge", "seed_owner IS NOT NULL"}, {"user_boundary", "seed_owner IS NOT NULL"},
	}
}

func ProtectedStateHash(tx *database.Tx) (string, error) {
	tables := make([][]struct {
		Fact jsontext.Value `json:"fact"`
	}, 0, 11)
	for _, entry := range codeOwnedQueries() {
		rows, err := tx.Query(`SELECT to_jsonb(t)::text fact FROM public.` + entry.table + ` t WHERE ` + entry.predicate + ` ORDER BY to_jsonb(t)::text COLLATE "C"`)
		if err != nil {
			return "", err
		}
		facts, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (struct {
			Fact jsontext.Value `json:"fact"`
		}, error) {
			var raw string
			err := row.Scan(&raw)
			return struct {
				Fact jsontext.Value `json:"fact"`
			}{jsontext.Value(raw)}, err
		})
		if err != nil {
			return "", err
		}
		if facts == nil {
			facts = []struct {
				Fact jsontext.Value `json:"fact"`
			}{}
		}
		tables = append(tables, facts)
	}
	form, err := canonical(tables)
	if err != nil {
		return "", err
	}
	return digest(form), nil
}

func catalogIsEmpty(tx *database.Tx) (bool, error) {
	for _, entry := range codeOwnedQueries() {
		rows, err := tx.Query(`SELECT 1 FROM public.` + entry.table + ` t WHERE ` + entry.predicate + ` LIMIT 1`)
		if err != nil {
			return false, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return false, err
		}
		if len(found) > 0 {
			return false, nil
		}
	}
	return true, nil
}
