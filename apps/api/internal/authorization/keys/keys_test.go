package keys

import (
	"reflect"
	"testing"
)

func TestReportActionsPreserveMenuProbeOrder(t *testing.T) {
	want := []ReportAction{"reportAttendance", "reportLeave", "reportLateEarly", "reportWfh", "reportSeniority", "reportBirthday"}
	if got := ReportActions(); !reflect.DeepEqual(got, want) {
		t.Fatalf("report actions = %v, want %v", got, want)
	}
	copy := ReportActions()
	copy[0] = "changed"
	if ReportActions()[0] != ReportActionAttendance {
		t.Fatal("caller changed report action order")
	}
}
