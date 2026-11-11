//go:build integration

package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"hrm/api-go/internal/httpapi"
	"hrm/api-go/test/fixture"
)

const (
	m7XLSX     = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	m7NoRecord = "no record in the path: the scope filters the rows in SQL"
	m7Scoped   = "no record in the path: TestM7ReportsKeepANarrowScopeBeforeCountAndPage reads every route with a narrow grant"
)

type m7Report struct{ kind, action, query string }

var m7Reports = []m7Report{
	{"attendance", "reportAttendance", "from=2026-01&to=2026-02"},
	{"late-early", "reportLateEarly", "from=2026-01&to=2026-02"},
	{"wfh", "reportWfh", "from=2026-01&to=2026-02"},
	{"birthday", "reportBirthday", "from=2026-01&to=2026-02"},
	{"leave", "reportLeave", "asOn=2026-03-01"},
	{"seniority", "reportSeniority", "asOn=2026-03-01"},
}

func (r m7Report) invalid(export bool) []m1Edit {
	edits := []m1Edit{m4Swap(r.query, ""), m4Swap(r.query, r.query+"&"+r.query), m4Swap(r.query, r.query+"&x=1")}
	if strings.HasPrefix(r.query, "from=") {
		edits = append(edits, m4Swap("to=2026-02", "to=2026-13"), m4Swap("to=2026-02", "to=2025-12"),
			m4Swap("to=2026-02", "to=2027-01"), m4Swap("from=2026-01", "from=2026-1"), m4Swap("&to=2026-02", ""))
	} else {
		edits = append(edits, m4Swap("2026-03-01", "2026-02-30"), m4Swap("2026-03-01", "2026-03"))
	}
	if export {
		return append(edits, m4Swap(r.query, r.query+"&limit=10"), m4Swap(r.query, r.query+"&offset=0"))
	}
	return append(edits, m4Swap(r.query, r.query+"&limit=101"), m4Swap(r.query, r.query+"&offset=-1"))
}

func (r m7Report) row(export bool) m1Row {
	target := "/api/hr/reports/" + r.kind
	cells := m1With(m1Read(), func(c *m1Cells) {
		c.noGrant = m1Cell{status: http.StatusOK, body: `{"kind":"` + r.kind + `","total":"0","rows":[]}`}
		c.deny = c.noGrant
		c.foreign, c.absent, c.absentEmployee = m1NA(m7Scoped), m1NA(m7NoRecord), m1NA(m7NoRecord)
		c.invalid = m1Refused(http.StatusBadRequest)
		c.idempotency = m1NA("a report takes no idempotency key")
	})
	shape := regexp.MustCompile(`^\{"kind":"` + r.kind + `","total":"[0-9]+","rows":\[.*\]\}$`)
	if export {
		target += "/export"
		cells.noGrant, cells.deny = m1Refused(http.StatusForbidden), m1Refused(http.StatusForbidden)
		shape = regexp.MustCompile(`^PK\x03\x04`)
	}
	return m1Row{
		cells:     cells,
		prepare:   func(*testing.T, *m1World) m1Request { return m1Request{target: target + "?" + r.query} },
		invalid:   r.invalid(export),
		shape:     shape,
		rootAudit: "access.employee." + r.action,
	}
}

var m7Matrix, m7Routes = func() (map[httpapi.Route]m1Row, []httpapi.Route) {
	matrix := map[httpapi.Route]m1Row{}
	var routes []httpapi.Route
	for _, report := range m7Reports {
		for _, export := range []bool{false, true} {
			route := httpapi.Route{Method: http.MethodGet, Path: "/api/hr/reports/" + report.kind}
			if export {
				route.Path += "/export"
			}
			matrix[route] = report.row(export)
			routes = append(routes, route)
		}
	}
	return matrix, routes
}()

func TestEveryM7RouteIsMigratedWithAFullMatrix(t *testing.T) {
	if len(m7Routes) != 12 || len(m7Matrix) != len(m7Routes) {
		t.Errorf("M7=%d matrix=%d, want 12/12", len(m7Routes), len(m7Matrix))
	}
	for _, route := range m7Routes {
		if !slices.Contains(httpapi.MigratedRoutes, route) {
			t.Errorf("%s: M7 route is not migrated", route)
		}
		checkMatrixRow(t, route, m7Matrix[route])
	}
}

