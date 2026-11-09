package leave

import (
	"reflect"
	"testing"

	"hrm/api-go/internal/modules/leavecore"
)

// The pending segments arrive out of date order and the later request has the smaller id: the month lists
// requests oldest first by date, only those with a segment up to it, and counts the approved day.
func TestExcessMonthsListsRequestsOldestFirstUpToTheMonth(t *testing.T) {
	own := leavecore.EmployeeFacts{
		Accrual: leavecore.AccrualFacts{
			Year: 2026, HiredOn: "2026-01-05",
			Periods: []leavecore.StatusPeriod{{Status: "official", StartsOn: "2026-01-05"}},
			Rates:   []leavecore.RatePeriod{{EffectiveFrom: "2026-01-05", AnnualMinutes: 5760}},
		},
		Adjustments: []leavecore.DatedMinutes{},
		Approved:    []leavecore.DatedMinutes{{Date: "2026-02-10", Minutes: 480}},
		Pending: []leavecore.PendingMinutes{
			{RequestID: "r1-march", Date: "2026-03-03", Minutes: 480},
			{RequestID: "r1-march", Date: "2026-03-04", Minutes: 480},
			{RequestID: "r0-may", Date: "2026-05-04", Minutes: 480},
			{RequestID: "r2-february", Date: "2026-02-16", Minutes: 480},
		},
	}
	got, err := excessMonths(pagedEmployee{ID: "e"}, own, 2026)
	if err != nil {
		t.Fatal(err)
	}
	want := []ExcessView{{
		EmployeeID: "e", Month: 3, AccruedMinutes: 1440, ApprovedMinutes: 480, PendingMinutes: 1440,
		ExcessMinutes: 480, RequestIDs: []string{"r2-february", "r1-march"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v", got)
	}
}
