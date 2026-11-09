package attendancecore_test

import (
	"errors"
	"strings"
	"testing"

	"hrm/api-go/internal/modules/attendancecore"
)

// Vectors computed by canonicalSnapshot/snapshotHash of the TypeScript build: a close written by either
// runtime verifies in the other until cutover.
const (
	canonicalV2 = `{"formatVersion":2,"month":"2026-11","calendarVersion":"42","employees":[{"employeeId":"7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f","scheduledMinutes":10080,"paidHolidayMinutes":480,"unpaidMinutes":120,"annualLeaveMinutes":240,"paidMinutes":-60,"wfhDays":2,"lateCount":1,"lateMinutes":30,"earlyCount":0,"earlyMinutes":0,"adjustmentMinutes":-10560}]}`
	hashV2      = "7efb38a64eb275fc73c3957010461a495c06a1df07aea2a2f4ff999d52f635e9"
	canonicalV1 = `{"month":"2026-10","calendarVersion":"7","employees":[{"employeeId":"7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f","scheduledMinutes":10080,"paidHolidayMinutes":480,"unpaidMinutes":120,"annualLeaveMinutes":240,"paidMinutes":9960,"wfhDays":2,"lateCount":1,"lateMinutes":30,"earlyCount":0,"earlyMinutes":0}]}`
	hashV1      = "fbc85deb041c2b8749aa0a5b5910afd4f762df0be046008fd4caab1658bcf626"
)

var sampleEmployee = attendancecore.SnapshotEmployee{EmployeeID: "7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f", Totals: attendancecore.Totals{
	ScheduledMinutes: 10080, PaidHolidayMinutes: 480, UnpaidMinutes: 120, AnnualLeaveMinutes: 240, PaidMinutes: -60,
	WfhDays: 2, LateCount: 1, LateMinutes: 30, AdjustmentMinutes: -10560,
}}

func TestTheCanonicalSnapshotMatchesTheTypeScriptBytesAndHash(t *testing.T) {
	snapshot := attendancecore.BuildSnapshot("2026-11", "42", []attendancecore.SnapshotEmployee{sampleEmployee})
	canonical, err := attendancecore.CanonicalSnapshot(snapshot)
	if err != nil || string(canonical) != canonicalV2 {
		t.Fatalf("%s %v", canonical, err)
	}
	if hash, err := attendancecore.SnapshotHash(snapshot); err != nil || hash != hashV2 {
		t.Fatal(hash, err)
	}
	// jsonb returns another key order and spacing; the canonical form and the hash do not move.
	stored := `{"month": "2026-11", "employees": [{"wfhDays": 2, "lateCount": 1, "employeeId": "7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f", "paidMinutes": -60, "lateMinutes": 30, "earlyCount": 0, "earlyMinutes": 0.0, "unpaidMinutes": 120, "scheduledMinutes": 10080, "adjustmentMinutes": -10560, "annualLeaveMinutes": 240, "paidHolidayMinutes": 480}], "formatVersion": 2, "calendarVersion": "42"}`
	if _, err := attendancecore.VerifiedSnapshot("2026-11", []byte(stored), hashV2); err != nil {
		t.Fatal(err)
	}
}

func TestAFormatOneSnapshotKeepsItsOwnCanonicalForm(t *testing.T) {
	stored := `{"calendarVersion":"7","month":"2026-10","employees":[{"employeeId":"7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f","scheduledMinutes":10080,"paidHolidayMinutes":480,"unpaidMinutes":120,"annualLeaveMinutes":240,"paidMinutes":9960,"wfhDays":2,"lateCount":1,"lateMinutes":30,"earlyCount":0,"earlyMinutes":0}]}`
	snapshot, err := attendancecore.VerifiedSnapshot("2026-10", []byte(stored), hashV1)
	if err != nil || snapshot.FormatVersion != 1 || snapshot.Employees[0].AdjustmentMinutes != 0 {
		t.Fatalf("%+v %v", snapshot, err)
	}
	if canonical, err := attendancecore.CanonicalSnapshot(snapshot); err != nil || string(canonical) != canonicalV1 {
		t.Fatal(string(canonical), err)
	}
}

func TestAnAlteredSnapshotIsRefused(t *testing.T) {
	valid := canonicalV2
	for name, c := range map[string]struct {
		month, doc, hash string
		want             error
	}{
		"other month":         {"2026-12", valid, hashV2, attendancecore.ErrSnapshotMismatch},
		"changed number":      {"2026-11", strings.Replace(valid, `"unpaidMinutes":120`, `"unpaidMinutes":0`, 1), hashV2, attendancecore.ErrSnapshotMismatch},
		"format dropped":      {"2026-11", strings.Replace(valid, `"formatVersion":2,`, ``, 1), hashV2, attendancecore.ErrSnapshotMismatch},
		"format 3":            {"2026-11", strings.Replace(valid, `"formatVersion":2`, `"formatVersion":3`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"format null":         {"2026-11", strings.Replace(valid, `"formatVersion":2`, `"formatVersion":null`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"negative unsigned":   {"2026-11", strings.Replace(valid, `"unpaidMinutes":120`, `"unpaidMinutes":-1`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"negative wfhDays":    {"2026-11", strings.Replace(valid, `"wfhDays":2`, `"wfhDays":-2`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"negative lateCount":  {"2026-11", strings.Replace(valid, `"lateCount":1`, `"lateCount":-1`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"fraction":            {"2026-11", strings.Replace(valid, `"unpaidMinutes":120`, `"unpaidMinutes":120.5`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"beyond safe integer": {"2026-11", strings.Replace(valid, `"unpaidMinutes":120`, `"unpaidMinutes":9007199254740992`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"string number":       {"2026-11", strings.Replace(valid, `"unpaidMinutes":120`, `"unpaidMinutes":"120"`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"missing total":       {"2026-11", strings.Replace(valid, `"adjustmentMinutes":-10560`, `"x":1`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"numeric id":          {"2026-11", strings.Replace(valid, `"employeeId":"7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f"`, `"employeeId":7`, 1), hashV2, attendancecore.ErrInvalidSnapshot},
		"no employees":        {"2026-11", `{"formatVersion":2,"month":"2026-11","calendarVersion":"42"}`, hashV2, attendancecore.ErrInvalidSnapshot},
		"array":               {"2026-11", `[]`, hashV2, attendancecore.ErrInvalidSnapshot},
	} {
		if _, err := attendancecore.VerifiedSnapshot(c.month, []byte(c.doc), c.hash); !errors.Is(err, c.want) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}