// newM7World: denied holds a deny over every employee for each report action.
func newM7World(t *testing.T) *m1World {
	w := newM1World(t)
	for _, report := range m7Reports {
		w.exec(t, m1InsertRule, w.ids["denied"], "employee."+report.action, "deny", "allEmployees")
	}
	return w
}

func TestTheM7RoutesAnswerEveryCellOfTheMatrix(t *testing.T) {
	w := newM7World(t)
	w.asRoot(t, http.MethodPost, m1Request{"/api/hr/employees", m2CreateBody(w)}, http.StatusCreated)
	statuses := m1ContractStatuses(t)
	for _, route := range m7Routes {
		t.Run(route.String(), func(t *testing.T) { w.signIn(t); w.check(t, route, m7Matrix[route], statuses[route]) })
	}
}

func (w *m1World) download(actor, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	cookie := "authz_csrf=" + w.token
	if actor != "" {
		cookie += "; authz_session=" + w.secrets[actor]
	}
	request.Header.Set("Cookie", cookie)
	recorder := httptest.NewRecorder()
	w.handler.ServeHTTP(recorder, request)
	return recorder
}

// One employee with a birthday and a hire date reaches every report as JSON and as a workbook that opens;
// no grant reads an empty page and is refused the file; signed out is 401 on both.
func TestM7ReportsOverHTTP(t *testing.T) {
	w := newM7World(t)
	row := `"employeeId":"` + m7Hire(t, w, "M7-1") + `","employeeCode":"M7-1","employeeName":"Report employee"`
	wants := map[string]string{
		"attendance": `{` + row + `,"month":"2026-01","periodState":"open",`,
		"late-early": `{` + row + `,"month":"2026-01","periodState":"open","lateCount":0,`,
		"wfh":        `{` + row + `,"month":"2026-01","periodState":"open","wfhDays":0,"overLimit":false}`,
		"birthday":   `{` + row + `,"month":"2026-02","birthdayOn":"2026-02-17"}`,
		"leave":      `{` + row + `,"year":2026,"asOn":"2026-03-01",`,
		"seniority":  `{` + row + `,"hiredOn":"2020-01-02","asOn":"2026-03-01","years":6,"months":2,"days":0,"totalDays":2251}`,
	}
	for _, report := range m7Reports {
		target := "/api/hr/reports/" + report.kind + "?" + report.query
		status, page := w.send(http.MethodGet, "hr", m1Request{target: target}, nil)
		if status != http.StatusOK || !strings.HasPrefix(page, `{"kind":"`+report.kind+`","total":"`) || !strings.Contains(page, wants[report.kind]) {
			t.Errorf("%s: %d %s", report.kind, status, page)
		}
		if status, page := w.send(http.MethodGet, "none", m1Request{target: target}, nil); status != http.StatusOK || page != `{"kind":"`+report.kind+`","total":"0","rows":[]}` {
			t.Errorf("%s no grant: %d %s", report.kind, status, page)
		}
		if status, page := w.send(http.MethodGet, "", m1Request{target: target}, nil); !m1Refused(http.StatusUnauthorized).answers(status, page) {
			t.Errorf("%s signed out: %d %s", report.kind, status, page)
		}
		exportTarget := "/api/hr/reports/" + report.kind + "/export?" + report.query
		file := w.download("hr", exportTarget)
		name := `attachment; filename="hrm-report-` + report.kind + "-" + strings.NewReplacer("from=", "", "&to=", "_", "asOn=", "").Replace(report.query) + `.xlsx"`
		if file.Code != http.StatusOK || file.Header().Get("Content-Type") != m7XLSX || file.Header().Get("Content-Disposition") != name {
			t.Errorf("%s export: %d %v", report.kind, file.Code, file.Header())
		}
		if !m7WorkbookHolds(t, file.Body.Bytes(), "M7-1") {
			t.Errorf("%s export: the workbook lacks the employee", report.kind)
		}
		if refused := w.download("none", exportTarget); !m1Refused(http.StatusForbidden).answers(refused.Code, refused.Body.String()) || refused.Header().Get("Content-Disposition") != "" {
			t.Errorf("%s export without a grant: %d %s", report.kind, refused.Code, refused.Body.String())
		}
		if refused := w.download("", exportTarget); !m1Refused(http.StatusUnauthorized).answers(refused.Code, refused.Body.String()) {
			t.Errorf("%s export signed out: %d %s", report.kind, refused.Code, refused.Body.String())
		}
	}
}

