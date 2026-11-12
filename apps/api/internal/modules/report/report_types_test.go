package report

import (
	"encoding/json/v2"
	"testing"

	"hrm/api/internal/modules/attendancecore"
)

const person = `"employeeId":"00000000-0000-4000-8000-000000000001","employeeCode":"NV001","employeeName":"A"`

var someone = Employee{EmployeeID: "00000000-0000-4000-8000-000000000001", EmployeeCode: "NV001", EmployeeName: "A"}

func marshal(t *testing.T, value Result) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestEveryReportPageHasTheShapeTheWebReads(t *testing.T) {
	annual := 5760
	for want, page := range map[string]Result{
		`{"kind":"attendance","total":"1","rows":[{` + person + `,"month":"2026-03","periodState":"closed","scheduledMinutes":1,"paidHolidayMinutes":2,"unpaidMinutes":3,"annualLeaveMinutes":4,"paidMinutes":5,"wfhDays":6,"lateCount":7,"lateMinutes":8,"earlyCount":9,"earlyMinutes":10,"adjustmentMinutes":-11}]}`: Page[AttendanceRow]{
			Kind: KindAttendance, Total: "1", Rows: []AttendanceRow{{Employee: someone, Month: "2026-03", PeriodState: attendancecore.PeriodClosed, Totals: attendancecore.Totals{
				ScheduledMinutes: 1, PaidHolidayMinutes: 2, UnpaidMinutes: 3, AnnualLeaveMinutes: 4, PaidMinutes: 5, WfhDays: 6,
				LateCount: 7, LateMinutes: 8, EarlyCount: 9, EarlyMinutes: 10, AdjustmentMinutes: -11,
			}}},
		},
		`{"kind":"late-early","total":"1","rows":[{` + person + `,"month":"2026-03","periodState":"open","lateCount":1,"lateMinutes":2,"earlyCount":3,"earlyMinutes":4}]}`: Page[LateEarlyRow]{
			Kind: KindLateEarly, Total: "1", Rows: []LateEarlyRow{{Employee: someone, Month: "2026-03", PeriodState: attendancecore.PeriodOpen, LateCount: 1, LateMinutes: 2, EarlyCount: 3, EarlyMinutes: 4}},
		},
		`{"kind":"wfh","total":"1","rows":[{` + person + `,"month":"2026-05","periodState":"open","wfhDays":5,"overLimit":true}]}`: Page[WfhRow]{
			Kind: KindWfh, Total: "1", Rows: []WfhRow{{Employee: someone, Month: "2026-05", PeriodState: attendancecore.PeriodOpen, WfhDays: 5, OverLimit: true}},
		},
		`{"kind":"birthday","total":"1","rows":[{` + person + `,"month":"2027-02","birthdayOn":"2027-02-28"}]}`: Page[BirthdayRow]{
			Kind: KindBirthday, Total: "1", Rows: []BirthdayRow{{Employee: someone, Month: "2027-02", BirthdayOn: "2027-02-28"}},
		},
		`{"kind":"leave","total":"2","rows":[{` + person + `,"year":2026,"asOn":"2026-06-30","annualMinutes":5760,"entitledMinutes":1,"usedMinutes":2,"futureApprovedMinutes":3,"pendingMinutes":4,"availableMinutes":-5},{` + person + `,"year":2026,"asOn":"2026-06-30","annualMinutes":null,"entitledMinutes":0,"usedMinutes":0,"futureApprovedMinutes":0,"pendingMinutes":0,"availableMinutes":0}]}`: Page[LeaveRow]{
			Kind: KindLeave, Total: "2", Rows: []LeaveRow{
				{Employee: someone, Year: 2026, AsOn: "2026-06-30", AnnualMinutes: &annual, EntitledMinutes: 1, UsedMinutes: 2, FutureApprovedMinutes: 3, PendingMinutes: 4, AvailableMinutes: -5},
				{Employee: someone, Year: 2026, AsOn: "2026-06-30"},
			},
		},
		`{"kind":"seniority","total":"1","rows":[{` + person + `,"hiredOn":"2025-01-01","asOn":"2026-12-31","years":2,"months":0,"days":0,"totalDays":730}]}`: Page[SeniorityRow]{
			Kind: KindSeniority, Total: "1", Rows: []SeniorityRow{{Employee: someone, HiredOn: "2025-01-01", AsOn: "2026-12-31", Seniority: Seniority{Years: 2, TotalDays: 730}}},
		},
		`{"kind":"seniority","total":"0","rows":[]}`: Page[SeniorityRow]{Kind: KindSeniority, Total: "0"},
	} {
		if got := marshal(t, page); got != want {
			t.Errorf("\n got %s\nwant %s", got, want)
		}
	}
}
