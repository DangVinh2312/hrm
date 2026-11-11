//go:build integration

package report_test

import (
	"encoding/json/v2"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/report"
)

type exportCase struct {
	kind          report.Kind
	action, query string
}

var exportCases = []exportCase{
	{report.KindAttendance, "reportAttendance", "from=2026-03&to=2026-04"},
	{report.KindLateEarly, "reportLateEarly", "from=2026-03&to=2026-04"},
	{report.KindWfh, "reportWfh", "from=2026-03&to=2026-05"},
	{report.KindLeave, "reportLeave", "asOn=2026-06-30"},
	{report.KindSeniority, "reportSeniority", "asOn=2026-12-31"},
	{report.KindBirthday, "reportBirthday", "from=2027-02&to=2027-03"},
}

func decodedPage[R report.Row](t *testing.T, response *httptest.ResponseRecorder) report.Page[R] {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("JSON status %d", response.Code)
	}
	var page report.Page[R]
	mustDB(t, json.Unmarshal(response.Body.Bytes(), &page, json.RejectUnknownMembers(true)))
	if page.Total != strconv.Itoa(len(page.Rows)) {
		t.Fatal("the export comparison dataset must fit the JSON page")
	}
	return page
}

func dayCell(t *testing.T, date, format string) string {
	t.Helper()
	parsed, err := time.Parse(time.DateOnly, date)
	mustDB(t, err)
	serial := int(parsed.Sub(time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)).Hours() / 24)
	return fmt.Sprintf("n:%d|%s", serial, format)
}

func employeeCells(e report.Employee) []string {
	return []string{"s:" + e.EmployeeCode, "s:" + e.EmployeeName}
}

func periodCells(t *testing.T, e report.Employee, month string, state attendancecore.PeriodState) []string {
	t.Helper()
	label := report.Vi("{110}ang m{1edf}")
	if state == attendancecore.PeriodClosed {
		label = report.Vi("{110}{e3} ch{1ed1}t")
	}
	return append(employeeCells(e), dayCell(t, month+"-01", "mm/yyyy"), "s:"+label)
}

func numericCells(values ...int) []string {
	cells := make([]string, len(values))
	for i, n := range values {
		cells[i] = "n:" + strconv.Itoa(n)
	}
	return cells
}

func expectedExportRows(t *testing.T, kind report.Kind, response *httptest.ResponseRecorder) [][]string {
	t.Helper()
	rows := [][]string{}
	switch kind {
	case report.KindAttendance:
		for _, r := range decodedPage[report.AttendanceRow](t, response).Rows {
			rows = append(rows, xlsxRow(t, r))
		}
	case report.KindLateEarly:
		for _, r := range decodedPage[report.LateEarlyRow](t, response).Rows {
			cells := periodCells(t, r.Employee, r.Month, r.PeriodState)
			rows = append(rows, append(cells, numericCells(r.LateCount, r.LateMinutes, r.EarlyCount, r.EarlyMinutes)...))
		}
	case report.KindWfh:
		for _, r := range decodedPage[report.WfhRow](t, response).Rows {
			cells := periodCells(t, r.Employee, r.Month, r.PeriodState)
			label := report.Vi("Kh{f4}ng")
			if r.OverLimit {
				label = report.Vi("C{f3}")
			}
			rows = append(rows, append(cells, "n:"+strconv.Itoa(r.WfhDays), "s:"+label))
		}
	case report.KindLeave:
		for _, r := range decodedPage[report.LeaveRow](t, response).Rows {
			annual := ""
			if r.AnnualMinutes != nil {
				annual = "n:" + strconv.Itoa(*r.AnnualMinutes)
			}
			cells := append(employeeCells(r.Employee), "n:"+strconv.Itoa(r.Year), dayCell(t, r.AsOn, "dd/mm/yyyy"), annual)
			rows = append(rows, append(cells, numericCells(r.EntitledMinutes, r.UsedMinutes, r.FutureApprovedMinutes, r.PendingMinutes, r.AvailableMinutes)...))
		}
	case report.KindSeniority:
		for _, r := range decodedPage[report.SeniorityRow](t, response).Rows {
			cells := append(employeeCells(r.Employee), dayCell(t, r.HiredOn, "dd/mm/yyyy"), dayCell(t, r.AsOn, "dd/mm/yyyy"))
			rows = append(rows, append(cells, numericCells(r.Years, r.Months, r.Days, r.TotalDays)...))
		}
	case report.KindBirthday:
		for _, r := range decodedPage[report.BirthdayRow](t, response).Rows {
			rows = append(rows, append(employeeCells(r.Employee), dayCell(t, r.Month+"-01", "mm/yyyy"), dayCell(t, r.BirthdayOn, "dd/mm")))
		}
	}
	return rows
}

