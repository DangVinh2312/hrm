//go:build integration

package attendancecore_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/settingcore"
)

func wfhCounter(f *hr, employee, month string) (count, revision int) {
	f.t.Helper()
	mustDB(f.t, f.conn.QueryRow(f.t.Context(), `SELECT COALESCE(max(approved_count),-1)::int, COALESCE(max(revision),0)::int
      FROM wfh_month_counter WHERE employee_id = $1 AND month = CAST($2 AS date)`, employee, month).Scan(&count, &revision))
	return count, revision
}

func applyWfh(t *testing.T, f *hr, request string, acknowledged bool) error {
	return write(t, f.s, func(tx *database.Tx) error { return attendancecore.ApplyApprovedWfh(tx, request, acknowledged) })
}

func reverseWfh(t *testing.T, f *hr, request string) error {
	return write(t, f.s, func(tx *database.Tx) error { return attendancecore.ReverseApprovedWfh(tx, request) })
}

func isRejection(err error, code apperror.Code) bool {
	rejection, ok := errors.AsType[apperror.Rejection](err)
	return ok && rejection.Code == code
}

func TestApprovedWfhCountersLimitAcknowledgementAndRelease(t *testing.T) {
	f := newHR(t)
	e := f.employee("2026-01-05", nil)
	march := f.request(e, "wfh", "approved", []string{"2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"}, 540, 1080)
	edge := f.request(e, "wfh", "approved", []string{"2026-03-31", "2026-04-01"}, 540, 1080)
	more := f.request(e, "wfh", "approved", []string{"2026-03-09", "2026-03-10"}, 540, 1080)
	last := f.request(e, "wfh", "approved", []string{"2026-03-11"}, 540, 1080)

	mustDB(t, applyWfh(t, f, march, false))
	if count, revision := wfhCounter(f, e, "2026-03-01"); count != 4 || revision != 2 {
		t.Fatalf("an exact fit at the default limit 4: %d rev %d", count, revision)
	}
	err := applyWfh(t, f, edge, false)
	if !isRejection(err, "error.wfhLimitAckRequired") {
		t.Fatalf("a fifth March day without acknowledgement: %v", err)
	}
	if status, _, known := apperror.Response(err); status != 409 || !known {
		t.Fatalf("the WFH limit answers %d", status)
	}
	if count, _ := wfhCounter(f, e, "2026-03-01"); count != 4 {
		t.Fatalf("a refused approval moved March to %d", count)
	}
	if count, _ := wfhCounter(f, e, "2026-04-01"); count != -1 {
		t.Fatalf("a refused approval kept the April row: %d", count)
	}
	mustDB(t, applyWfh(t, f, edge, true))
	for month, want := range map[string]int{"2026-03-01": 5, "2026-04-01": 1} {
		if count, _ := wfhCounter(f, e, month); count != want {
			t.Fatalf("an acknowledged request across two months: %s = %d", month, count)
		}
	}

	f.exec(`INSERT INTO system_setting(key,value,version,updated_by) VALUES($1,CAST($2 AS jsonb),1,$3)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, string(settingcore.KeyWfhMonthLimit), "7", f.owner)
	mustDB(t, applyWfh(t, f, more, false))
	if err := applyWfh(t, f, last, false); !isRejection(err, "error.wfhLimitAckRequired") {
		t.Fatalf("an eighth day over hr.wfhMonthLimit 7: %v", err)
	}
	if count, _ := wfhCounter(f, e, "2026-03-01"); count != 7 {
		t.Fatalf("March at the stored limit: %d", count)
	}

	warn := func(dates []string, limit int) bool {
		t.Helper()
		exceeded, err := inMode(t, f.s, database.ModeRead, func(tx *database.Tx) (bool, error) {
			return attendancecore.WfhLimitExceeded(tx, e, dates, limit)
		})
		mustDB(t, err)
		return exceeded
	}
	if !warn([]string{"2026-03-12"}, 7) || warn([]string{"2026-04-02"}, 7) || !warn([]string{"2026-04-02"}, 1) ||
		warn([]string{"2026-05-04", "2026-05-05"}, 2) || !warn([]string{"2026-04-02", "2026-05-04"}, 1) {
		t.Fatal("the submit warning does not add the new dates to the approved days of their months")
	}

	mustDB(t, reverseWfh(t, f, edge))
	for month, want := range map[string]int{"2026-03-01": 6, "2026-04-01": 0} {
		if count, _ := wfhCounter(f, e, month); count != want {
			t.Fatalf("release: %s = %d", month, count)
		}
	}
	err = reverseWfh(t, f, edge)
	if driver, ok := errors.AsType[*pgconn.PgError](err); !ok || driver.Code != "23514" {
		t.Fatalf("a double release must break the CHECK: %v", err)
	}
	if count, _ := wfhCounter(f, e, "2026-03-01"); count != 6 {
		t.Fatalf("a refused double release moved March to %d", count)
	}

	leave := f.request(e, "annual-leave", "approved", []string{"2026-03-13"}, 540, 1080)
	if err := applyWfh(t, f, leave, true); !errors.Is(err, attendancecore.ErrNotWfh) {
		t.Fatalf("not a WFH request: %v", err)
	}
	if err := reverseWfh(t, f, leave); !errors.Is(err, attendancecore.ErrNotWfh) {
		t.Fatalf("not a WFH reversal: %v", err)
	}
	if err := applyWfh(t, f, "10000000-0000-4000-8000-0000000000bb", true); !errors.Is(err, attendancecore.ErrMissingRequest) {
		t.Fatalf("missing request: %v", err)
	}
}

func TestApprovedAttendanceLocksEveryMonthOfTheRequest(t *testing.T) {
	f := newHR(t)
	e := f.employee("2026-01-05", nil)
	request := f.request(e, "unpaid-leave", "approved", []string{"2026-05-29", "2026-06-01"}, 540, 1080)
	apply := func() error {
		return write(t, f.s, func(tx *database.Tx) error { return attendancecore.ApplyApprovedAttendance(tx, request) })
	}
	mustDB(t, apply())
	if n := f.count("SELECT count(*)::int FROM attendance_period WHERE state = 'open' AND month IN ('2026-05-01','2026-06-01')"); n != 2 {
		t.Fatalf("%d periods of the request", n)
	}
	f.closeMonth("2026-06-01")
	if err := apply(); !isRejection(err, "error.periodClosed") {
		t.Fatalf("a closed second month: %v", err)
	}
}