// m7Hire is an employee born on 17 February and hired in 2020, so every report of m7Reports has a row of it.
func m7Hire(t *testing.T, w *m1World, code string) string {
	t.Helper()
	identity := strings.Replace(m2Identity, `"dateOfBirth":null`, `"dateOfBirth":"1990-02-17"`, 1)
	body := `{"code":"` + code + `","fullName":"Report employee","hiredOn":"2020-01-02","status":"probation","position":null,"classification":null,"identity":` + identity + `}`
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(w.asRoot(t, http.MethodPost, m1Request{"/api/hr/employees", body}, http.StatusCreated)), &created); err != nil {
		t.Fatal(err)
	}
	return created.ID
}

// rowsEach is how many rows one employee has in the report over m7Reports' range: a sheet row per month,
// one birthday, one balance, one length of service.
func (r m7Report) rowsEach() int {
	if r.kind == "attendance" || r.kind == "late-early" || r.kind == "wfh" {
		return 2
	}
	return 1
}

type m7Page struct {
	Kind  string `json:"kind"`
	Total string `json:"total"`
	Rows  []struct {
		EmployeeID   string `json:"employeeId"`
		EmployeeCode string `json:"employeeCode"`
	} `json:"rows"`
}

func m7Read(t *testing.T, w *m1World, actor, target string) m7Page {
	t.Helper()
	status, body := w.send(http.MethodGet, actor, m1Request{target: target}, nil)
	if status != http.StatusOK {
		t.Fatalf("%s %s: %d %s", actor, target, status, body)
	}
	var page m7Page
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatalf("%s %s: %v", actor, target, err)
	}
	return page
}

func m7Actor(t *testing.T, w *m1World, name, employee string) {
	t.Helper()
	w.ids[name] = fixture.Account(t, w.stack, fixture.AccountSpec{Roles: []string{m1Employee}}).ID
	if employee != "" {
		link := m1Request{"/api/hr/employees/" + employee + "/account", `{"expectedVersion":"1","accountId":"` + w.ids[name] + `"}`}
		w.asRoot(t, http.MethodPut, link, http.StatusOK)
	}
	w.secrets[name] = fixture.Session(t, w.stack, w.ids[name], fixture.SessionSpec{})
}

func (w *m1World) m7ReadsNothing(t *testing.T, stage, actor string, report m7Report) {
	t.Helper()
	target := "/api/hr/reports/" + report.kind
	status, page := w.send(http.MethodGet, actor, m1Request{target: target + "?" + report.query}, nil)
	if status != http.StatusOK || page != `{"kind":"`+report.kind+`","total":"0","rows":[]}` {
		t.Errorf("%s %s %s: %d %s", stage, actor, report.kind, status, page)
	}
	refused := w.download(actor, target+"/export?"+report.query)
	if !m1Refused(http.StatusForbidden).answers(refused.Code, refused.Body.String()) || refused.Header().Get("Content-Disposition") != "" || refused.Header().Get("Content-Type") == m7XLSX {
		t.Errorf("%s %s %s export: %d %v %s", stage, actor, report.kind, refused.Code, refused.Header(), refused.Body.String())
	}
}

