package leave

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"strconv"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/hrbase"
	"hrm/api/internal/modules/leavecore"
)

const adjustOperation = "leave.adjust"

var errKeyReused = apperror.Rejection{Code: "error.idempotencyKeyReused"}

type adjustCommand struct {
	AdjustmentInput
	// Hash is the SHA-256 hex of the payload, computed outside SQL.
	Hash string
}

// adjustmentHash hashes the array [employeeId, minutes, effectiveOn, reference] as JSON.stringify writes it;
// the key is not hashed. encoding/json v2 escapes only what JSON requires, as JSON.stringify does; v1 would
// also escape <, >, &, U+2028 and U+2029.
func adjustmentHash(input AdjustmentInput) (string, error) {
	payload := []byte{'['}
	for i, value := range []string{input.EmployeeID, strconv.Itoa(input.Minutes), input.EffectiveOn, input.Reference} {
		if i > 0 {
			payload = append(payload, ',')
		}
		if i == 1 {
			payload = append(payload, value...)
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", err
		}
		payload = append(payload, encoded...)
	}
	sum := sha256.Sum256(append(payload, ']'))
	return hex.EncodeToString(sum[:]), nil
}

type storedClaim struct {
	Hash   string
	Result string
}

// priorClaim is the claim of this actor and key, if one committed.
func priorClaim(tx *database.Tx, actorID, key string) (*hrbase.Claim[AdjustmentResult], error) {
	rows, err := tx.Query(`SELECT payload_hash AS hash, result::text AS result FROM hr_idempotency
        WHERE actor_id = $1 AND operation = $2 AND key = CAST($3 AS uuid)`, actorID, adjustOperation, key)
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

func hiredBy(tx *database.Tx, employeeID, date string) (bool, error) {
	rows, err := tx.Query(`SELECT hired_on <= CAST($2 AS date) AS valid FROM employee WHERE id = $1`, employeeID, date)
	if err != nil {
		return false, err
	}
	valid, err := pgx.CollectRows(rows, pgx.RowTo[bool])
	return len(valid) == 1 && valid[0], err
}

// runAdjust is employee.adjustLeaveBalance (HR, fresh session): one signed `adjustment` entry of the employee
// the authority locked, dated in an open month (409 error.periodClosed) and not before the hire date (409).
// Lock order (spec §7.3): fence → employee (held by Execute) → idempotency read → bucket of (employee, year)
// FOR UPDATE → period of the month FOR SHARE → entry, revision, claim, audit. A negative entry may take the
// entitlement below what is approved or pending; that shows in the reconciliation list (spec §9).
func runAdjust(c authority.CommandContext, input adjustCommand) (AdjustmentResult, error) {
	prior, err := priorClaim(c.Tx, c.Actor.ID, input.IdempotencyKey)
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
	hired, err := hiredBy(c.Tx, c.Target.Key, input.EffectiveOn)
	if err != nil {
		return AdjustmentResult{}, err
	}
	if !hired {
		return AdjustmentResult{}, apperror.ErrCommandRejected
	}
	year, err := strconv.Atoi(input.EffectiveOn[:4])
	if err != nil {
		return AdjustmentResult{}, err
	}
	if err := leavecore.LockBucket(c.Tx, c.Target.Key, year); err != nil {
		return AdjustmentResult{}, err
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, []string{input.EffectiveOn}); err != nil {
		return AdjustmentResult{}, err
	}
	rows, err := c.Tx.Query(`INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
        VALUES (gen_random_uuid(), $1, 'adjustment', CAST($2 AS date), $3, $4) RETURNING id::text`, c.Target.Key, input.EffectiveOn, input.Minutes, input.Reference)
	if err != nil {
		return AdjustmentResult{}, err
	}
	id, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return AdjustmentResult{}, err
	}
	result := AdjustmentResult{ID: id}
	if err := leavecore.BumpBucket(c.Tx, c.Target.Key, year); err != nil {
		return AdjustmentResult{}, err
	}
	stored, err := json.Marshal(result)
	if err != nil {
		return AdjustmentResult{}, err
	}
	// One key for two employees is not serialized by an employee lock: the later claim waits for the first
	// and then inserts nothing, a reused key.
	rows, err = c.Tx.Query(`INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
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
	target := authority.AuditTarget{Resource: string(keys.EmployeeResourceEmployee), Key: c.Target.Key, ObjectID: c.Target.ObjectID}
	if err := c.Audit(audit.KindHRLeaveAdjust, target, nil); err != nil {
		return AdjustmentResult{}, err
	}
	return result, nil
}
