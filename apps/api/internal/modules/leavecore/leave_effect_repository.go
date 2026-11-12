package leavecore

import (
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
)

var (
	ErrNoSegment         = errors.New("a leave request has no segment")
	ErrNotAnnualLeave    = errors.New("leave effect on a request that is not annual leave")
	ErrSpansTwoYears     = errors.New("a leave request spans two years")
	ErrMissingFacts      = errors.New("employee facts are missing")
	ErrDebitsMismatch    = errors.New("an approved leave request must have one debit per segment")
	errInsufficientLeave = apperror.Rejection{Code: "error.insufficientLeave"}
)

func yearOf(date string) (int, error) {
	if len(date) < 4 {
		return 0, ErrOutsideYear
	}
	return strconv.Atoi(date[:4])
}

func factsOf(tx *database.Tx, employeeID string, year int) (EmployeeFacts, error) {
	all, err := LoadFacts(tx, []string{employeeID}, year)
	if err != nil {
		return EmployeeFacts{}, err
	}
	facts, ok := all[employeeID]
	if !ok {
		return EmployeeFacts{}, ErrMissingFacts
	}
	return facts, nil
}

// overEntitlement is whether committed minutes break the invariant of spec §8 in some month.
func overEntitlement(facts EmployeeFacts, committed []DatedMinutes, year int) (bool, error) {
	entitled, err := Entitlement(facts)
	if err != nil {
		return false, err
	}
	monthly, err := MonthlyMinutes(committed, year)
	if err != nil {
		return false, err
	}
	return FirstMonthOver(entitled, monthly) != 0, nil
}

// AssertAvailable is the D09 check of a new annual-leave request, called by submit under the employee
// lock: approved + pending + the new segments up to the end of every month stay within the entitlement
// to its end, else 422 error.insufficientLeave. The numbers are the caller's own leave facts, reached
// only after the plan matched their own profile. No bucket lock: the employee lock serializes this
// account's submits, and a decision moves minutes from pending to approved without changing the sum.
func AssertAvailable(tx *database.Tx, employeeID string, segments []DatedMinutes) error {
	if len(segments) == 0 {
		return ErrNoSegment
	}
	year, err := yearOf(segments[0].Date)
	if err != nil {
		return err
	}
	facts, err := factsOf(tx, employeeID, year)
	if err != nil {
		return err
	}
	committed := append(append(append([]DatedMinutes{}, facts.Approved...), PendingDated(facts.Pending)...), segments...)
	over, err := overEntitlement(facts, committed, year)
	if err != nil {
		return err
	}
	if over {
		return errInsufficientLeave
	}
	return nil
}

type requestHead struct {
	EmployeeID string
	Kind       string
}

// LockBucket creates the leave bucket of (employee, year) if missing and holds it FOR UPDATE: every ledger
// write of that year serializes here.
func LockBucket(tx *database.Tx, employeeID string, year int) error {
	if _, err := tx.Exec(`INSERT INTO leave_bucket(employee_id, year) VALUES (CAST($1 AS uuid), $2) ON CONFLICT DO NOTHING`, employeeID, year); err != nil {
		return err
	}
	_, err := tx.Exec(`SELECT revision FROM leave_bucket WHERE employee_id = CAST($1 AS uuid) AND year = $2 FOR UPDATE`, employeeID, year)
	return err
}

// BumpBucket raises the revision of a bucket the caller holds after a ledger write.
func BumpBucket(tx *database.Tx, employeeID string, year int) error {
	_, err := tx.Exec(`UPDATE leave_bucket SET revision = revision + 1 WHERE employee_id = CAST($1 AS uuid) AND year = $2`, employeeID, year)
	return err
}

