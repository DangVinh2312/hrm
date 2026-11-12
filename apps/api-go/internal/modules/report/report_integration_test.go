//go:build integration

package report_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendance"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/leave"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/internal/modules/report"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
	"hrm/api-go/test/fixture/attendanceoracle"
)

type attendancePage = report.Page[report.AttendanceRow]

// branchTrace records, per report statement, whether it read the effects set-based. Both branches answer
// the same rows by design, so the statement text is the only witness of which one ran.
type branchTrace struct {
	mu       sync.Mutex
	seen     []bool
	settings int
	steps    []string
	gate     func(steps []string)
}

// step records one step of a request and then runs the gate on the goroutine of the request, before the
// statement is sent: whatever the gate does is committed before that statement runs.
func (b *branchTrace) step(name string) {
	b.mu.Lock()
	b.steps = append(b.steps, name)
	gate := b.gate
	if gate == nil {
		b.mu.Unlock()
		return
	}
	steps := slices.Clone(b.steps)
	b.mu.Unlock()
	gate(steps)
}

// watch returns the steps recorded so far, forgets them and installs the next gate.
func (b *branchTrace) watch(gate func(steps []string)) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	steps := b.steps
	b.steps, b.gate = nil, gate
	return steps
}

func (b *branchTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	switch {
	case strings.HasPrefix(data.SQL, "begin"):
		b.step("begin")
	case data.SQL == "commit" || data.SQL == "rollback":
		b.step(data.SQL)
	case strings.Contains(data.SQL, "system_setting"):
		b.step("settings")
	case strings.HasPrefix(data.SQL, "SELECT EXISTS (SELECT 1 FROM"):
		b.step("probe")
	}
	if strings.Contains(data.SQL, "system_setting") {
		b.mu.Lock()
		b.settings++
		b.mu.Unlock()
	}
	if strings.Contains(data.SQL, "pairs AS (") {
		b.mu.Lock()
		b.seen = append(b.seen, strings.Contains(data.SQL, "live_page AS ("))
		b.mu.Unlock()
	}
	return ctx
}

func (b *branchTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (b *branchTrace) take() []bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	seen := b.seen
	b.seen = nil
	return seen
}

// reportFixture: one team led by L1, a COO C and HR H (employees outside the team), N signed in without any
// HR role or profile, root the Root account. Other rows are written by the superuser of the disposable
// cluster; the code under test runs with the runtime logins. Synthetic people and fixed past months only.
type reportFixture struct {
	t         *testing.T
	s         *testdb.Stack
	conn      *pgx.Conn
	team      string
	sequence  int
	secrets   map[string]string
	accounts  map[string]string
	employees map[string]string
	reports   *report.Service
	leave     *leave.Service
	auth      *authority.Authorization
	sheets    *attendance.Service
	oracle    *authority.Authorization
	query     *authority.Query[report.Query, attendancePage]
	branches  *branchTrace
}

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func oracleReport(c authority.QueryContext, q report.Query) (authority.QueryResult[attendancePage], error) {
	sheet, err := attendanceoracle.LoadSheetRows(c, q.From, q.To, q.Limit, q.Offset)
	if err != nil {
		return authority.QueryResult[attendancePage]{}, err
	}
	rows := make([]report.AttendanceRow, len(sheet.Rows))
	for i, r := range sheet.Rows {
		rows[i] = report.AttendanceRow{
			Employee: report.Employee{EmployeeID: r.EmployeeID, EmployeeCode: r.EmployeeCode, EmployeeName: r.EmployeeName},
			Month:    r.Month, PeriodState: r.PeriodState, Totals: r.Totals,
		}
	}
	return authority.QueryResult[attendancePage]{Found: true, Value: attendancePage{Kind: report.KindAttendance, Total: sheet.Total, Rows: rows}}, nil
}

func newReportFixture(t *testing.T) *reportFixture {
	t.Helper()
	f := &reportFixture{t: t, s: testdb.NewDatabase(t), secrets: map[string]string{}, accounts: map[string]string{}, employees: map[string]string{}, branches: &branchTrace{}}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	f.accounts["root"] = fixture.Root(t, f.s).ID
	f.secrets["root"] = fixture.Session(t, f.s, f.accounts["root"], fixture.SessionSpec{})
	f.team = f.one(`INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'T1' FROM gen_random_uuid() g RETURNING id::text`)
	f.hire("L1", []string{"hr.employee"}, "", false)
	f.hire("C", []string{"hr.employee", "hr.coo"}, "", false)
	f.hire("H", []string{"hr.employee", "hr.admin"}, "", false)
	f.exec(`INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, f.employees["L1"])
	f.exec(`INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, f.team, f.employees["L1"])
	f.accounts["N"] = fixture.Account(t, f.s, fixture.AccountSpec{}).ID
	f.secrets["N"] = fixture.Session(t, f.s, f.accounts["N"], fixture.SessionSpec{})

	c, err := declarations.NewCore()
	mustDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	mustDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	mustDB(t, err)

	config := f.s.Pools[database.PurposeData].Config()
	config.ConnConfig.Tracer = f.branches
	traced, err := pgxpool.NewWithConfig(t.Context(), config)
	mustDB(t, err)
	t.Cleanup(traced.Close)
	pools := maps.Clone(f.s.Pools)
	pools[database.PurposeData] = traced
	runner, err := database.NewRunner(pools, database.RunnerOptions{})
	mustDB(t, err)
	reportOps, sheetOps, leaveOps := report.NewOperations(), attendance.NewOperations(), leave.NewOperations()
	operations := append(reportOps.All(), sheetOps.All()...)
	operations = append(operations, leaveOps.All()...)
	product, err := authority.New(runner, bindings, authority.DefaultCapabilities(), nil, operations...)
	mustDB(t, err)
	f.reports, f.sheets = reportOps.Bind(product), sheetOps.Bind(product)
	f.leave, f.auth = leaveOps.Bind(product), product

	f.query = authority.NewQuery(string(keys.EmployeeResourceEmployee), string(keys.ReportActionAttendance), nil, oracleReport)
	f.oracle, err = authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), nil, f.query)
	mustDB(t, err)
	return f
}

