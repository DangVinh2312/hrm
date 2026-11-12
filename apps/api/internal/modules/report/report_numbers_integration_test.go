//go:build integration

package report_test

import (
	"encoding/json/v2"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"hrm/api/internal/authentication"
	"hrm/api/internal/httpapi"
	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/leave"
	"hrm/api/internal/modules/leavecore"
	"hrm/api/internal/modules/report"
)

const reportOrigin = "http://localhost:3000"

func (f *reportFixture) handler() http.Handler {
	f.t.Helper()
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), authentication.RequestAuth{Origin: reportOrigin}, f.auth.PermissionExists)
	mustDB(f.t, (report.Routes{Reports: f.reports, Origin: reportOrigin}).Register(group))
	mustDB(f.t, (leave.Routes{Leave: f.leave, Origin: reportOrigin}).Register(group))
	return httpapi.NewHandler(engine)
}

func (f *reportFixture) get(handler http.Handler, who, target string) *httptest.ResponseRecorder {
	f.t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.AddCookie(&http.Cookie{Name: httpapi.CookieName(reportOrigin, httpapi.SessionCookie), Value: f.secrets[who]})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func cutoff(kind report.Kind, asOn string) report.Query {
	return report.Query{ExportQuery: report.ExportQuery{Kind: kind, AsOn: asOn}, Limit: 100}
}

func queryPage[R report.Row](f *reportFixture, who string, q report.Query) report.Page[R] {
	f.t.Helper()
	result, err := f.reports.Query(f.t.Context(), f.secrets[who], q)
	mustDB(f.t, err)
	page, ok := result.(report.Page[R])
	if !ok {
		f.t.Fatalf("%s answered %T", q.Kind, result)
	}
	return page
}

func leaveDataset(f *reportFixture) {
	reportDataset(f)
	f.exec(`INSERT INTO employment_status_period(id,employee_id,status,starts_on)
      SELECT gen_random_uuid(),id,'official',hired_on FROM employee`)
	f.exec(`INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
      SELECT g,public.hr_register_object('leaveRate',g),e.id,e.hired_on,5760 FROM employee e CROSS JOIN LATERAL (SELECT gen_random_uuid() g WHERE e.id IS NOT NULL) x`)
	for _, day := range []string{"2026-05-05", "2026-07-06"} {
		id := f.request("E1", "annual-leave", "approved", []string{day}, 540, 1080)
		f.exec(`INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,source_request_id,source_work_date)
        VALUES(gen_random_uuid(),$1,'debit',CAST($2 AS date),480,$3,CAST($2 AS date))`, f.employees["E1"], day, id)
	}
	f.request("E1", "annual-leave", "pending_lead", []string{"2026-08-10"}, 540, 1080)
}

func TestTheLeaveReportEqualsTheBalanceEndpointAtEachCutoff(t *testing.T) {
	f := newReportFixture(t)
	leaveDataset(f)
	handler := f.handler()
	for _, tc := range []struct {
		date string
		want [5]int
	}{
		{"2026-06-30", [5]int{2880, 1080, 480, 480, 840}},
		{"2026-07-06", [5]int{3360, 1560, 0, 480, 1320}},
		{"2026-03-04", [5]int{1440, 480, 1080, 480, 0}},
	} {
		page := queryPage[report.LeaveRow](f, "H", cutoff(report.KindLeave, tc.date))
		if page.Total != "8" || len(page.Rows) != 8 {
			t.Fatalf("%s: total %s with %d rows", tc.date, page.Total, len(page.Rows))
		}
		e1 := rowsOf(page.Rows, func(r report.LeaveRow) report.Employee { return r.Employee }, f.employees["E1"])
		if len(e1) != 1 {
			t.Fatalf("%s: E1 has %d rows", tc.date, len(e1))
		}
		r := e1[0]
		if r.Year != 2026 || r.AnnualMinutes == nil || *r.AnnualMinutes != 5760 ||
			[5]int{r.EntitledMinutes, r.UsedMinutes, r.FutureApprovedMinutes, r.PendingMinutes, r.AvailableMinutes} != tc.want {
			t.Fatalf("%s: E1 %+v, want %v", tc.date, r, tc.want)
		}
		for _, r := range page.Rows {
			response := f.get(handler, "root", "/api/hr/employees/"+r.EmployeeID+"/leave-balance?date="+tc.date)
			if response.Code != http.StatusOK {
				t.Fatalf("balance status %d", response.Code)
			}
			var balance leavecore.BalanceView
			mustDB(t, json.Unmarshal(response.Body.Bytes(), &balance, json.RejectUnknownMembers(true)))
			want := leavecore.BalanceView{EmployeeID: r.EmployeeID, Year: r.Year, AsOn: r.AsOn, AnnualMinutes: r.AnnualMinutes,
				EntitledMinutes: r.EntitledMinutes, UsedMinutes: r.UsedMinutes, FutureApprovedMinutes: r.FutureApprovedMinutes,
				PendingMinutes: r.PendingMinutes, AvailableMinutes: r.AvailableMinutes}
			if !reflect.DeepEqual(balance, want) {
				t.Fatalf("%s: report differs from balance endpoint", tc.date)
			}
		}
	}
	previous := queryPage[report.LeaveRow](f, "H", cutoff(report.KindLeave, "2025-12-31"))
	if previous.Total != "2" || len(previous.Rows) != 2 || slices.ContainsFunc(previous.Rows, func(r report.LeaveRow) bool { return r.EmployeeID == f.employees["NEW"] }) ||
		!slices.ContainsFunc(previous.Rows, func(r report.LeaveRow) bool { return r.EmployeeID == f.employees["GONE"] }) {
		t.Fatal("the previous year must include GONE and S2 only")
	}
}

func TestTheSeniorityReportCountsBothEmploymentEndpoints(t *testing.T) {
	f := newReportFixture(t)
	reportDataset(f)
	for _, tc := range []struct {
		date, total string
		want        map[string]report.Seniority
	}{
		{"2026-12-31", "8", map[string]report.Seniority{"S2": {Years: 2, TotalDays: 730}, "E1": {Months: 11, Days: 27, TotalDays: 361}, "NEW": {Months: 9, Days: 16, TotalDays: 291}}},
		{"2025-12-31", "2", map[string]report.Seniority{"GONE": {Months: 11, Days: 26, TotalDays: 360}, "S2": {Years: 1, TotalDays: 365}}},
		{"2026-03-16", "8", map[string]report.Seniority{"NEW": {Days: 1, TotalDays: 1}}},
	} {
		page := queryPage[report.SeniorityRow](f, "H", cutoff(report.KindSeniority, tc.date))
		if page.Total != tc.total || strconv.Itoa(len(page.Rows)) != tc.total {
			t.Fatalf("%s: total %s, rows %d", tc.date, page.Total, len(page.Rows))
		}
		for name, want := range tc.want {
			rows := rowsOf(page.Rows, func(r report.SeniorityRow) report.Employee { return r.Employee }, f.employees[name])
			if len(rows) != 1 || rows[0].Seniority != want || rows[0].AsOn != tc.date {
				t.Fatalf("%s %s: rows %+v, want %+v", tc.date, name, rows, want)
			}
		}
	}
	beforeHire := queryPage[report.SeniorityRow](f, "H", cutoff(report.KindSeniority, "2026-02-28"))
	if slices.ContainsFunc(beforeHire.Rows, func(r report.SeniorityRow) bool {
		return r.EmployeeID == f.employees["NEW"] || r.EmployeeID == f.employees["GONE"]
	}) {
		t.Fatal("a future hire or employee who already left is listed")
	}
}

func TestWfhOverLimitUsesTheCurrentSettingIncludingAtEqualityAfterClose(t *testing.T) {
	f := newReportFixture(t)
	f.hire("R1", []string{"hr.employee"}, "2025-12-01", true)
	f.request("R1", "wfh", "approved", []string{"2026-02-02", "2026-02-03", "2026-02-04"}, 540, 1080)
	q := monthly(report.KindWfh, "2026-02", "2026-02", 100, 0)
	check := func(limit int, closed bool) {
		t.Helper()
		f.exec(`INSERT INTO system_setting(key,value,version,updated_by) VALUES('hr.wfhMonthLimit',CAST($1 AS jsonb),1,$2)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=system_setting.version+1`, strconv.Itoa(limit), f.accounts["H"])
		for _, branchLimit := range []int{100, attendancecore.EffectsSetBasedMinRows} {
			q.Limit = branchLimit
			page := queryPage[report.WfhRow](f, "H", q)
			rows := rowsOf(page.Rows, func(r report.WfhRow) report.Employee { return r.Employee }, f.employees["R1"])
			state := attendancecore.PeriodOpen
			if closed {
				state = attendancecore.PeriodClosed
			}
			if len(rows) != 1 || rows[0].WfhDays != 3 || rows[0].OverLimit != (3 > limit) || rows[0].PeriodState != state {
				t.Fatalf("limit %d, closed %v, branch %d: %+v", limit, closed, branchLimit, rows)
			}
		}
	}
	for _, limit := range []int{4, 2, 3} {
		check(limit, false)
	}
	f.closeMonth("2026-02")
	stored, hash := f.storedSnapshot("2026-02")
	for _, limit := range []int{1, 4, 3, 2} {
		check(limit, true)
		after, afterHash := f.storedSnapshot("2026-02")
		if hash != afterHash || !reflect.DeepEqual(stored, after) {
			t.Fatal("a setting change altered the snapshot")
		}
	}
}

func TestAnUnverifiableOrIncompleteClosedSnapshotAnswers503(t *testing.T) {
	f := newReportFixture(t)
	f.hire("E1", []string{"hr.employee"}, "", true)
	f.closeMonth("2026-03")
	stored, hash := f.storedSnapshot("2026-03")
	canonical, err := attendancecore.CanonicalSnapshot(stored)
	mustDB(t, err)
	handler := f.handler()
	for _, fault := range []string{"changed-number", "wrong-hash", "missing-employee"} {
		t.Run(fault, func(t *testing.T) {
			f.exec(`UPDATE attendance_period SET snapshot=CAST($1 AS jsonb),snapshot_hash=$2 WHERE month=DATE '2026-03-01'`, string(canonical), hash)
			switch fault {
			case "changed-number":
				f.exec(`UPDATE attendance_period SET snapshot=jsonb_set(snapshot,'{employees,0,paidMinutes}','1') WHERE month=DATE '2026-03-01'`)
			case "wrong-hash":
				f.exec(`UPDATE attendance_period SET snapshot_hash=repeat('f',64) WHERE month=DATE '2026-03-01'`)
			case "missing-employee":
				missing := stored
				missing.Employees = slices.DeleteFunc(slices.Clone(stored.Employees), func(e attendancecore.SnapshotEmployee) bool { return e.EmployeeID == f.employees["E1"] })
				body, err := attendancecore.CanonicalSnapshot(missing)
				mustDB(t, err)
				f.exec(`UPDATE attendance_period SET snapshot=CAST($1 AS jsonb) WHERE month=DATE '2026-03-01'`, string(body))
			}
			for _, kind := range []report.Kind{report.KindAttendance, report.KindLateEarly, report.KindWfh} {
				for _, suffix := range []string{"?from=2026-03&to=2026-03", "/export?from=2026-03&to=2026-03"} {
					response := f.get(handler, "H", "/api/hr/reports/"+string(kind)+suffix)
					if response.Code != http.StatusServiceUnavailable || response.Body.String() != `{"statusCode":503,"code":"error.unavailable"}` {
						t.Fatalf("%s%s: status %d body %s", kind, suffix, response.Code, response.Body.String())
					}
				}
			}
		})
	}
	f.exec(`UPDATE attendance_period SET snapshot=CAST($1 AS jsonb),snapshot_hash=$2 WHERE month=DATE '2026-03-01'`, string(canonical), hash)
	response := f.get(handler, "H", "/api/hr/reports/attendance?from=2026-03&to=2026-03")
	if response.Code != http.StatusOK {
		t.Fatalf("restored snapshot: status %d", response.Code)
	}
}
