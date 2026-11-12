package team

import (
	"fmt"

	"github.com/jackc/pgx/v5"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/hrbase"
)

func listTeams(tx *database.Tx, scope authority.Scope, input ListQuery) (ListView, error) {
	args, at, err := scope.Args(input.Limit, input.Offset)
	if err != nil {
		return ListView{}, err
	}
	memberWindow, err := hrbase.CurrentWindow("m")
	if err != nil {
		return ListView{}, err
	}
	leadWindow, err := hrbase.CurrentWindow("l")
	if err != nil {
		return ListView{}, err
	}
	rows, err := tx.Query(fmt.Sprintf(`WITH scoped AS (SELECT r.id, r.name FROM team r WHERE %s)
       SELECT (SELECT count(*) FROM scoped)::text AS total,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name,
                  'lead', CASE WHEN e.id IS NULL THEN NULL ELSE json_build_object('employeeId', e.id, 'code', e.code, 'fullName', e.full_name) END,
                  'memberCount', (SELECT count(*) FROM team_membership m WHERE m.team_id = p.id AND %s))
                  ORDER BY p.name, p.id)
                FROM (SELECT * FROM scoped ORDER BY name, id
                       LIMIT CAST(%s AS int8) OFFSET CAST(%s AS int8)) p
                LEFT JOIN team_lead_assignment l ON l.team_id = p.id AND %s
                LEFT JOIN employee e ON e.id = l.lead_employee_id), '[]'::json) AS items`, scope.SQL, memberWindow, at(1), at(2), leadWindow), args...)
	if err != nil {
		return ListView{}, err
	}
	return pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (ListView, error) {
		var view ListView
		err := row.Scan(&view.Total, &view.Items)
		return view, err
	})
}

func teamDetail(tx *database.Tx, scope authority.Scope, teamID string) (authority.QueryResult[View], error) {
	args, at, err := scope.Args(teamID)
	if err != nil {
		return authority.QueryResult[View]{}, err
	}
	memberWindow, err := hrbase.CurrentWindow("m")
	if err != nil {
		return authority.QueryResult[View]{}, err
	}
	leadWindow, err := hrbase.CurrentWindow("l")
	if err != nil {
		return authority.QueryResult[View]{}, err
	}
	rows, err := tx.Query(fmt.Sprintf(`SELECT r.id::text, r.name, r.version::text AS version,
              (SELECT json_build_object('employeeId', e.id, 'code', e.code, 'fullName', e.full_name) FROM team_lead_assignment l JOIN employee e ON e.id = l.lead_employee_id
                WHERE l.team_id = r.id AND %s) AS lead,
              COALESCE((SELECT json_agg(x ORDER BY x.code) FROM (
                  SELECT e.id AS "employeeId", e.code, e.full_name AS "fullName", m.is_primary AS "primary",
                         to_char(m.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since
                    FROM team_membership m JOIN employee e ON e.id = m.employee_id
                   WHERE m.team_id = r.id AND %s ORDER BY e.code LIMIT 500) x), '[]'::json) AS members,
              COALESCE((SELECT json_agg(h ORDER BY h."startsAt" DESC) FROM (
                  SELECT e.id AS "employeeId", e.code, e.full_name AS "fullName",
                         to_char(l.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startsAt", to_char(l.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "endsAt"
                    FROM team_lead_assignment l JOIN employee e ON e.id = l.lead_employee_id
                   WHERE l.team_id = r.id ORDER BY l.starts_at DESC LIMIT 50) h), '[]'::json) AS "leadHistory"
         FROM team r WHERE %s AND r.id = CAST(%s AS uuid)`, leadWindow, memberWindow, scope.SQL, at(1)), args...)
	if err != nil {
		return authority.QueryResult[View]{}, err
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (View, error) {
		var view View
		err := row.Scan(&view.ID, &view.Name, &view.Version, &view.Lead, &view.Members, &view.LeadHistory)
		return view, err
	})
	if err != nil || len(found) == 0 {
		return authority.QueryResult[View]{}, err
	}
	return authority.QueryResult[View]{Found: true, Value: found[0]}, nil
}
