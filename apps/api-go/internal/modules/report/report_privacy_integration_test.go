//go:build integration

package report_test

import (
	"archive/zip"
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"hrm/api-go/internal/modules/report"
)

func birthdayDataset(f *reportFixture) {
	reportDataset(f)
	birthdayIdentities(f)
}

func birthdayIdentities(f *reportFixture) {
	for _, p := range []struct{ name, date string }{
		{"E1", "1990-02-28"}, {"S2", "2000-02-29"}, {"E2", "1995-03-01"}, {"E3", "1988-01-31"},
		{"NEW", "1999-03-15"}, {"GONE", "1980-06-10"}, {"H", "1985-12-31"},
	} {
		f.exec(`INSERT INTO employee_identity(employee_id,object_id,date_of_birth)
          VALUES($1,public.hr_register_object('employeeIdentity',$1),CAST($2 AS date))`, f.employees[p.name], p.date)
	}
	f.exec(`UPDATE employee_identity SET document_kind='cccd',document_number='ZZ9988776655',tax_code='9988776655',
      gender='female',phone='0912345678',work_email='synthetic.private@example.test' WHERE employee_id=$1`, f.employees["E1"])
}

var privateReportValues = []string{"ZZ9988776655", "9988776655", "1990-02-28", "0912345678", "synthetic.private@example.test"}
var privateReportKeys = []string{"dateOfBirth", "documentKind", "documentNumber", "taxCode", "phone", "workEmail", "gender",
	"date_of_birth", "document_kind", "document_number", "tax_code", "work_email"}
var privateBirthYears = []string{"1990", "2000", "1995", "1988", "1985", "1980", "1999"}

func assertReportPrivacy(t *testing.T, label string, body []byte) {
	t.Helper()
	if key := reportPrivacyViolation(body); key != "" {
		t.Fatalf("%s contains private field or value (%s)", label, key)
	}
}

func reportPrivacyViolation(body []byte) string {
	for _, secret := range privateReportValues {
		if bytes.Contains(body, []byte(secret)) {
			return "fixture value"
		}
	}
	for _, key := range privateReportKeys {
		if bytes.Contains(body, []byte(key)) {
			return key
		}
	}
	for _, year := range privateBirthYears {
		for _, token := range []string{`"` + year + `"`, `"` + year + `-`, ">" + year + "<", ">" + year + "-", ":" + year + ",", ":" + year + "}"} {
			if bytes.Contains(body, []byte(token)) {
				return "birth year"
			}
		}
	}
	return ""
}

func workbookPrivacyViolation(content []byte) (string, error) {
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", err
	}
	if len(archive.File) == 0 {
		return "empty workbook", nil
	}
	for _, entry := range archive.File {
		reader, err := entry.Open()
		if err != nil {
			return "", err
		}
		body, err := io.ReadAll(reader)
		closeErr := reader.Close()
		if err != nil {
			return "", err
		}
		if closeErr != nil {
			return "", closeErr
		}
		if reportPrivacyViolation(body) != "" {
			return entry.Name, nil
		}
	}
	return "", nil
}

func workbookPrivateDate(t *testing.T, content []byte) bool {
	t.Helper()
	for _, row := range report.WorkbookGrid(t, content) {
		for _, cell := range row {
			value, format, styled := strings.Cut(cell, "|")
			if !styled || !strings.HasPrefix(value, "n:") {
				continue
			}
			if format != "dd/mm" && !strings.Contains(strings.ToLower(format), "y") && !slices.Contains([]string{"#14", "#15", "#16", "#17", "#22"}, format) {
				continue
			}
			serial, err := strconv.ParseFloat(strings.TrimPrefix(value, "n:"), 64)
			mustDB(t, err)
			if serial < 1 || serial > 100000 {
				t.Fatal("date cell is outside the report fixture range")
			}
			day := time.Date(1899, time.December, 30, 0, 0, 0, 0, time.UTC).AddDate(0, 0, int(serial))
			if slices.Contains(privateBirthYears, strconv.Itoa(day.Year())) {
				return true
			}
		}
	}
	return false
}

