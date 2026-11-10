package attendance

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/permission"
)

const adjustOperation = "attendance.adjust"

var errKeyReused = apperror.Rejection{Code: "error.idempotencyKeyReused"}

type adjustCommand struct {
	AdjustmentInput
	// Hash is the SHA-256 hex of the payload, computed outside SQL.
	Hash string
}

// adjustmentHash hashes the array [employeeId, workDate, minutes, reason, reference] as JSON.stringify writes
// it, an omitted reference as null; the key is not hashed. encoding/json v2 escapes only what JSON requires,
// as JSON.stringify does; v1 would also escape <, >, &, U+2028 and U+2029.
func adjustmentHash(input AdjustmentInput) (string, error) {
	var elements [5][]byte
	var errs [5]error
	elements[0], errs[0] = json.Marshal(input.EmployeeID)
	elements[1], errs[1] = json.Marshal(input.WorkDate)
	elements[2], errs[2] = json.Marshal(input.Minutes)
	elements[3], errs[3] = json.Marshal(input.Reason)
	elements[4], errs[4] = json.Marshal(input.Reference)
	if err := errors.Join(errs[:]...); err != nil {
		return "", err
	}
	payload := append(append([]byte{'['}, bytes.Join(elements[:], []byte{','})...), ']')
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

type storedClaim struct {
	Hash   string
	Result string
}

// priorClaim is the claim of this actor and key, if one committed.
func priorClaim(c authority.CommandContext, key string) (*hrbase.Claim[AdjustmentResult], error) {
	rows, err := c.Tx.Query(`SELECT payload_hash AS hash, result::text AS result FROM hr_idempotency
        WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`, c.Actor.ID, adjustOperation, key)
	if err != nil {
		return nil, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[storedClaim])
	if err != nil || len(stored) == 0 {
		return nil, err
	}
	var result AdjustmentResult
	if err := json.Unmarshal([]byte(stored[0].Result), &result, json.RejectUnknownMembers(true)); err != nil {
		return nil, err
	}
	return &hrbase.Claim[AdjustmentResult]{Hash: stored[0].Hash, Result: result}, nil
}

// runAdjust is employee.adjustAttendance (HR, fresh session, open month): ONE signed paid-minutes entry for
// the employee Execute locked, on one day of their employment. Lock order: fence → employee (held by
// Execute) → idempotency read → month FOR SHARE (closed: 409 error.periodClosed) → calendar FOR SHARE →
// entry, claim, audit. A close takes the month FOR UPDATE, so it waits for this or finds the entry. The
// month's paid total with the entry stays >= 0, judged on the sheet's own read under these locks; two
// adjustments of one employee are serialized by the employee lock.
// shortcut: approving unpaid leave, a termination or a calendar change do not re-check the total (they take
// no employee lock); a month driven below zero that way shows as is and HR corrects it with a positive entry.
func runAdjust(c authority.CommandContext, input adjustCommand) (AdjustmentResult, error) {
	// Nobody adjusts their own attendance: the link is read under the employee lock, before the claim, so
	// the refusal burns no key. Root is never linked.
	linked, err := one[*bool](c.Tx, `SELECT account_id = $2 AS linked FROM employee WHERE id = $1`, c.Target.Key, c.Actor.ID)
	if err != nil {
		return AdjustmentResult{}, err
	}
	if linked != nil && *linked {
		return AdjustmentResult{}, apperror.ErrAccessDenied
	}
	prior, err := priorClaim(c, input.IdempotencyKey)
	if err != nil {
		return AdjustmentResult{}, err
	}
	if prior != nil {
		result, err := hrbase.Replay(*prior, input.Hash)
		if err != nil {
			return AdjustmentResult{}, err
		}
		return authority.Replay(result)
	}
	employed, err := one[bool](c.Tx, `SELECT hired_on <= CAST($2 AS date)
              AND (terminated_on IS NULL OR terminated_on >= CAST($2 AS date)) AS employed
         FROM employee WHERE id = $1`, c.Target.Key, input.WorkDate)
	if err != nil {
		return AdjustmentResult{}, err
	}
	if !employed {
		return AdjustmentResult{}, apperror.ErrCommandRejected
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, []string{input.WorkDate}); err != nil {
		return AdjustmentResult{}, err
	}
	if _, err := c.Tx.Exec(`SELECT 1 FROM work_calendar WHERE id = CAST($1 AS uuid) FOR SHARE`, permission.WorkCalendarID); err != nil {
		return AdjustmentResult{}, err
	}
	month := input.WorkDate[:7]
	facts, err := attendancecore.LoadFacts(c.Tx, month, []string{c.Target.Key})
	if err != nil {
		return AdjustmentResult{}, err
	}
	if len(facts) != 1 {
		return AdjustmentResult{}, errMissingFacts
	}
	totals, err := attendancecore.TotalsOf(month, facts[0])
	if err != nil {
		return AdjustmentResult{}, err
	}
	if totals.PaidMinutes+input.Minutes < 0 {
		return AdjustmentResult{}, apperror.ErrCommandRejected
	}
	id, err := one[string](c.Tx, `INSERT INTO attendance_adjustment(id, employee_id, work_date, minutes, reason, reference, actor_account_id)
       VALUES (gen_random_uuid(), $1, CAST($2 AS date), $3, $4, $5, $6) RETURNING id::text`,
		c.Target.Key, input.WorkDate, input.Minutes, input.Reason, input.Reference, c.Actor.ID)
	if err != nil {
		return AdjustmentResult{}, err
	}
	result := AdjustmentResult{ID: id}
	stored, err := json.Marshal(result)
	if err != nil {
		return AdjustmentResult{}, err
	}
	// One key for two employees is not serialized by an employee lock: the later claim waits for the first
	// and then inserts nothing, a reused key.
	rows, err := c.Tx.Query(`INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
       VALUES($1,$2,CAST($3 AS uuid),$4,$5,CAST($6 AS jsonb))
       ON CONFLICT DO NOTHING RETURNING 1`, c.Actor.ID, adjustOperation, input.IdempotencyKey, input.Hash, c.Target.Key, string(stored))
	if err != nil {
		return AdjustmentResult{}, err
	}
	claimed, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		return AdjustmentResult{}, err
	}
	if len(claimed) != 1 {
		return AdjustmentResult{}, errKeyReused
	}
	// Ids and kind only: the minutes, the day, the reason and the reference stay out of audit.
	target := authority.AuditTarget{Resource: string(keys.EmployeeResourceEmployee), Key: c.Target.Key, ObjectID: c.Target.ObjectID}
	if err := c.Audit(audit.KindHRAttendanceAdjust, target, nil); err != nil {
		return AdjustmentResult{}, err
	}
	return result, nil
}
