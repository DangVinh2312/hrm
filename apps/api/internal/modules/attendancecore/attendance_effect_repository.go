package attendancecore

import (
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/hrbase"
	"hrm/api/internal/modules/settingcore"
)

var (
	ErrMissingRequest = errors.New("effect on a missing request")
	ErrNoSegment      = errors.New("a request has no segment")
	ErrNotWfh         = errors.New("WFH effect on a request that is not WFH")
	errWfhLimit       = apperror.Rejection{Code: "error.wfhLimitAckRequired"}
)

type approvedRequest struct {
	employeeID string
	kind       hrbase.RequestKind
	dates      []string
}

type requestHead struct {
	EmployeeID string
	Kind       string
}

func loadApproved(tx *database.Tx, requestID string) (approvedRequest, error) {
	rows, err := tx.Query(`SELECT employee_id::text, kind FROM work_request WHERE id = CAST($1 AS uuid)`, requestID)
	if err != nil {
		return approvedRequest{}, err
	}
	head, err := pgx.CollectRows(rows, pgx.RowToStructByPos[requestHead])
	if err != nil {
		return approvedRequest{}, err
	}
	if len(head) != 1 {
		return approvedRequest{}, ErrMissingRequest
	}
	rows, err = tx.Query(`SELECT `+date("work_date")+` FROM work_request_segment
          WHERE request_id = CAST($1 AS uuid) ORDER BY work_date`, requestID)
	if err != nil {
		return approvedRequest{}, err
	}
	dates, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return approvedRequest{}, err
	}
	if len(dates) == 0 {
		return approvedRequest{}, ErrNoSegment
	}
	return approvedRequest{head[0].EmployeeID, hrbase.RequestKind(head[0].Kind), dates}, nil
}

// ApplyApprovedAttendance is the attendance effect of an approval: the approved request IS the effect (the
// sheet reads approved segments), so what remains is D07 — every month it touches is open and locked FOR
// SHARE until commit. Only a decision transaction that authorized the actor and locked the request calls
// this (lock order: request → bucket → period, spec §7.3).
func ApplyApprovedAttendance(tx *database.Tx, requestID string) error {
	request, err := loadApproved(tx, requestID)
	if err != nil {
		return err
	}
	return AssertPeriodsOpen(tx, request.dates)
}

func daysIn(dates []string, month string) int {
	n := 0
	for _, d := range dates {
		if first, err := FirstOfMonth(d); err == nil && first == month {
			n++
		}
	}
	return n
}

// lockCounters upserts and locks the WFH counter of every month, ascending, before any count is read, so two
// approvals racing for the last day serialize even when the month has no row yet. It returns the counts.
func lockCounters(tx *database.Tx, employeeID string, months []string) ([]int, error) {
	counts := make([]int, 0, len(months))
	for _, month := range months {
		if _, err := tx.Exec(`INSERT INTO wfh_month_counter(employee_id, month) VALUES (CAST($1 AS uuid), CAST($2 AS date))
         ON CONFLICT DO NOTHING`, employeeID, month); err != nil {
			return nil, err
		}
		rows, err := tx.Query(`SELECT approved_count FROM wfh_month_counter
          WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date) FOR UPDATE`, employeeID, month)
		if err != nil {
			return nil, err
		}
		count, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[int32])
		if err != nil {
			return nil, err
		}
		counts = append(counts, int(count))
	}
	return counts, nil
}

func moveCounters(tx *database.Tx, request approvedRequest, months []string, sign int) error {
	for _, month := range months {
		if _, err := tx.Exec(`UPDATE wfh_month_counter SET approved_count = approved_count + $3, revision = revision + 1
          WHERE employee_id = CAST($1 AS uuid) AND month = CAST($2 AS date)`, request.employeeID, month, sign*daysIn(request.dates, month)); err != nil {
			return err
		}
	}
	return nil
}

// ApplyApprovedWfh moves the WFH counters of an approval (D04): a month that would pass hr.wfhMonthLimit is
// refused with error.wfhLimitAckRequired unless the approver acknowledged it. Raised only inside the final
// decision, after the plan matched the request for the approver. Request lock held by the caller.
func ApplyApprovedWfh(tx *database.Tx, requestID string, acknowledged bool) error {
	request, err := loadApproved(tx, requestID)
	if err != nil {
		return err
	}
	if request.kind != hrbase.RequestWfh {
		return ErrNotWfh
	}
	months, err := MonthsOf(request.dates)
	if err != nil {
		return err
	}
	counts, err := lockCounters(tx, request.employeeID, months)
	if err != nil {
		return err
	}
	if !acknowledged {
		values, err := settingcore.Read(tx, []settingcore.Key{settingcore.KeyWfhMonthLimit})
		if err != nil {
			return err
		}
		limit := int(values[settingcore.KeyWfhMonthLimit].Int)
		for i, month := range months {
			if counts[i]+daysIn(request.dates, month) > limit {
				return errWfhLimit
			}
		}
	}
	return moveCounters(tx, request, months, 1)
}

// ReverseApprovedWfh releases the counters of an approved WFH request being cancelled (D06), under the same
// locks as the approval. It runs once: only the cancellation that moved the request out of approved calls
// it, and the CHECK approved_count >= 0 refuses a double release.
func ReverseApprovedWfh(tx *database.Tx, requestID string) error {
	request, err := loadApproved(tx, requestID)
	if err != nil {
		return err
	}
	if request.kind != hrbase.RequestWfh {
		return ErrNotWfh
	}
	months, err := MonthsOf(request.dates)
	if err != nil {
		return err
	}
	if _, err := lockCounters(tx, request.employeeID, months); err != nil {
		return err
	}
	return moveCounters(tx, request, months, -1)
}

type monthCount struct {
	Month string
	Count int32
}

// WfhLimitExceeded is the submit warning (D-07): approved WFH days of the months of dates plus these dates
// pass limit. A plain read without lock: the approver rechecks under the counter lock.
func WfhLimitExceeded(tx *database.Tx, employeeID string, dates []string, limit int) (bool, error) {
	months, err := MonthsOf(dates)
	if err != nil {
		return false, err
	}
	rows, err := tx.Query(`SELECT `+date("month")+`, approved_count FROM wfh_month_counter
        WHERE employee_id = CAST($1 AS uuid) AND month = ANY(CAST($2 AS date[]))`, employeeID, months)
	if err != nil {
		return false, err
	}
	stored, err := pgx.CollectRows(rows, pgx.RowToStructByPos[monthCount])
	if err != nil {
		return false, err
	}
	counts := map[string]int{}
	for _, row := range stored {
		counts[row.Month] = int(row.Count)
	}
	for _, month := range months {
		if counts[month]+daysIn(dates, month) > limit {
			return true, nil
		}
	}
	return false, nil
}
