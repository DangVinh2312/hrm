package workrequest

import (
	"encoding/json/v2"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
	"hrm/api/internal/modules/hrbase"
	"hrm/api/internal/modules/permission"
)

const submitOperation = "workRequest.submit"

var errNoCalendar = errors.New("work calendar anchor is missing")

func date(column string) string { return "to_char(" + column + ",'YYYY-MM-DD')" }

func instant(column string) string {
	return "to_char(" + column + ` AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

type storedClaim struct {
	Hash   string
	Result string
}

// priorClaim is the claim of this actor, operation and key, if one committed.
func priorClaim(tx *database.Tx, actorID, operation, key string) (*hrbase.Claim[SubmitResult], error) {
	rows, err := tx.Query(`SELECT payload_hash AS hash, result::text AS result FROM hr_idempotency
        WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`, actorID, operation, key)
	if err != nil {
		return nil, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedClaim])
	if err != nil || len(stored) == 0 {
		return nil, err
	}
	var result SubmitResult
	if err := json.Unmarshal([]byte(stored[0].Result), &result, json.RejectUnknownMembers(true)); err != nil {
		return nil, err
	}
	return &hrbase.Claim[SubmitResult]{Hash: stored[0].Hash, Result: result}, nil
}

type submitterFacts struct {
	Earliest string
	Latest   string
	Team     *string
	Leads    bool
	Calendar *string
}

// readSubmitterFacts is the window, the chosen current team (the primary one for nil), whether the
// submitter leads it, and the calendar version locked FOR SHARE. Nil when the locked employee is not the
// session's own profile any more.
func readSubmitterFacts(tx *database.Tx, employeeID, actorID string, teamID *string, pastDays, futureDays int64) (*submitterFacts, error) {
	lead, err := hrbase.CurrentWindow("l")
	if err != nil {
		return nil, err
	}
	membership, err := hrbase.CurrentWindow("m")
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(`SELECT `+date(hrbase.BusinessToday+` - CAST($5 AS int)`)+` AS earliest,
              `+date(hrbase.BusinessToday+` + CAST($6 AS int)`)+` AS latest,
              m.team_id::text AS team,
              EXISTS (SELECT 1 FROM team_lead_assignment l WHERE l.team_id = m.team_id
                       AND l.lead_employee_id = e.id AND `+lead+`) AS leads,
              (SELECT c.version::text FROM work_calendar c WHERE c.id = $4 FOR SHARE) AS calendar
         FROM employee e
         LEFT JOIN team_membership m ON m.employee_id = e.id AND `+membership+`
              AND (CASE WHEN CAST($3 AS uuid) IS NULL THEN m.is_primary ELSE m.team_id = CAST($3 AS uuid) END)
        WHERE e.id = $1 AND e.account_id = $2`, employeeID, actorID, teamID, permission.WorkCalendarID, pastDays, futureDays)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[submitterFacts])
	if err != nil || len(found) == 0 {
		return nil, err
	}
	if found[0].Calendar == nil {
		return nil, errNoCalendar
	}
	return &found[0], nil
}

type dayStatus struct {
	Day    string
	Status *string
}

// statusesOn is the employment status period covering each date, "" outside employment.
func statusesOn(tx *database.Tx, employeeID string, dates []string) (map[string]string, error) {
	rows, err := tx.Query(`SELECT `+date("d")+` AS day,
              (SELECT p.status FROM employment_status_period p WHERE p.employee_id = $1
                 AND p.starts_on <= d AND (p.ends_on IS NULL OR p.ends_on > d)) AS status
         FROM unnest(CAST($2 AS date[])) AS d`, employeeID, dates)
	if err != nil {
		return nil, err
	}
	days, err := pgx.CollectRows(rows, pgx.RowToStructByPos[dayStatus])
	if err != nil {
		return nil, err
	}
	statuses := make(map[string]string, len(days))
	for _, d := range days {
		if d.Status != nil {
			statuses[d.Day] = *d.Status
		}
	}
	return statuses, nil
}

// bookedOn are the segments of this employee's pending and approved requests on dates.
func bookedOn(tx *database.Tx, employeeID string, dates []string) ([]bookedSegment, error) {
	rows, err := tx.Query(`SELECT r.kind, `+date("s.work_date")+` AS date, s.start_minute AS "startMinute", s.end_minute AS "endMinute"
         FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
        WHERE r.employee_id = $1 AND r.state IN ('pending_lead','pending_final','approved')
          AND s.work_date = ANY(CAST($2 AS date[]))`, employeeID, dates)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[bookedSegment])
}

func newRequestID(tx *database.Tx) (string, error) {
	rows, err := tx.Query(`SELECT gen_random_uuid()::text`)
	if err != nil {
		return "", err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
}

type newRequest struct {
	ID, ObjectID, EmployeeID, OwnerAccountID, TeamID string
	Kind                                             hrbase.RequestKind
	State, Reason                                    string
}

func insertRequest(tx *database.Tx, r newRequest, segments []Segment) error {
	if _, err := tx.Exec(`INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, r.ID, r.ObjectID, r.EmployeeID, r.OwnerAccountID, r.TeamID, string(r.Kind), r.State, r.Reason); err != nil {
		return err
	}
	dates := make([]string, len(segments))
	starts, ends, minutes := make([]int, len(segments)), make([]int, len(segments)), make([]int, len(segments))
	for i, s := range segments {
		dates[i], starts[i], ends[i], minutes[i] = s.Date, s.StartMinute, s.EndMinute, s.Minutes
	}
	_, err := tx.Exec(`INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
       SELECT $1, $2, s.d, s.a, s.b, s.m
         FROM unnest(CAST($3 AS date[]), CAST($4 AS int2[]), CAST($5 AS int2[]), CAST($6 AS int2[])) AS s(d,a,b,m)`,
		r.ID, string(r.Kind), dates, starts, ends, minutes)
	return err
}

func approveSelf(tx *database.Tx, id string) error {
	_, err := tx.Exec(`UPDATE work_request SET state = 'approved' WHERE id = $1 AND state = 'pending_final'`, id)
	return err
}

func insertSystemDecision(tx *database.Tx, id string, s start) error {
	stage, decision := "lead", "skip"
	if s.State == stateApproved {
		stage, decision = "final", "approve"
	}
	_, err := tx.Exec(`INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,system_reason)
         VALUES(gen_random_uuid(),$1,$2,$3,'system',$4)`, id, stage, decision, s.SystemDecision)
	return err
}

func insertClaim(tx *database.Tx, actorID, key, hash, targetID string, result SubmitResult) error {
	stored, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
       VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))`, actorID, submitOperation, key, hash, targetID, string(stored))
	return err
}
