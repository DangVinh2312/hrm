//go:build integration

package report_test

import (
	"encoding/json/v2"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"hrm/api-go/internal/modules/report"
)

func (f *reportFixture) setting(key string, value int) {
	f.t.Helper()
	f.exec(`INSERT INTO system_setting(key,value,version,updated_by) VALUES($1,CAST($2 AS jsonb),1,$3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=system_setting.version+1`, key, strconv.Itoa(value), f.accounts["H"])
}

func reportError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	want := fmt.Sprintf(`{"statusCode":%d,"code":%q}`, status, code)
	if response.Code != status || response.Body.String() != want || !strings.HasPrefix(response.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("got status %d, type %q, body %d bytes; want %s", response.Code, response.Header().Get("Content-Type"), response.Body.Len(), want)
	}
}

func reportFile(t *testing.T, response *httptest.ResponseRecorder) [][]string {
	t.Helper()
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != report.XLSXMime ||
		!strings.HasPrefix(response.Header().Get("Content-Disposition"), "attachment;") ||
		response.Header().Get("Content-Length") != strconv.Itoa(response.Body.Len()) {
		t.Fatalf("export status %d or attachment headers differ", response.Code)
	}
	return report.WorkbookGrid(t, response.Body.Bytes())
}

func TestTheHTTPRowBudgetIncludesEqualityAndNeverTruncatesOrLeaksSize(t *testing.T) {
	f := newReportFixture(t)
	f.hire("E1", []string{"hr.employee"}, "", true)
	handler := f.handler()
	const path = "/api/hr/reports/seniority/export?asOn=2026-12-31"
	f.setting("export.maxRows", 4)
	response := f.get(handler, "C", path)
	grid := reportFile(t, response)
	if len(grid) != 5 || grid[1][0] != "s:T001" || grid[4][0] != "s:T004" {
		t.Fatal("at the exact row budget the complete file is required")
	}
	f.setting("export.maxRows", 3)
	response = f.get(handler, "C", path)
	reportError(t, response, http.StatusUnprocessableEntity, "error.exportTooLarge")
	response = f.get(handler, "C", "/api/hr/reports/seniority?asOn=2026-12-31&limit=3&offset=1")
	if response.Code != http.StatusOK {
		t.Fatalf("JSON status %d", response.Code)
	}
	var page report.Page[report.SeniorityRow]
	mustDB(t, json.Unmarshal(response.Body.Bytes(), &page, json.RejectUnknownMembers(true)))
	if page.Total != "4" || len(page.Rows) != 3 || page.Rows[0].EmployeeCode != "T002" || page.Rows[2].EmployeeCode != "T004" {
		t.Fatal("JSON was capped by the export budget")
	}
	for _, who := range []string{"N", "E1", "L1"} {
		response = f.get(handler, who, path)
		reportError(t, response, http.StatusForbidden, "error.accessDenied")
	}
	f.setting("export.maxRows", 4)
	response = f.get(handler, "C", path)
	if len(reportFile(t, response)) != 5 {
		t.Fatal("restoring the row budget did not restore the file")
	}
	for _, budget := range []int{11, 12} {
		f.setting("export.maxRows", budget)
		response := f.get(handler, "H", "/api/hr/reports/wfh/export?from=2026-01&to=2026-03")
		if budget == 11 {
			reportError(t, response, http.StatusUnprocessableEntity, "error.exportTooLarge")
			continue
		}
		if len(reportFile(t, response)) != 13 {
			t.Fatal("WFH export budget must count employee-month rows")
		}
	}
}

func TestTheHTTPByteBudgetUsesTheSettingOnTheSameWholeDataset(t *testing.T) {
	f := newReportFixture(t)
	const bulk = 3000
	names := make([]string, bulk)
	random := rand.New(rand.NewPCG(1, 2))
	for i := range names {
		name := make([]rune, 200)
		for j := range name {
			name[j] = rune(0x4e00 + random.IntN(20000))
		}
		names[i] = string(name)
	}
	f.exec(`INSERT INTO employee(id,object_id,code,full_name,hired_on)
      SELECT id,public.hr_register_object('employee',id),'B'||lpad(i::text,6,'0'),name,DATE '2025-01-06'
      FROM (SELECT gen_random_uuid() id,name,i FROM unnest($1::text[]) WITH ORDINALITY x(name,i)) rows`, names)
	handler := f.handler()
	const path = "/api/hr/reports/seniority/export?asOn=2026-12-31"
	f.setting("export.maxBytes", report.ExportMaxBytes)
	response := f.get(handler, "H", path)
	grid := reportFile(t, response)
	if response.Body.Len() <= 1<<20 || response.Body.Len() >= report.ExportMaxBytes || len(grid) != bulk+4 {
		t.Fatalf("byte fixture: file %d bytes, %d rows", response.Body.Len(), len(grid)-1)
	}
	t.Logf("fixture workbook: %d bytes, %d data rows", response.Body.Len(), len(grid)-1)
	f.setting("export.maxBytes", 1<<20)
	response = f.get(handler, "H", path)
	reportError(t, response, http.StatusUnprocessableEntity, "error.exportTooLarge")
	f.setting("export.maxBytes", report.ExportMaxBytes)
	response = f.get(handler, "H", path)
	if len(reportFile(t, response)) != bulk+4 {
		t.Fatal("raising the byte budget did not restore all rows")
	}
}

func TestTheHTTPMonthlySpanUsesTheCurrentSetting(t *testing.T) {
	f := newReportFixture(t)
	birthdayDataset(f)
	handler := f.handler()
	f.setting("report.maxMonths", 3)
	for _, kind := range []string{"attendance", "late-early", "wfh", "birthday"} {
		for _, export := range []bool{false, true} {
			path := "/api/hr/reports/" + kind
			if export {
				path += "/export"
			}
			if response := f.get(handler, "H", path+"?from=2026-01&to=2026-03"); response.Code != http.StatusOK {
				t.Fatalf("%s span 3 status %d", path, response.Code)
			}
			response := f.get(handler, "H", path+"?from=2026-01&to=2026-04")
			reportError(t, response, http.StatusBadRequest, "error.invalidRequest")
		}
	}
	f.setting("report.maxMonths", 12)
	for _, kind := range []string{"attendance", "late-early", "wfh", "birthday"} {
		for _, suffix := range []string{"", "/export"} {
			if response := f.get(handler, "H", "/api/hr/reports/"+kind+suffix+"?from=2026-01&to=2026-04"); response.Code != http.StatusOK {
				t.Fatalf("%s%s restored span status %d", kind, suffix, response.Code)
			}
		}
	}
}

func TestTheReportAndExportPayOnlyTheirExpectedSettingReads(t *testing.T) {
	f := newReportFixture(t)
	handler := f.handler()
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/api/hr/reports/wfh?from=2026-02&to=2026-02", 1},
		{"/api/hr/reports/leave?asOn=2026-06-30", 0},
		{"/api/hr/reports/wfh/export?from=2026-02&to=2026-02", 2},
	} {
		f.branches.takeSettings()
		response := f.get(handler, "H", tc.path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status %d", tc.path, response.Code)
		}
		if got := f.branches.takeSettings(); got != tc.want {
			t.Fatalf("%s: %d setting statements, want %d", tc.path, got, tc.want)
		}
	}
}