func TestEveryReportJSONAndEveryWorkbookEntryExcludeIdentityData(t *testing.T) {
	f := newReportFixture(t)
	birthdayDataset(f)
	handler := f.handler()
	for _, who := range []string{"H", "C"} {
		for _, q := range []struct{ kind, query string }{
			{"attendance", "from=2026-03&to=2026-04"}, {"late-early", "from=2026-03&to=2026-04"}, {"wfh", "from=2026-03&to=2026-05"},
			{"leave", "asOn=2026-06-30"}, {"seniority", "asOn=2026-12-31"}, {"birthday", "from=2027-02&to=2027-03"},
		} {
			path := "/api/hr/reports/" + q.kind
			response := f.get(handler, who, path+"?"+q.query)
			if response.Code != http.StatusOK {
				t.Fatalf("%s JSON status %d", q.kind, response.Code)
			}
			assertReportPrivacy(t, who+" "+q.kind+" JSON", response.Body.Bytes())
			if q.kind == "birthday" {
				var doc struct {
					Kind  string                      `json:"kind"`
					Total string                      `json:"total"`
					Rows  []map[string]jsontext.Value `json:"rows"`
				}
				mustDB(t, json.Unmarshal(response.Body.Bytes(), &doc))
				for _, r := range doc.Rows {
					keys := []string{}
					for k := range r {
						keys = append(keys, k)
					}
					slices.Sort(keys)
					if !slices.Equal(keys, []string{"birthdayOn", "employeeCode", "employeeId", "employeeName", "month"}) {
						t.Fatal("birthday JSON fields changed")
					}
				}
			}
			exported := f.get(handler, who, path+"/export?"+q.query)
			if exported.Code != http.StatusOK || exported.Header().Get("Content-Type") != report.XLSXMime {
				t.Fatalf("%s export status %d", q.kind, exported.Code)
			}
			entry, err := workbookPrivacyViolation(exported.Body.Bytes())
			mustDB(t, err)
			if entry != "" {
				t.Fatalf("%s %s leaks identity in %s", who, q.kind, entry)
			}
			if workbookPrivateDate(t, exported.Body.Bytes()) {
				t.Fatalf("%s %s contains a date cell with a birth year", who, q.kind)
			}
		}
	}
}

func TestRevocationAndDenyApplyToTheNextReportAndRootReadsAreAudited(t *testing.T) {
	f := newReportFixture(t)
	reportDataset(f)
	f.hire("C2", []string{"hr.employee", "hr.coo"}, "", false)
	q := monthly(report.KindAttendance, "2026-03", "2026-03", 100, 0)
	if page := queryPage[report.AttendanceRow](f, "C2", q); page.Total != "9" {
		t.Fatal("COO must initially read all nine employed")
	}
	f.exec(`DELETE FROM user_role WHERE user_id=$1 AND role_key=convert_to('hr.coo','UTF8')`, f.accounts["C2"])
	if page := queryPage[report.AttendanceRow](f, "C2", q); page.Total != "0" || len(page.Rows) != 0 {
		t.Fatal("revoked COO still receives rows")
	}
	wfh := monthly(report.KindWfh, "2026-03", "2026-03", 100, 0)
	if page := queryPage[report.WfhRow](f, "H", wfh); page.Total != "9" {
		t.Fatal("HR must initially read WFH")
	}
	f.exec(`INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
      VALUES(gen_random_uuid(),convert_to('employee.reportWfh','UTF8'),$1,'deny',convert_to('allEmployees','UTF8'),1,'{}','runtime')`, f.accounts["H"])
	if page := queryPage[report.WfhRow](f, "H", wfh); page.Total != "0" || len(page.Rows) != 0 {
		t.Fatal("deny did not remove HR WFH rows")
	}
	if page := queryPage[report.AttendanceRow](f, "H", q); page.Total != "9" {
		t.Fatal("WFH deny altered attendance grant")
	}
	count := func() string {
		return f.one(`SELECT count(*)::text FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.employee.reportAttendance','UTF8')`, f.accounts["root"])
	}
	before, err := strconv.Atoi(count())
	mustDB(t, err)
	if page := queryPage[report.AttendanceRow](f, "root", q); page.Total != "9" || len(page.Rows) != 9 {
		t.Fatal("Root did not read all rows")
	}
	if count() != strconv.Itoa(before+1) {
		t.Fatal("Root read must append exactly one access event")
	}
	meta := f.one(`SELECT safe_metadata->>'principalKind'||':'||(safe_metadata->>'outcome') FROM audit_outbox
      WHERE actor_id=$1 AND event_kind=convert_to('access.employee.reportAttendance','UTF8') ORDER BY occurred_at DESC LIMIT 1`, f.accounts["root"])
	if strings.TrimSpace(meta) != "root:ok" {
		t.Fatal("Root access audit metadata differs")
	}
}