func TestEveryHTTPExportMatchesAllTheJSONCellsForHRAndCOO(t *testing.T) {
	f := newReportFixture(t)
	leaveDataset(f)
	birthdayIdentities(f)
	handler := f.handler()
	for _, tc := range exportCases {
		path := "/api/hr/reports/" + string(tc.kind)
		response := f.get(handler, "H", path+"?"+tc.query+"&limit=100")
		want := expectedExportRows(t, tc.kind, response)
		if len(want) == 0 {
			t.Fatalf("%s needs a nonempty comparison", tc.kind)
		}
		for _, who := range []string{"H", "C"} {
			exported := f.get(handler, who, path+"/export?"+tc.query)
			grid := reportFile(t, exported)
			if !slices.Equal(grid[0], report.WorkbookHeader(tc.kind)) || !reflect.DeepEqual(grid[1:], want) {
				t.Fatalf("%s %s: workbook cells differ from the JSON projection", who, tc.kind)
			}
			span := strings.TrimPrefix(tc.query, "asOn=")
			if strings.HasPrefix(tc.query, "from=") {
				span = strings.ReplaceAll(strings.TrimPrefix(tc.query, "from="), "&to=", "_")
			}
			if !strings.Contains(exported.Header().Get("Content-Disposition"), "hrm-report-"+string(tc.kind)+"-"+span+".xlsx") {
				t.Fatal("export filename differs")
			}
		}
	}
	response := f.get(handler, "H", "/api/hr/reports/attendance/export?from=2026-03&to=2026-03")
	grid := reportFile(t, response)
	code := f.one(`SELECT code FROM employee WHERE id=$1`, f.employees["E1"])
	index := slices.IndexFunc(grid[1:], func(row []string) bool { return row[0] == "s:"+code })
	if index < 0 {
		t.Fatal("E1 is missing from the attendance export")
	}
	ledger := f.one(`SELECT COALESCE(sum(minutes),0)::text FROM leave_ledger WHERE employee_id=$1 AND entry_kind='debit' AND to_char(effective_on,'YYYY-MM')='2026-03'`, f.employees["E1"])
	if grid[index+1][7] != "n:"+ledger || ledger != "600" {
		t.Fatal("export annual leave does not equal the March ledger")
	}
}

func TestHTTPExportsAllowOnlyCOOHRAndRootAndAuditEveryRootRead(t *testing.T) {
	f := newReportFixture(t)
	birthdayDataset(f)
	handler := f.handler()
	for _, tc := range exportCases {
		path := "/api/hr/reports/" + string(tc.kind) + "/export?" + tc.query
		for _, who := range []string{"E1", "L1", "N"} {
			response := f.get(handler, who, path)
			reportError(t, response, http.StatusForbidden, "error.accessDenied")
		}
		for _, who := range []string{"C", "H", "root"} {
			before := f.one(`SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to($2,'UTF8')`, f.accounts["root"], "access.employee."+tc.action)
			response := f.get(handler, who, path)
			if len(reportFile(t, response)) < 2 {
				t.Fatalf("%s %s exported no rows", who, tc.kind)
			}
			if who == "root" {
				n, err := strconv.Atoi(before)
				mustDB(t, err)
				after := f.one(`SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to($2,'UTF8')`, f.accounts["root"], "access.employee."+tc.action)
				if after != strconv.Itoa(n+1) {
					t.Fatalf("Root %s export did not append exactly one successful access audit", tc.kind)
				}
				metadata := f.one(`SELECT safe_metadata->>'principalKind'||':'||(safe_metadata->>'outcome') FROM audit_outbox
                  WHERE actor_id=$1 AND event_kind=convert_to($2,'UTF8') ORDER BY occurred_at DESC,event_id DESC LIMIT 1`, f.accounts["root"], "access.employee."+tc.action)
				if metadata != "root:ok" {
					t.Fatalf("Root %s export audit metadata differs", tc.kind)
				}
			}
		}
	}
	f.exec(`INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to('employee.reportWfh','UTF8'),$1,'deny',convert_to('allEmployees','UTF8'),1,'{}','runtime')`, f.accounts["H"])
	denied := f.get(handler, "H", "/api/hr/reports/wfh/export?from=2026-03&to=2026-03")
	reportError(t, denied, http.StatusForbidden, "error.accessDenied")
	other := f.get(handler, "H", "/api/hr/reports/late-early/export?from=2026-03&to=2026-03")
	if len(reportFile(t, other)) < 2 {
		t.Fatal("WFH deny altered another export")
	}
}