// The scope comes before the count and the page. A lead granted the reports over ledEmployees reads the
// members of the team it leads, not the other member of a team it only belongs to; an employee granted them
// over selfEmployee reads itself. The codes in scope sort after the others, so a page cut before the scope
// would be empty and a count taken before it would be the company's. The employee role alone, and a grant
// that reaches no employee, read an empty page and are refused the file.
func TestM7ReportsKeepANarrowScopeBeforeCountAndPage(t *testing.T) {
	const limit = 2
	w := newM7World(t)
	people := map[string]string{}
	for _, code := range []string{"AA-1", "AA-2", "AA-3", "ZL-1", "ZL-2", "ZL-3", "ZS-1"} {
		people[code] = m7Hire(t, w, code)
	}
	m7Actor(t, w, "lead", people["ZL-1"])
	m7Actor(t, w, "self", people["ZS-1"])
	m7Actor(t, w, "unlinked", "")
	led, joined := w.team(t), w.team(t)
	for _, code := range []string{"ZL-1", "ZL-2", "ZL-3"} {
		w.join(t, led, people[code], false)
	}
	for _, code := range []string{"ZL-1", "AA-1"} {
		w.join(t, joined, people[code], false)
	}
	w.asRoot(t, http.MethodPut, m1Request{"/api/hr/teams/" + led + "/lead", `{"employeeId":"` + people["ZL-1"] + `"}`}, http.StatusOK)

	for _, report := range m7Reports {
		w.m7ReadsNothing(t, "employee role only", "lead", report)
		w.m7ReadsNothing(t, "employee role only", "self", report)
	}

	for _, report := range m7Reports {
		w.exec(t, m1InsertRule, w.ids["lead"], "employee."+report.action, "allow", "ledEmployees")
		w.exec(t, m1InsertRule, w.ids["self"], "employee."+report.action, "allow", "selfEmployee")
		w.exec(t, m1InsertRule, w.ids["unlinked"], "employee."+report.action, "allow", "selfEmployee")
	}
	scopes := []struct {
		actor string
		codes []string
	}{{"lead", []string{"ZL-1", "ZL-2", "ZL-3"}}, {"self", []string{"ZS-1"}}}
	for _, report := range m7Reports {
		target := "/api/hr/reports/" + report.kind
		w.m7ReadsNothing(t, "grant without an employee", "unlinked", report)
		company, err := strconv.Atoi(m7Read(t, w, "root", target+"?"+report.query+"&limit="+strconv.Itoa(limit)).Total)
		if err != nil {
			t.Fatal(err)
		}
		for _, scope := range scopes {
			var want []string
			for _, code := range scope.codes {
				for range report.rowsEach() {
					want = append(want, code+" "+people[code])
				}
			}
			if company <= len(want) || company <= limit {
				t.Fatalf("%s: the company has %d rows, the scope of %s %d: nothing outside it to leak", report.kind, company, scope.actor, len(want))
			}
			var got []string
			for offset := 0; offset <= len(want); offset += limit {
				page := m7Read(t, w, scope.actor, target+"?"+report.query+"&limit="+strconv.Itoa(limit)+"&offset="+strconv.Itoa(offset))
				if page.Kind != report.kind || page.Total != strconv.Itoa(len(want)) || len(page.Rows) != min(limit, len(want)-offset) {
					t.Errorf("%s %s offset %d: total %s with %d rows, want total %d", scope.actor, report.kind, offset, page.Total, len(page.Rows), len(want))
				}
				for _, row := range page.Rows {
					got = append(got, row.EmployeeCode+" "+row.EmployeeID)
				}
			}
			slices.Sort(got)
			if !slices.Equal(got, want) {
				t.Errorf("%s %s: rows of %v, want %v", scope.actor, report.kind, got, want)
			}

			file := w.download(scope.actor, target+"/export?"+report.query)
			if file.Code != http.StatusOK || file.Header().Get("Content-Type") != m7XLSX {
				t.Errorf("%s %s export: %d %v", scope.actor, report.kind, file.Code, file.Header())
				continue
			}
			for code := range people {
				if held := m7WorkbookHolds(t, file.Body.Bytes(), code); held != slices.Contains(scope.codes, code) {
					t.Errorf("%s %s export: holds %s is %t", scope.actor, report.kind, code, held)
				}
			}
		}
	}
}

// The re-check of an export proves the plan by an employee row it reaches, Root's plan included: with no
// employee at all Root still reads the empty pages and is refused every file.
func TestM7RootReadsEmptyPagesAndNoFileWithoutAnyEmployee(t *testing.T) {
	w := newM7World(t)
	for _, report := range m7Reports {
		file := w.download("root", "/api/hr/reports/"+report.kind+"/export?"+report.query)
		if file.Code != http.StatusOK || file.Header().Get("Content-Type") != m7XLSX {
			t.Fatalf("root %s export with an employee: %d %v", report.kind, file.Code, file.Header())
		}
	}

	w.exec(t, `TRUNCATE employee CASCADE`)
	if left := w.scalar(t, `SELECT count(*)::text FROM employee`); left != "0" {
		t.Fatalf("%s employees left", left)
	}
	for _, report := range m7Reports {
		w.m7ReadsNothing(t, "no employee", "root", report)
	}
}

func m7WorkbookHolds(t *testing.T, content []byte, text string) bool {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		t.Errorf("not a workbook: %v", err)
		return false
	}
	found := false
	for _, entry := range archive.File {
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		if closeErr := reader.Close(); err != nil || closeErr != nil {
			t.Fatal(err, closeErr)
		}
		found = found || bytes.Contains(data, []byte(text))
	}
	return found
}
