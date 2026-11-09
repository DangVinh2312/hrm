package workrequest

import (
	"encoding/json/v2"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/hrbase"
)

type lockedRow struct {
	Kind     hrbase.RequestKind
	State    string
	Version  string
	Self     bool
	Approver bool
}

// lockedRequest is the request Execute locked, whether it is the actor's own and whether the actor is its
// current first-step approver.
func lockedRequest(tx *database.Tx, requestID, actorID string) (*lockedRow, error) {
	rows, err := tx.Query(`SELECT r.kind, r.state, r.version::text AS version,
                (r.owner_account_id = $2 OR e.account_id IS NOT DISTINCT FROM CAST($2 AS uuid)) AS self,
                EXISTS (SELECT 1 FROM hr_request_lead l
                         WHERE l.request_id = r.id AND l.lead_account_id = $2) AS approver
           FROM work_request r JOIN employee e ON e.id = r.employee_id WHERE r.id = $1`, requestID, actorID)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[lockedRow])
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return &found[0], nil
}

type cancelRow struct {
	Kind    hrbase.RequestKind
	State   string
	Version string
}

// requestToCancel is the request Execute locked for a cancellation.
func requestToCancel(tx *database.Tx, requestID string) (*cancelRow, error) {
	rows, err := tx.Query(`SELECT kind, state, version::text AS version FROM work_request WHERE id = $1`, requestID)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[cancelRow])
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return &found[0], nil
}

// moveRequest moves the request from state to next at version; "" when it moved on meanwhile.
func moveRequest(tx *database.Tx, requestID, version, next, from string) (string, error) {
	rows, err := tx.Query(`WITH updated AS (UPDATE work_request SET state = $3, version = version + 1
            WHERE id = $1 AND version = CAST($2 AS int8) AND state = $4
            RETURNING version::text AS version)
         SELECT version FROM updated`, requestID, version, next, from)
	if err != nil {
		return "", err
	}
	updated, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(updated) == 0 {
		return "", err
	}
	return updated[0], nil
}

func insertDecision(tx *database.Tx, requestID, stage, decision, actorID string, reason *string) error {
	_, err := tx.Exec(`INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,reason)
         VALUES(gen_random_uuid(),$1,$2,$3,'user',$4,$5)`, requestID, stage, decision, actorID, reason)
	return err
}

// claimMove is false when the key was claimed meanwhile by a move of another request.
func claimMove(tx *database.Tx, actorID, operation, key, hash, targetID string, result SubmitResult) (bool, error) {
	stored, err := json.Marshal(result)
	if err != nil {
		return false, err
	}
	rows, err := tx.Query(`INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
         VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))
         ON CONFLICT DO NOTHING RETURNING 1`, actorID, operation, key, hash, targetID, string(stored))
	if err != nil {
		return false, err
	}
	claimed, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	return len(claimed) == 1, err
}

type factsRow struct {
	State   string
	Version string
	Owner   bool
	Prior   *string
}