// ApplyApproved debits an approved annual-leave request: one ledger row per segment (UNIQUE per segment,
// so a replay fails instead of debiting twice). Only a decision transaction that authorized the actor,
// locked the request row and moves it to approved calls this. Lock order (spec §7.3): request (held) →
// bucket → writes. Refuses (409) a segment not on an official day and any month where approved leave plus
// this request would exceed the entitlement; other pending requests are not counted, so the first debit wins.
func ApplyApproved(tx *database.Tx, requestID string) error {
	rows, err := tx.Query(`SELECT employee_id::text, kind FROM work_request WHERE id = CAST($1 AS uuid)`, requestID)
	if err != nil {
		return err
	}
	head, err := pgx.CollectRows(rows, pgx.RowToStructByPos[requestHead])
	if err != nil {
		return err
	}
	if len(head) != 1 || head[0].Kind != "annual-leave" {
		return ErrNotAnnualLeave
	}
	employeeID := head[0].EmployeeID
	rows, err = tx.Query(`SELECT `+date("work_date")+`, minutes FROM work_request_segment
        WHERE request_id = CAST($1 AS uuid) ORDER BY work_date`, requestID)
	if err != nil {
		return err
	}
	segments, err := pgx.CollectRows(rows, pgx.RowToStructByPos[DatedMinutes])
	if err != nil {
		return err
	}
	if len(segments) == 0 {
		return ErrNoSegment
	}
	year, err := yearOf(segments[0].Date)
	if err != nil {
		return err
	}
	dates := make([]string, len(segments))
	for i, s := range segments {
		if y, err := yearOf(s.Date); err != nil || y != year {
			return ErrSpansTwoYears
		}
		dates[i] = s.Date
	}
	if err := LockBucket(tx, employeeID, year); err != nil {
		return err
	}
	rows, err = tx.Query(`SELECT count(*) FILTER (WHERE status IS DISTINCT FROM 'official') FROM (
         SELECT (SELECT p.status FROM employment_status_period p WHERE p.employee_id = CAST($1 AS uuid)
                  AND p.starts_on <= d AND (p.ends_on IS NULL OR p.ends_on > d)) AS status
           FROM unnest(CAST($2 AS date[])) AS d) x`, employeeID, dates)
	if err != nil {
		return err
	}
	notOfficial, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	if notOfficial > 0 {
		return apperror.ErrCommandRejected
	}
	facts, err := factsOf(tx, employeeID, year)
	if err != nil {
		return err
	}
	over, err := overEntitlement(facts, append(append([]DatedMinutes{}, facts.Approved...), segments...), year)
	if err != nil {
		return err
	}
	if over {
		return apperror.ErrCommandRejected
	}
	if _, err := tx.Exec(`INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, source_request_id, source_work_date)
       SELECT gen_random_uuid(), CAST($1 AS uuid), 'debit', s.work_date, s.minutes, s.request_id, s.work_date
         FROM work_request_segment s WHERE s.request_id = CAST($2 AS uuid)`, employeeID, requestID); err != nil {
		return err
	}
	return BumpBucket(tx, employeeID, year)
}

type reversalHead struct {
	EmployeeID string
	Kind       string
	Year       *int32
}

// ReverseApproved writes one reversal per debit of an approved annual-leave request being cancelled
// (D06, E-12); UNIQUE per debit, so a second reversal fails in the database. Only the cancellation
// transaction that locked the request and checked it is approved calls this. Lock order: request (held) →
// bucket → writes. Never refused for balance: giving minutes back cannot break the invariant.
func ReverseApproved(tx *database.Tx, requestID string) error {
	rows, err := tx.Query(`SELECT r.employee_id::text, r.kind,
              (SELECT EXTRACT(year FROM min(s.work_date))::int FROM work_request_segment s WHERE s.request_id = r.id)
         FROM work_request r WHERE r.id = CAST($1 AS uuid)`, requestID)
	if err != nil {
		return err
	}
	head, err := pgx.CollectRows(rows, pgx.RowToStructByPos[reversalHead])
	if err != nil {
		return err
	}
	if len(head) != 1 || head[0].Kind != "annual-leave" || head[0].Year == nil {
		return ErrNotAnnualLeave
	}
	employeeID, year := head[0].EmployeeID, int(*head[0].Year)
	if err := LockBucket(tx, employeeID, year); err != nil {
		return err
	}
	reversed, err := tx.Exec(`INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reverses_entry_id)
       SELECT gen_random_uuid(), d.employee_id, 'reversal', d.effective_on, d.minutes, d.id
         FROM leave_ledger d WHERE d.source_request_id = CAST($1 AS uuid) AND d.entry_kind = 'debit'`, requestID)
	if err != nil {
		return err
	}
	rows, err = tx.Query(`SELECT count(*) FROM work_request_segment WHERE request_id = CAST($1 AS uuid)`, requestID)
	if err != nil {
		return err
	}
	segments, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[int64])
	if err != nil {
		return err
	}
	if reversed.RowsAffected() == 0 || reversed.RowsAffected() != segments {
		return ErrDebitsMismatch
	}
	return BumpBucket(tx, employeeID, year)
}
