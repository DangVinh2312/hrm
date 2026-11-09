package workrequest

import (
	"encoding/json/v2"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
)

// readSubmitter is employee.submitRequest: the employee record this session may submit for, its own. Root
// is never linked to an employee, so it finds none.
func readSubmitter(c authority.QueryContext, _ struct{}) (authority.QueryResult[string], error) {
	var none authority.QueryResult[string]
	args, at, err := c.Scope.Args(c.Actor.ID)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`SELECT r.id::text AS id FROM employee r WHERE `+c.Scope.SQL+` AND r.account_id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return none, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(found) == 0 {
		return none, err
	}
	return authority.QueryResult[string]{Found: true, Value: found[0]}, nil
}

type listRow struct {
	Total string
	Items string
}

// readOwnRequests is workRequest.read, "my requests": the plan's scope and the caller's own current
// profile, before the count and the page (newest first).
func readOwnRequests(c authority.QueryContext, input ListQuery) (authority.QueryResult[ListView], error) {
	var none authority.QueryResult[ListView]
	args, at, err := c.Scope.Args(c.Actor.ID, input.Limit, input.Offset)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`WITH scoped AS (
         SELECT r.id, r.kind, r.state, r.version, r.team_id, r.created_at FROM work_request r
          WHERE `+c.Scope.SQL+`
            AND r.employee_id = (SELECT e.id FROM employee e WHERE e.account_id = CAST(`+at(1)+` AS uuid)))
       SELECT (SELECT count(*) FROM scoped)::text AS total,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'kind', p.kind, 'state', p.state,
                  'version', p.version::text, 'teamId', p.team_id, 'createdAt', `+instant("p.created_at")+`,
                  'startDate', `+date("g.first")+`, 'endDate', `+date("g.last")+`, 'minutes', g.minutes)
                  ORDER BY p.created_at DESC, p.id DESC)
                FROM (SELECT * FROM scoped ORDER BY created_at DESC, id DESC
                       LIMIT CAST(`+at(2)+` AS int8) OFFSET CAST(`+at(3)+` AS int8)) p
                CROSS JOIN LATERAL (SELECT min(s.work_date) AS first, max(s.work_date) AS last,
                       sum(s.minutes)::int AS minutes FROM work_request_segment s WHERE s.request_id = p.id) g),
                '[]'::json)::text AS items`, args...)
	if err != nil {
		return none, err
	}
	row, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[listRow])
	if err != nil {
		return none, err
	}
	view := ListView{Total: row.Total}
	if err := json.Unmarshal([]byte(row.Items), &view.Items, json.RejectUnknownMembers(true)); err != nil {
		return none, err
	}
	return authority.QueryResult[ListView]{Found: true, Value: view}, nil
}

type detailRow struct {
	ID, EmployeeID, TeamID, Kind, State, Version, Reason, CreatedAt string
	Segments, Decisions                                             string
}

// readDetail is one request under the caller's plan with its segments and decision history; absent and
// outside the plan are both not found.
func readDetail(c authority.QueryContext, requestID string) (authority.QueryResult[DetailView], error) {
	var none authority.QueryResult[DetailView]
	args, at, err := c.Scope.Args(requestID)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`SELECT r.id::text, r.employee_id::text AS "employeeId", r.team_id::text AS "teamId", r.kind, r.state,
            r.version::text AS version, r.reason, `+instant("r.created_at")+` AS "createdAt",
            COALESCE((SELECT json_agg(json_build_object('date', `+date("s.work_date")+`, 'startMinute', s.start_minute,
                'endMinute', s.end_minute, 'minutes', s.minutes) ORDER BY s.work_date)
              FROM work_request_segment s WHERE s.request_id = r.id), '[]'::json)::text AS segments,
            COALESCE((SELECT json_agg(json_build_object('stage', d.stage, 'decision', d.decision,
                'actorKind', d.actor_kind, 'systemReason', d.system_reason, 'reason', d.reason,
                'decidedAt', `+instant("d.decided_at")+`) ORDER BY d.decided_at, d.id)
              FROM request_decision d WHERE d.request_id = r.id), '[]'::json)::text AS decisions
       FROM work_request r WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return none, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[detailRow])
	if err != nil || len(found) == 0 {
		return none, err
	}
	r := found[0]
	view := DetailView{ID: r.ID, EmployeeID: r.EmployeeID, TeamID: r.TeamID, Kind: r.Kind, State: r.State, Version: r.Version, Reason: r.Reason, CreatedAt: r.CreatedAt}
	if err := json.Unmarshal([]byte(r.Segments), &view.Segments, json.RejectUnknownMembers(true)); err != nil {
		return none, err
	}
	if err := json.Unmarshal([]byte(r.Decisions), &view.Decisions, json.RejectUnknownMembers(true)); err != nil {
		return none, err
	}
	return authority.QueryResult[DetailView]{Found: true, Value: view}, nil
}
