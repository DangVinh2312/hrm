package report

import (
	"errors"
	"testing"

	"hrm/api-go/internal/modules/attendancecore"
)

func TestSheetTotalsRejectsAClosedRowMissingFromItsVerifiedSnapshot(t *testing.T) {
	month := "2026-03"
	snapshot := attendancecore.BuildSnapshot(month, "1", []attendancecore.SnapshotEmployee{
		{EmployeeID: "00000000-0000-4000-8000-000000000001", Totals: attendancecore.Totals{ScheduledMinutes: 480, PaidMinutes: 450, AdjustmentMinutes: -30}},
	})
	canonical, err := attendancecore.CanonicalSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := attendancecore.SnapshotHash(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	page := sheetPage{Total: "1", Closed: []closedMonth{{Month: month, Snapshot: canonical, Hash: hash}},
		Rows: []sheetStored{{EmployeeID: "00000000-0000-4000-8000-000000000002", Month: month, PeriodState: attendancecore.PeriodClosed}}}
	_, err = sheetTotals(page)
	if !errors.Is(err, errMissingSnapshotRow) {
		t.Fatalf("missing closed row: %v", err)
	}
	page.Rows[0].EmployeeID = snapshot.Employees[0].EmployeeID
	got, err := sheetTotals(page)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.rows) != 1 || got.rows[0].Totals != snapshot.Employees[0].Totals {
		t.Fatal("matching row was not served from the snapshot")
	}
}