func (f *reportFixture) exec(sql string, args ...any) {
	f.t.Helper()
	_, err := f.conn.Exec(f.t.Context(), sql, args...)
	mustDB(f.t, err)
}

func (f *reportFixture) one(sql string, args ...any) string {
	f.t.Helper()
	var value string
	mustDB(f.t, f.conn.QueryRow(f.t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *reportFixture) hire(name string, roles []string, hiredOn string, inTeam bool) string {
	f.t.Helper()
	if hiredOn == "" {
		hiredOn = "2026-01-05"
	}
	f.sequence++
	f.accounts[name] = fixture.Account(f.t, f.s, fixture.AccountSpec{Roles: roles}).ID
	f.secrets[name] = fixture.Session(f.t, f.s, f.accounts[name], fixture.SessionSpec{})
	f.employees[name] = fixture.Employee(f.t, f.s, fixture.EmployeeSpec{Code: fmt.Sprintf("T%03d", f.sequence), AccountID: f.accounts[name], HiredOn: hiredOn}).ID
	if inTeam {
		f.exec(`INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, f.employees[name])
	}
	return f.employees[name]
}

func (f *reportFixture) terminate(name, on string) {
	f.t.Helper()
	f.exec(`UPDATE employee SET terminated_on = CAST($2 AS date) WHERE id = $1`, f.employees[name], on)
}

func (f *reportFixture) request(name, kind, state string, dates []string, start, end int) string {
	f.t.Helper()
	id := f.one(`INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,$4,$5,'Fixture' FROM gen_random_uuid() g
      RETURNING id::text`, f.employees[name], f.accounts[name], f.team, kind, state)
	minutes := end - start
	if lunch := max(0, min(end, 840)-max(start, 780)); kind != "late-arrival" && kind != "early-departure" {
		minutes -= lunch
	}
	f.exec(`INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      SELECT $1,$2,CAST(d AS date),$3,$4,$5 FROM unnest(CAST($6 AS text[])) d`, id, kind, start, end, minutes, dates)
	return id
}

func (f *reportFixture) adjustment(name, day string, minutes int) {
	f.t.Helper()
	f.exec(`INSERT INTO attendance_adjustment(id,employee_id,work_date,minutes,reason,actor_account_id)
      VALUES(gen_random_uuid(),$1,CAST($2 AS date),$3,'Fixture adjustment',$4)`, f.employees[name], day, minutes, f.accounts["H"])
}

func (f *reportFixture) calendar(day, kind string, asWeekday, frameSource any) {
	f.t.Helper()
	var name any
	if kind == "paid_holiday" {
		name = "Holiday " + day
	}
	f.exec(`WITH c AS (UPDATE work_calendar SET version = version + 1 WHERE id = $1 RETURNING version)
      INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source)
      SELECT c.version,CAST($2 AS date),$3,$4,$5,$6 FROM c`, permission.WorkCalendarID, day, kind, name, asWeekday, frameSource)
}

func (f *reportFixture) shifts(table, schedule string, shifts [][3]int) {
	f.t.Helper()
	position := map[int]int{}
	for _, s := range shifts {
		position[s[0]]++
		f.exec(`INSERT INTO `+table+`(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,$2,$3,$4,$5)`,
			schedule, s[0], position[s[0]], s[1], s[2])
	}
}

func (f *reportFixture) companyVersion(from string, shifts [][3]int) {
	f.t.Helper()
	id := f.one("INSERT INTO work_schedule(id,effective_from) VALUES(gen_random_uuid(),CAST($1 AS date)) RETURNING id::text", from)
	f.shifts("work_schedule_shift", id, shifts)
}

func (f *reportFixture) employeeFrames(name, from string, to any, shifts [][3]int) {
	f.t.Helper()
	id := f.one(`INSERT INTO employee_schedule(id,employee_id,valid_from,valid_to)
      VALUES(gen_random_uuid(),$1,CAST($2 AS date),CAST($3 AS date)) RETURNING id::text`, f.employees[name], from, to)
	f.shifts("employee_schedule_shift", id, shifts)
}

func (f *reportFixture) report(who string, q report.Query) report.Result {
	f.t.Helper()
	f.branches.take()
	result, err := f.reports.Query(f.t.Context(), f.secrets[who], q)
	mustDB(f.t, err)
	setBased := q.Limit >= attendancecore.EffectsSetBasedMinRows
	if seen := f.branches.take(); len(seen) != 1 || seen[0] != setBased {
		f.t.Fatalf("%s %s %s..%s limit %d: report statements read set-based %v, want one %v", who, q.Kind, q.From, q.To, q.Limit, seen, setBased)
	}
	return result
}

func attendanceOf(t *testing.T, result report.Result) attendancePage {
	t.Helper()
	page, ok := result.(attendancePage)
	if !ok {
		t.Fatalf("attendance report answered %T", result)
	}
	return page
}

func monthly(kind report.Kind, from, to string, limit, offset int) report.Query {
	return report.Query{ExportQuery: report.ExportQuery{Kind: kind, From: from, To: to}, Limit: limit, Offset: offset}
}

// equivalenceDataset is the mixed dataset of hrm-attendance-effects-equivalence: every request state,
// overlaps, a tie, WFH across a month edge, hire and leaving inside the month, calendar versions, a makeup
// day of each frame source, company versions, employee frames and signed adjustments. Every month stays open.
func equivalenceDataset(f *reportFixture) {
	for _, name := range []string{"A1", "A2", "A3", "A4", "A5", "A6"} {
		f.hire(name, []string{"hr.employee"}, "", true)
	}
	for _, name := range []string{"B1", "B2"} {
		f.hire(name, []string{"hr.employee"}, "", false)
	}
	f.hire("NEW", []string{"hr.employee"}, "2026-03-16", true)
	f.hire("GONE", []string{"hr.employee"}, "2025-01-06", true)
	f.hire("IDLE", []string{"hr.employee"}, "", true)
	f.terminate("GONE", "2026-03-20")
	full := [2]int{540, 1080}
	for _, r := range []struct {
		who, kind, state string
		dates            []string
		slot             [2]int
	}{
		{"A1", "annual-leave", "approved", []string{"2026-03-04"}, full},
		{"A1", "annual-leave", "approved", []string{"2026-03-05"}, [2]int{540, 660}},
		{"A1", "unpaid-leave", "approved", []string{"2026-03-05"}, [2]int{540, 780}},
		{"A1", "wfh", "approved", []string{"2026-03-31", "2026-04-01"}, full},
		{"A1", "late-arrival", "approved", []string{"2026-03-10"}, [2]int{540, 600}},
		{"A1", "early-departure", "approved", []string{"2026-03-12"}, [2]int{1020, 1080}},
		{"A1", "unpaid-leave", "pending_lead", []string{"2026-03-18"}, full},
		{"A1", "annual-leave", "pending_final", []string{"2026-03-19"}, full},
		{"A1", "annual-leave", "rejected", []string{"2026-03-20"}, full},
		{"A1", "wfh", "cancelled", []string{"2026-03-23", "2026-03-24"}, full},
		{"A2", "late-arrival", "approved", []string{"2026-03-10"}, [2]int{540, 600}},
		{"A2", "late-arrival", "approved", []string{"2026-03-10"}, [2]int{540, 600}},
		{"A2", "wfh", "approved", []string{"2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"}, full},
		{"A3", "unpaid-leave", "cancelled", []string{"2026-03-06"}, full},
		{"A3", "unpaid-leave", "approved", []string{"2026-03-09"}, [2]int{540, 780}},
		{"A3", "annual-leave", "approved", []string{"2026-04-14"}, full},
		{"A4", "annual-leave", "rejected", []string{"2026-03-17"}, full},
		{"A4", "wfh", "pending_lead", []string{"2026-03-17"}, full},
		{"B1", "annual-leave", "approved", []string{"2026-03-25", "2026-03-26"}, [2]int{540, 780}},
		{"B1", "early-departure", "approved", []string{"2026-04-02"}, [2]int{1020, 1080}},
		{"B2", "late-arrival", "approved", []string{"2026-05-04"}, [2]int{540, 570}},
		{"NEW", "annual-leave", "approved", []string{"2026-03-17"}, full},
		{"NEW", "unpaid-leave", "approved", []string{"2026-03-10"}, full},
		{"GONE", "unpaid-leave", "approved", []string{"2026-03-23"}, full},
		{"GONE", "wfh", "approved", []string{"2026-03-18"}, full},
		{"A5", "annual-leave", "approved", []string{"2026-02-27"}, full},
		{"A5", "unpaid-leave", "pending_final", []string{"2026-04-06"}, full},
	} {
		f.request(r.who, r.kind, r.state, r.dates, r.slot[0], r.slot[1])
	}
	f.adjustment("A1", "2026-03-10", 120)
	f.adjustment("A1", "2026-03-11", -60)
	f.adjustment("A1", "2026-04-03", 30)
	f.adjustment("A3", "2026-03-09", -30)
	f.adjustment("B1", "2026-03-25", 45)
	f.adjustment("NEW", "2026-03-18", 15)
	f.adjustment("A5", "2026-02-27", -15)
	f.calendar("2026-03-12", "paid_holiday", nil, nil)
	f.calendar("2026-03-19", "paid_holiday", nil, nil)
	f.calendar("2026-03-12", "standard", nil, nil)
	f.calendar("2026-03-14", "makeup_workday", 1, "company")
	f.calendar("2026-04-30", "paid_holiday", nil, nil)
	f.calendar("2026-05-09", "makeup_workday", 2, "employee")
	f.companyVersion("2026-04-13", [][3]int{{1, 480, 720}, {1, 780, 1020}, {2, 480, 1020}, {3, 480, 1020}, {4, 480, 1020}, {5, 480, 960}})
	f.employeeFrames("A2", "2026-03-09", "2026-04-20", [][3]int{{1, 600, 900}, {3, 480, 720}})
	f.employeeFrames("B2", "2026-05-01", nil, [][3]int{{2, 420, 840}})
}

type comparison struct {
	setBased bool
	rows     int
	effects  int
	closed   int
}

// compare reads one attendance page with the report and with the oracle, and the late-early and WFH pages
// of the same input: the same rows, and the branch the threshold names.
func (f *reportFixture) compare(t *testing.T, who string, q report.Query) comparison {
	t.Helper()
	label := fmt.Sprintf("%s %s..%s limit %d offset %d", who, q.From, q.To, q.Limit, q.Offset)
	got := attendanceOf(t, f.report(who, q))
	read, err := authority.Read(t.Context(), f.oracle, f.secrets[who], f.query, q)
	mustDB(t, err)
	want := read.Value
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: the report differs from the oracle\n got %+v\nwant %+v", label, got, want)
	}

	lateEarly, ok := f.report(who, report.Query{ExportQuery: report.ExportQuery{Kind: report.KindLateEarly, From: q.From, To: q.To}, Limit: q.Limit, Offset: q.Offset}).(report.Page[report.LateEarlyRow])
	if !ok || lateEarly.Total != want.Total || len(lateEarly.Rows) != len(want.Rows) {
		t.Fatalf("%s: late-early page %+v, want total %s and %d rows", label, lateEarly, want.Total, len(want.Rows))
	}
	wfh, ok := f.report(who, report.Query{ExportQuery: report.ExportQuery{Kind: report.KindWfh, From: q.From, To: q.To}, Limit: q.Limit, Offset: q.Offset}).(report.Page[report.WfhRow])
	if !ok || wfh.Total != want.Total || len(wfh.Rows) != len(want.Rows) {
		t.Fatalf("%s: WFH page %+v, want total %s and %d rows", label, wfh, want.Total, len(want.Rows))
	}
	effects, closed := 0, 0
	for i, row := range want.Rows {
		le := lateEarly.Rows[i]
		if le.Employee != row.Employee || le.Month != row.Month || le.PeriodState != row.PeriodState ||
			[4]int{le.LateCount, le.LateMinutes, le.EarlyCount, le.EarlyMinutes} != [4]int{row.LateCount, row.LateMinutes, row.EarlyCount, row.EarlyMinutes} {
			t.Fatalf("%s: late-early row %d %+v, oracle %+v", label, i, le, row)
		}
		w := wfh.Rows[i]
		if w.Employee != row.Employee || w.Month != row.Month || w.PeriodState != row.PeriodState || w.WfhDays != row.WfhDays {
			t.Fatalf("%s: WFH row %d %+v, oracle %+v", label, i, w, row)
		}
		effects += row.LateCount + row.EarlyCount + row.WfhDays + row.UnpaidMinutes + row.AnnualLeaveMinutes
		if row.PeriodState == attendancecore.PeriodClosed {
			closed++
		}
	}
	return comparison{setBased: q.Limit >= attendancecore.EffectsSetBasedMinRows, rows: len(want.Rows), effects: effects, closed: closed}
}

type coverage struct{ perRow, setBased, closedPerRow, closedSetBased int }

func (f *reportFixture) sameReports(t *testing.T) coverage {
	t.Helper()
	threshold := attendancecore.EffectsSetBasedMinRows
	personas := []string{"root", "C", "H", "L1", "A1", "B1", "NEW", "N"}
	ranges := [][2]string{{"2026-03", "2026-03"}, {"2026-02", "2026-05"}, {"2026-04", "2026-04"}, {"2026-01", "2026-01"}}
	pages := [][2]int{{100, 0}, {3, 0}, {3, 3}, {4, 8}, {1, 11}, {5, 1000}, {threshold - 1, 0}, {threshold, 0}, {threshold, 3}, {threshold + 200, 0}, {report.ExportMaxRows, 0}}
	var seen coverage
	for _, who := range personas {
		for _, r := range ranges {
			for _, p := range pages {
				result := f.compare(t, who, monthly(report.KindAttendance, r[0], r[1], p[0], p[1]))
				if result.setBased {
					seen.setBased += min(1, result.effects)
					seen.closedSetBased += min(1, result.closed)
				} else {
					seen.perRow += min(1, result.effects)
					seen.closedPerRow += min(1, result.closed)
				}
			}
		}
	}
	return seen
}

func TestTheAttendanceReportEqualsTheCorrelatedOracleOnEveryScopeRangeAndPage(t *testing.T) {
	f := newReportFixture(t)
	equivalenceDataset(f)
	if seen := f.sameReports(t); seen.perRow == 0 || seen.setBased == 0 {
		t.Fatalf("pages with effects: %d per row and %d set-based", seen.perRow, seen.setBased)
	}

	march := monthly(report.KindAttendance, "2026-03", "2026-03", 100, 0)
	if page := attendanceOf(t, f.report("H", march)); page.Total == "0" || len(page.Rows) == 0 {
		t.Fatalf("HR reads %s with %d rows", page.Total, len(page.Rows))
	}
	for _, who := range []string{"L1", "N", "A1"} {
		if page := attendanceOf(t, f.report(who, march)); page.Total != "0" || len(page.Rows) != 0 {
			t.Fatalf("%s reads %s with %d rows, want an empty page", who, page.Total, len(page.Rows))
		}
	}
}

// reportDataset is the dataset of hrm-report: E1 with every kind in March, a WFH of 30-31 March decided in
// April, waiting and refused requests, E2 late on the second shift and WFH in May, NEW hired on 16 March,
// GONE gone in 2025, S2 hired in 2025.
func reportDataset(f *reportFixture) {
	for _, name := range []string{"E1", "E2", "E3"} {
		f.hire(name, []string{"hr.employee"}, "", true)
	}
	f.hire("S2", []string{"hr.employee"}, "2025-01-01", true)
	f.hire("GONE", []string{"hr.employee"}, "2025-01-06", true)
	f.terminate("GONE", "2025-12-31")
	f.hire("NEW", []string{"hr.employee"}, "2026-03-16", true)
	full := [2]int{540, 1080}
	f.request("E1", "unpaid-leave", "approved", []string{"2026-03-03"}, 540, 660)
	annualDay := f.request("E1", "annual-leave", "approved", []string{"2026-03-04"}, full[0], full[1])
	annualHalf := f.request("E1", "annual-leave", "approved", []string{"2026-03-05"}, 540, 660)
	f.request("E1", "unpaid-leave", "approved", []string{"2026-03-05"}, 540, 780)
	wfhMarch := f.request("E1", "wfh", "approved", []string{"2026-03-30", "2026-03-31"}, full[0], full[1])
	f.request("E1", "late-arrival", "approved", []string{"2026-03-10"}, 540, 600)
	f.request("E1", "early-departure", "approved", []string{"2026-03-12"}, 1020, 1080)
	f.exec(`INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,decided_at)
      VALUES(gen_random_uuid(),$1,'final','approve','user',$2,TIMESTAMPTZ '2026-04-02 03:00:00+00')`, wfhMarch, f.accounts["C"])
	f.request("E1", "unpaid-leave", "pending_lead", []string{"2026-03-18"}, full[0], full[1])
	f.request("E1", "wfh", "rejected", []string{"2026-03-19"}, full[0], full[1])
	f.request("E1", "wfh", "approved", []string{"2026-04-01"}, full[0], full[1])
	f.request("E2", "late-arrival", "approved", []string{"2026-03-17"}, 840, 900)
	f.request("E2", "wfh", "approved", []string{"2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08"}, full[0], full[1])
	for _, d := range []struct {
		request, day string
		minutes      int
	}{{annualDay, "2026-03-04", 480}, {annualHalf, "2026-03-05", 120}} {
		f.exec(`INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,source_request_id,source_work_date)
        VALUES(gen_random_uuid(),$1,'debit',CAST($2 AS date),$3,$4,CAST($2 AS date))`, f.employees["E1"], d.day, d.minutes, d.request)
	}
}

func rowsOf[R report.Row](rows []R, employee func(R) report.Employee, id string) []R {
	var found []R
	for _, row := range rows {
		if employee(row).EmployeeID == id {
			found = append(found, row)
		}
	}
	return found
}

func attendanceEmployee(r report.AttendanceRow) report.Employee { return r.Employee }

func TestTheAttendanceReportHasTheKnownTotalsOfTheSheetEndpoint(t *testing.T) {
	f := newReportFixture(t)
	reportDataset(f)
	march := attendancecore.Totals{ScheduledMinutes: 22 * 480, UnpaidMinutes: 240, AnnualLeaveMinutes: 600, PaidMinutes: 22*480 - 240,
		WfhDays: 2, LateCount: 1, LateMinutes: 60, EarlyCount: 1, EarlyMinutes: 60}
	april := attendancecore.Totals{ScheduledMinutes: 22 * 480, PaidMinutes: 22 * 480, WfhDays: 1}
	var first attendancePage
	for _, limit := range []int{100, attendancecore.EffectsSetBasedMinRows} {
		page := attendanceOf(t, f.report("H", monthly(report.KindAttendance, "2026-03", "2026-04", limit, 0)))
		if page.Total != "16" || len(page.Rows) != 16 {
			t.Fatalf("limit %d: total %s, %d rows; want 8 employees (GONE left in 2025) in two months", limit, page.Total, len(page.Rows))
		}
		if !slices.IsSortedFunc(page.Rows, func(a, b report.AttendanceRow) int {
			return strings.Compare(a.EmployeeCode+" "+a.Month, b.EmployeeCode+" "+b.Month)
		}) {
			t.Fatalf("limit %d: rows are not ordered by code then month", limit)
		}
		e1 := rowsOf(page.Rows, attendanceEmployee, f.employees["E1"])
		if len(e1) != 2 || e1[0].Month != "2026-03" || e1[0].PeriodState != attendancecore.PeriodOpen || e1[0].Totals != march || e1[1].Totals != april {
			t.Fatalf("limit %d: E1 %+v, want March %+v and April %+v", limit, e1, march, april)
		}
		hired := rowsOf(page.Rows, attendanceEmployee, f.employees["NEW"])
		if len(hired) != 2 || hired[0].ScheduledMinutes != 12*480 || hired[1].ScheduledMinutes != 22*480 {
			t.Fatalf("limit %d: NEW, hired on 16 March: %+v", limit, hired)
		}
		for _, row := range page.Rows {
			month := row.Month
			sheet, found, err := f.sheets.Sheet(t.Context(), f.secrets["root"], attendance.SheetQuery{EmployeeID: row.EmployeeID, Month: &month})
			mustDB(t, err)
			if !found || sheet.PeriodState != row.PeriodState || sheet.Totals != row.Totals {
				t.Fatalf("limit %d: %s %s report %+v, sheet %+v (found %v)", limit, row.EmployeeCode, month, row.Totals, sheet, found)
			}
		}
		if limit == 100 {
			first = page
		} else if !reflect.DeepEqual(page, first) {
			t.Fatalf("set-based page %+v differs from the per-row page %+v", page, first)
		}
	}
	ledger := f.one(`SELECT COALESCE(sum(minutes),0)::text FROM leave_ledger
      WHERE employee_id = $1 AND entry_kind = 'debit' AND to_char(effective_on,'YYYY-MM') = '2026-03'`, f.employees["E1"])
	if ledger != fmt.Sprint(march.AnnualLeaveMinutes) {
		t.Fatalf("March debits of E1 %s, the sheet's annual minutes %d", ledger, march.AnnualLeaveMinutes)
	}
}

func TestLateEarlyAndWfhCountTheDayRecordedNotTheMonthDecided(t *testing.T) {
	f := newReportFixture(t)
	reportDataset(f)
	lateOf := func(r report.LateEarlyRow) report.Employee { return r.Employee }
	wfhOf := func(r report.WfhRow) report.Employee { return r.Employee }
	type wfhCell struct {
		month string
		days  int
		over  bool
	}
	cells := func(rows []report.WfhRow) []wfhCell {
		out := []wfhCell{}
		for _, r := range rows {
			out = append(out, wfhCell{r.Month, r.WfhDays, r.OverLimit})
		}
		return out
	}
	for _, limit := range []int{100, attendancecore.EffectsSetBasedMinRows} {
		late, ok := f.report("H", monthly(report.KindLateEarly, "2026-03", "2026-03", limit, 0)).(report.Page[report.LateEarlyRow])
		if !ok || len(late.Rows) != 8 || late.Total != "8" {
			t.Fatalf("limit %d: late-early of March %+v, want a row for each of the 8 employed", limit, late)
		}
		e1 := rowsOf(late.Rows, lateOf, f.employees["E1"])
		if len(e1) != 1 || [4]int{e1[0].LateCount, e1[0].LateMinutes, e1[0].EarlyCount, e1[0].EarlyMinutes} != [4]int{1, 60, 1, 60} {
			t.Fatalf("limit %d: E1 late-early %+v", limit, e1)
		}
		e2 := rowsOf(late.Rows, lateOf, f.employees["E2"])
		if len(e2) != 1 || [4]int{e2[0].LateCount, e2[0].LateMinutes, e2[0].EarlyCount, e2[0].EarlyMinutes} != [4]int{1, 60, 0, 0} {
			t.Fatalf("limit %d: E2 late on the second shift %+v", limit, e2)
		}

		wfh, ok := f.report("H", monthly(report.KindWfh, "2026-03", "2026-05", limit, 0)).(report.Page[report.WfhRow])
		if !ok {
			t.Fatalf("limit %d: WFH report answered %T", limit, wfh)
		}
		if got, want := cells(rowsOf(wfh.Rows, wfhOf, f.employees["E1"])), []wfhCell{{"2026-03", 2, false}, {"2026-04", 1, false}, {"2026-05", 0, false}}; !slices.Equal(got, want) {
			t.Fatalf("limit %d: E1 WFH %+v, want %+v (30-31 March decided on 2 April count in March)", limit, got, want)
		}
		if got, want := cells(rowsOf(wfh.Rows, wfhOf, f.employees["E2"])), []wfhCell{{"2026-03", 0, false}, {"2026-04", 0, false}, {"2026-05", 5, true}}; !slices.Equal(got, want) {
			t.Fatalf("limit %d: E2 WFH %+v, want %+v", limit, got, want)
		}

		april, ok := f.report("H", monthly(report.KindWfh, "2026-04", "2026-04", limit, 0)).(report.Page[report.WfhRow])
		if got := rowsOf(april.Rows, wfhOf, f.employees["E1"]); !ok || len(got) != 1 || got[0].WfhDays != 1 {
			t.Fatalf("limit %d: E1 WFH of April %+v; the April-decided March request is not in April", limit, got)
		}
	}
}

func (f *reportFixture) fresh(name string) string {
	f.t.Helper()
	return fixture.Session(f.t, f.s, f.accounts[name], fixture.SessionSpec{Fresh: true})
}

func (f *reportFixture) closeMonth(month string) {
	f.t.Helper()
	_, err := f.sheets.ClosePeriod(f.t.Context(), f.fresh("H"), month)
	mustDB(f.t, err)
}

func (f *reportFixture) adjust(name, day string, minutes int) {
	f.t.Helper()
	_, err := f.sheets.Adjust(f.t.Context(), f.fresh("H"), attendance.AdjustmentInput{
		EmployeeID: f.employees[name], IdempotencyKey: f.one("SELECT gen_random_uuid()::text"), WorkDate: day, Minutes: minutes, Reason: "Fixture adjustment",
	})
	mustDB(f.t, err)
}

// oracleSnapshot is the snapshot a close of month owes: the totals of the correlated facts of every employee.
func (f *reportFixture) oracleSnapshot(month string) attendancecore.Snapshot {
	f.t.Helper()
	facts, err := database.Run(f.t.Context(), f.s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) ([]attendancecore.FactsRow, error) {
		return attendanceoracle.LoadFacts(tx, month, nil)
	}, database.RunOptions{})
	mustDB(f.t, err)
	employees := make([]attendancecore.SnapshotEmployee, len(facts))
	for i, row := range facts {
		totals, err := attendancecore.TotalsOf(month, row)
		mustDB(f.t, err)
		employees[i] = attendancecore.SnapshotEmployee{EmployeeID: row.ID, Totals: totals}
	}
	return attendancecore.BuildSnapshot(month, f.one(`SELECT version::text FROM work_calendar WHERE id = $1`, permission.WorkCalendarID), employees)
}

func (f *reportFixture) storedSnapshot(month string) (attendancecore.Snapshot, string) {
	f.t.Helper()
	var stored, hash string
	mustDB(f.t, f.conn.QueryRow(f.t.Context(), `SELECT snapshot::text, snapshot_hash FROM attendance_period WHERE month = CAST($1 || '-01' AS date)`, month).Scan(&stored, &hash))
	snapshot, err := attendancecore.VerifiedSnapshot(month, []byte(stored), hash)
	mustDB(f.t, err)
	return snapshot, hash
}

func monthSerial(t *testing.T, month string) int {
	t.Helper()
	first, err := time.Parse("2006-01", month)
	if err != nil {
		t.Fatal(err)
	}
	return int(first.Sub(time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)).Hours() / 24)
}

func xlsxRow(t *testing.T, row report.AttendanceRow) []string {
	t.Helper()
	state := report.Vi("{110}ang m{1edf}")
	if row.PeriodState == attendancecore.PeriodClosed {
		state = report.Vi("{110}{e3} ch{1ed1}t")
	}
	cells := []string{"s:" + row.EmployeeCode, "s:" + row.EmployeeName, fmt.Sprintf("n:%d|mm/yyyy", monthSerial(t, row.Month)), "s:" + state}
	for _, n := range []int{row.ScheduledMinutes, row.PaidHolidayMinutes, row.UnpaidMinutes, row.AnnualLeaveMinutes, row.PaidMinutes,
		row.WfhDays, row.LateCount, row.LateMinutes, row.EarlyCount, row.EarlyMinutes, row.AdjustmentMinutes} {
		cells = append(cells, fmt.Sprintf("n:%d", n))
	}
	return cells
}

func (f *reportFixture) sameExport(t *testing.T, span report.ExportQuery) attendancePage {
	t.Helper()
	f.branches.take()
	exported, delivered, err := f.reports.Export(t.Context(), f.secrets["H"], span)
	mustDB(t, err)
	if seen := f.branches.take(); len(seen) != 1 || seen[0] != (report.ExportMaxRows >= attendancecore.EffectsSetBasedMinRows) {
		t.Fatalf("export statements read set-based %v", seen)
	}
	if !delivered || exported.FileName != "hrm-report-attendance-"+span.From+"_"+span.To+".xlsx" {
		t.Fatalf("export delivered %v as %q", delivered, exported.FileName)
	}
	read, err := authority.Read(t.Context(), f.oracle, f.secrets["H"], f.query, report.Query{ExportQuery: span, Limit: report.ExportMaxRows})
	mustDB(t, err)
	grid := report.WorkbookGrid(t, exported.Content)
	if len(grid) != len(read.Value.Rows)+1 {
		t.Fatalf("workbook of %d rows, oracle %d", len(grid)-1, len(read.Value.Rows))
	}
	header := []string{}
	for _, name := range []string{"M{e3} NV", "H{1ecd} t{ea}n", "Th{e1}ng", "K{1ef3} c{f4}ng", "Ph{fa}t theo l{1ecb}ch",
		"Ph{fa}t ngh{1ec9} l{1ec5} h{1b0}{1edf}ng l{1b0}{1a1}ng", "Ph{fa}t ngh{1ec9} kh{f4}ng l{1b0}{1a1}ng", "Ph{fa}t ph{e9}p n{103}m",
		"Ph{fa}t {111}{1b0}{1ee3}c tr{1ea3} l{1b0}{1a1}ng", "Ng{e0}y WFH", "S{1ed1} l{1ea7}n {111}i mu{1ed9}n", "Ph{fa}t {111}i mu{1ed9}n",
		"S{1ed1} l{1ea7}n v{1ec1} s{1edb}m", "Ph{fa}t v{1ec1} s{1edb}m", "Ph{fa}t {111}i{1ec1}u ch{1ec9}nh c{f4}ng"} {
		header = append(header, "s:"+report.Vi(name)+"|b")
	}
	if !slices.Equal(grid[0], header) {
		t.Fatalf("workbook header\n got %q\nwant %q", grid[0], header)
	}
	for i, row := range read.Value.Rows {
		if want := xlsxRow(t, row); !slices.Equal(grid[i+1], want) {
			t.Fatalf("workbook row %d\n got %q\nwant %q", i+1, grid[i+1], want)
		}
	}
	return read.Value
}

func TestAClosedMonthIsServedFromItsSnapshotInTheReportAndTheExport(t *testing.T) {
	f := newReportFixture(t)
	equivalenceDataset(f)
	span := report.ExportQuery{Kind: report.KindAttendance, From: "2026-03", To: "2026-04"}
	f.sameExport(t, span)

	want := f.oracleSnapshot("2026-03")
	f.closeMonth("2026-03")
	stored, hash := f.storedSnapshot("2026-03")
	wantCanonical, err := attendancecore.CanonicalSnapshot(want)
	mustDB(t, err)
	gotCanonical, err := attendancecore.CanonicalSnapshot(stored)
	mustDB(t, err)
	wantHash, err := attendancecore.SnapshotHash(want)
	mustDB(t, err)
	if string(gotCanonical) != string(wantCanonical) || hash != wantHash {
		t.Fatalf("stored snapshot %s (hash %s)\nwant %s (hash %s)", gotCanonical, hash, wantCanonical, wantHash)
	}

	// Facts of March written after the close make the live totals differ from the snapshot.
	f.adjustment("A1", "2026-03-16", 90)
	f.request("A3", "annual-leave", "approved", []string{"2026-03-17"}, 540, 1080)
	changed := f.oracleSnapshot("2026-03")
	for _, name := range []string{"A1", "A3"} {
		at := func(s attendancecore.Snapshot) int {
			return slices.IndexFunc(s.Employees, func(e attendancecore.SnapshotEmployee) bool { return e.EmployeeID == f.employees[name] })
		}
		before, after := at(stored), at(changed)
		if before < 0 || after < 0 || stored.Employees[before].Totals == changed.Employees[after].Totals {
			t.Fatalf("live March of %s does not differ from its snapshot", name)
		}
	}

	if seen := f.sameReports(t); seen.perRow == 0 || seen.setBased == 0 || seen.closedPerRow == 0 || seen.closedSetBased == 0 {
		t.Fatalf("pages compared after the close: %+v", seen)
	}
	snapshot := map[string]attendancecore.Totals{}
	for _, e := range stored.Employees {
		snapshot[e.EmployeeID] = e.Totals
	}
	fromSnapshot := func(label string, rows []report.AttendanceRow) {
		t.Helper()
		march := 0
		for _, row := range rows {
			if row.Month != "2026-03" {
				if row.PeriodState != attendancecore.PeriodOpen {
					t.Fatalf("%s: %s %s is %s", label, row.EmployeeCode, row.Month, row.PeriodState)
				}
				continue
			}
			march++
			if totals, ok := snapshot[row.EmployeeID]; !ok || row.PeriodState != attendancecore.PeriodClosed || row.Totals != totals {
				t.Fatalf("%s: %s March %s %+v, snapshot %+v (listed %v)", label, row.EmployeeCode, row.PeriodState, row.Totals, totals, ok)
			}
		}
		if march != len(stored.Employees) {
			t.Fatalf("%s: %d March rows, %d in the snapshot", label, march, len(stored.Employees))
		}
	}
	fromSnapshot("export", f.sameExport(t, span).Rows)
	for _, limit := range []int{100, attendancecore.EffectsSetBasedMinRows} {
		fromSnapshot(fmt.Sprintf("JSON limit %d", limit), attendanceOf(t, f.report("H", monthly(report.KindAttendance, "2026-03", "2026-04", limit, 0))).Rows)
	}

	month := "2026-03"
	sheet, found, err := f.sheets.Sheet(t.Context(), f.secrets["root"], attendance.SheetQuery{EmployeeID: f.employees["A1"], Month: &month})
	mustDB(t, err)
	live := f.oracleSnapshot(month)
	index := slices.IndexFunc(live.Employees, func(e attendancecore.SnapshotEmployee) bool { return e.EmployeeID == f.employees["A1"] })
	if index < 0 {
		t.Fatal("A1 is missing from the live facts of March")
	}
	if !found || sheet.PeriodState != attendancecore.PeriodClosed || sheet.Totals != live.Employees[index].Totals {
		t.Fatalf("sheet of A1 in closed March %+v (found %v), live facts %+v", sheet, found, live.Employees[index])
	}
}

type legacyEmployee struct {
	EmployeeID         string `json:"employeeId"`
	ScheduledMinutes   int    `json:"scheduledMinutes"`
	PaidHolidayMinutes int    `json:"paidHolidayMinutes"`
	UnpaidMinutes      int    `json:"unpaidMinutes"`
	AnnualLeaveMinutes int    `json:"annualLeaveMinutes"`
	PaidMinutes        int    `json:"paidMinutes"`
	WfhDays            int    `json:"wfhDays"`
	LateCount          int    `json:"lateCount"`
	LateMinutes        int    `json:"lateMinutes"`
	EarlyCount         int    `json:"earlyCount"`
	EarlyMinutes       int    `json:"earlyMinutes"`
}

type legacyDocument struct {
	Month           string           `json:"month"`
	CalendarVersion string           `json:"calendarVersion"`
	Employees       []legacyEmployee `json:"employees"`
}

// legacySnapshot rewrites the stored snapshot of a closed month into the shape and hash of a close made
// before adjustments existed: no formatVersion, no adjustmentMinutes, the other numbers kept.
func (f *reportFixture) legacySnapshot(month string) {
	f.t.Helper()
	stored, _ := f.storedSnapshot(month)
	doc := legacyDocument{Month: month, CalendarVersion: stored.CalendarVersion}
	for _, e := range stored.Employees {
		doc.Employees = append(doc.Employees, legacyEmployee{e.EmployeeID, e.ScheduledMinutes, e.PaidHolidayMinutes, e.UnpaidMinutes,
			e.AnnualLeaveMinutes, e.PaidMinutes, e.WfhDays, e.LateCount, e.LateMinutes, e.EarlyCount, e.EarlyMinutes})
	}
	canonical, err := json.Marshal(doc)
	mustDB(f.t, err)
	sum := sha256.Sum256(canonical)
	f.exec(`UPDATE attendance_period SET snapshot = CAST($2 AS jsonb), snapshot_hash = $3 WHERE month = CAST($1 || '-01' AS date)`,
		month, string(canonical), hex.EncodeToString(sum[:]))
}

func TestTheReportCountsAdjustmentsAsTheSheetLiveAndFromASnapshot(t *testing.T) {
	f := newReportFixture(t)
	f.hire("A6", []string{"hr.employee"}, "", true)
	f.hire("A9", []string{"hr.employee"}, "", true)
	f.adjust("A9", "2026-06-03", 200)
	f.adjust("A6", "2026-02-02", 120)
	june := "2026-06"
	sheet, found, err := f.sheets.Sheet(t.Context(), f.secrets["H"], attendance.SheetQuery{EmployeeID: f.employees["A9"], Month: &june})
	mustDB(t, err)
	if !found || sheet.AdjustmentMinutes != 200 {
		t.Fatalf("sheet of A9 in June %+v (found %v)", sheet, found)
	}
	row := func(name, month string, limit int) report.AttendanceRow {
		t.Helper()
		page := attendanceOf(t, f.report("H", monthly(report.KindAttendance, month, month, limit, 0)))
		found := rowsOf(page.Rows, attendanceEmployee, f.employees[name])
		if len(found) != 1 {
			t.Fatalf("%s in %s, limit %d: %d rows", name, month, limit, len(found))
		}
		return found[0]
	}
	limits := []int{100, attendancecore.EffectsSetBasedMinRows}
	for _, limit := range limits {
		if live := row("A9", june, limit); live.PeriodState != attendancecore.PeriodOpen || live.Totals != sheet.Totals {
			t.Fatalf("limit %d: live June of A9 %s %+v, sheet %+v", limit, live.PeriodState, live.Totals, sheet.Totals)
		}
	}
	f.closeMonth(june)
	for _, limit := range limits {
		if closed := row("A9", june, limit); closed.PeriodState != attendancecore.PeriodClosed || closed.Totals != sheet.Totals {
			t.Fatalf("limit %d: closed June of A9 %s %+v, sheet %+v", limit, closed.PeriodState, closed.Totals, sheet.Totals)
		}
	}

	f.closeMonth("2026-02")
	var february attendancecore.Totals
	for _, limit := range limits {
		closed := row("A6", "2026-02", limit)
		if closed.PeriodState != attendancecore.PeriodClosed || closed.AdjustmentMinutes != 120 {
			t.Fatalf("limit %d: closed February of A6 %s %+v", limit, closed.PeriodState, closed.Totals)
		}
		february = closed.Totals
	}
	f.legacySnapshot("2026-02")
	legacy := february
	legacy.AdjustmentMinutes = 0
	for _, limit := range limits {
		if got := row("A6", "2026-02", limit); got.PeriodState != attendancecore.PeriodClosed || got.Totals != legacy {
			t.Fatalf("limit %d: February of A6 from a format 1 snapshot %+v, want %+v", limit, got.Totals, legacy)
		}
	}
}