// readFacts is workRequest.read on the requested record: its state and version, whether the caller owns it,
// and this actor's claim of the key under operation if any. Absent and unreadable are both not found.
func readFacts(operation string) func(authority.QueryContext, factsKey) (authority.QueryResult[requestFacts], error) {
	return func(c authority.QueryContext, input factsKey) (authority.QueryResult[requestFacts], error) {
		var none authority.QueryResult[requestFacts]
		args, at, err := c.Scope.Args(input.RequestID, c.Actor.ID, operation, input.IdempotencyKey)
		if err != nil {
			return none, err
		}
		rows, err := c.Tx.Query(`SELECT r.state, r.version::text AS version,
              (r.owner_account_id = CAST(`+at(2)+` AS uuid)) AS owner,
              (SELECT json_build_object('hash', i.payload_hash, 'result', i.result) FROM hr_idempotency i
                WHERE i.actor_id = CAST(`+at(2)+` AS uuid) AND i.operation = `+at(3)+`
                  AND i.key = CAST(`+at(4)+` AS uuid))::text AS prior
         FROM work_request r WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
		if err != nil {
			return none, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[factsRow])
		if err != nil || len(found) == 0 {
			return none, err
		}
		facts := requestFacts{State: found[0].State, Version: found[0].Version, Owner: found[0].Owner}
		if found[0].Prior != nil {
			var prior struct {
				Hash   string       `json:"hash"`
				Result SubmitResult `json:"result"`
			}
			if err := json.Unmarshal([]byte(*found[0].Prior), &prior, json.RejectUnknownMembers(true)); err != nil {
				return none, err
			}
			facts.Prior = &hrbase.Claim[SubmitResult]{Hash: prior.Hash, Result: prior.Result}
		}
		return authority.QueryResult[requestFacts]{Found: true, Value: facts}, nil
	}
}

// readQueue is the caller's queue of one stage: the stage permission's plan (stage policy included), the
// stage's state and not the caller's own request, before count and page, oldest first. The lead queue also
// requires the caller to be the current first-step approver, which the IAM plan already implies and Root
// never is.
func readQueue(s stage) func(authority.QueryContext, ListQuery) (authority.QueryResult[ApprovalView], error) {
	return func(c authority.QueryContext, input ListQuery) (authority.QueryResult[ApprovalView], error) {
		var none authority.QueryResult[ApprovalView]
		args, at, err := c.Scope.Args(c.Actor.ID, input.Limit, input.Offset)
		if err != nil {
			return none, err
		}
		state, approver := statePendingFinal, ""
		if s == stageLead {
			state = statePendingLead
			approver = `AND EXISTS (SELECT 1 FROM hr_request_lead l WHERE l.request_id = r.id
                            AND l.lead_account_id = CAST(` + at(1) + ` AS uuid))`
		}
		rows, err := c.Tx.Query(`WITH scoped AS (
           SELECT r.id, r.employee_id, r.kind, r.state, r.version, r.team_id, r.created_at FROM work_request r
            WHERE `+c.Scope.SQL+` AND r.state = '`+state+`'
              AND r.owner_account_id <> CAST(`+at(1)+` AS uuid) `+approver+`)
         SELECT (SELECT count(*) FROM scoped)::text AS total,
                COALESCE((SELECT json_agg(json_build_object('id', p.id, 'employeeId', p.employee_id,
                    'kind', p.kind, 'state', p.state, 'version', p.version::text, 'teamId', p.team_id,
                    'createdAt', `+instant("p.created_at")+`, 'startDate', `+date("g.first")+`,
                    'endDate', `+date("g.last")+`, 'minutes', g.minutes) ORDER BY p.created_at, p.id)
                  FROM (SELECT * FROM scoped ORDER BY created_at, id
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
		view := ApprovalView{Total: row.Total}
		if err := json.Unmarshal([]byte(row.Items), &view.Items, json.RejectUnknownMembers(true)); err != nil {
			return none, err
		}
		return authority.QueryResult[ApprovalView]{Found: true, Value: view}, nil
	}
}

// readDecided is the history of workRequest.readDecided's plan (the request's current first-step approver
// for a lead, the company for the COO, everything for Root), decided and not the caller's own, before count
// and page. Decided is approved or rejected, or a person's lead or final decision. Each row carries its
// latest lead/final decision and the owner's full name only; latest first, ties by id.
// shortcut: the sort key is computed for every scoped row before the page; add a stored "last decided at"
// column and index if a scope grows past a few thousand requests.
func readDecided(c authority.QueryContext, input ListQuery) (authority.QueryResult[DecidedView], error) {
	var none authority.QueryResult[DecidedView]
	args, at, err := c.Scope.Args(c.Actor.ID, input.Limit, input.Offset)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`WITH scoped AS (
         SELECT r.id, r.employee_id, e.full_name, r.kind, r.state, r.version, r.team_id, r.created_at,
                last_decision.stage, last_decision.decision, last_decision.actor_kind,
                last_decision.decided_at
           FROM work_request r JOIN employee e ON e.id = r.employee_id
           CROSS JOIN LATERAL (SELECT d.stage, d.decision, d.actor_kind, d.decided_at
                 FROM request_decision d WHERE d.request_id = r.id AND d.stage IN ('lead','final')
                ORDER BY d.decided_at DESC, (d.stage = 'final') DESC LIMIT 1) last_decision
          WHERE `+c.Scope.SQL+` AND r.owner_account_id <> CAST(`+at(1)+` AS uuid)
            AND (r.state IN ('approved','rejected')
                 OR EXISTS (SELECT 1 FROM request_decision u WHERE u.request_id = r.id
                             AND u.actor_kind = 'user' AND u.stage IN ('lead','final'))))
       SELECT (SELECT count(*) FROM scoped)::text AS total,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'employeeId', p.employee_id,
                  'employeeName', p.full_name,
                  'kind', p.kind, 'state', p.state, 'version', p.version::text, 'teamId', p.team_id,
                  'createdAt', `+instant("p.created_at")+`, 'startDate', `+date("g.first")+`,
                  'endDate', `+date("g.last")+`, 'minutes', g.minutes,
                  'decision', json_build_object('stage', p.stage, 'decision', p.decision,
                    'actorKind', p.actor_kind, 'decidedAt', `+instant("p.decided_at")+`))
                  ORDER BY p.decided_at DESC, p.id DESC)
                FROM (SELECT * FROM scoped ORDER BY decided_at DESC, id DESC
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
	view := DecidedView{Total: row.Total}
	if err := json.Unmarshal([]byte(row.Items), &view.Items, json.RejectUnknownMembers(true)); err != nil {
		return none, err
	}
	return authority.QueryResult[DecidedView]{Found: true, Value: view}, nil
}
