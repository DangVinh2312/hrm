//go:build integration

package leave

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/modules/leavecore"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

// leaveFixture: H = HR/Admin, L = lead of the team of E, E = employee, O = employee outside the team,
// C = COO, N = signed in without any HR role, R = Root. Every profile is hired official on 2026-01-05 at
// 5760 minutes a year (480 a counted month), so March 2026 accrues 1440 by its end. Past dates are fixed
// and nothing depends on the run date. Synthetic people only.
type leaveFixture struct {
	s         *testdb.Stack
	conn      *pgx.Conn
	service   *Service
	fresh     map[string]string
	stale     map[string]string
	accounts  map[string]string
	employees map[string]string
	team      string
	codes     int
}

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func newLeaveFixture(t *testing.T) *leaveFixture {
	t.Helper()
	f := &leaveFixture{s: testdb.NewDatabase(t), fresh: map[string]string{}, stale: map[string]string{}, accounts: map[string]string{}, employees: map[string]string{}}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	f.accounts["R"] = fixture.Root(t, f.s).ID
	f.team = f.one(t, `INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Leave' FROM gen_random_uuid() g RETURNING id::text`)
	for _, name := range []string{"H", "L", "E", "O", "C", "N"} {
		roles := map[string][]string{"H": {"hr.employee", "hr.admin"}, "C": {"hr.employee", "hr.coo"}, "N": nil}[name]
		if name == "L" || name == "E" || name == "O" {
			roles = []string{"hr.employee"}
		}
		f.accounts[name] = fixture.Account(t, f.s, fixture.AccountSpec{Roles: roles}).ID
		if name != "N" {
			f.hire(t, name, "2026-01-05", 5760, name == "L" || name == "E")
		}
	}
	f.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, f.team, f.employees["L"])
	for name, id := range f.accounts {
		f.fresh[name] = fixture.Session(t, f.s, id, fixture.SessionSpec{Fresh: true})
		f.stale[name] = fixture.Session(t, f.s, id, fixture.SessionSpec{})
	}
	c, err := declarations.NewCore()
	mustDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	mustDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	mustDB(t, err)
	ops := NewOperations()
	a, err := authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), nil, ops.All()...)
	mustDB(t, err)
	f.service = ops.Bind(a)
	return f
}

func (f *leaveFixture) one(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	mustDB(t, f.conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *leaveFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.conn.Exec(t.Context(), sql, args...)
	mustDB(t, err)
}

// hire gives name an employee profile (linked to its account when it has one), official from hiredOn at
// rate, in the team when member.
func (f *leaveFixture) hire(t *testing.T, name, hiredOn string, rate int, member bool) string {
	t.Helper()
	f.codes++
	id := fixture.Employee(t, f.s, fixture.EmployeeSpec{Code: "V" + strconv.Itoa(100+f.codes) + "-" + name, AccountID: f.accounts[name], HiredOn: hiredOn}).ID
	f.employees[name] = id
	f.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official',CAST($2 AS date))`, id, hiredOn)
	f.exec(t, `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
      SELECT g,public.hr_register_object('leaveRate',g),$1,CAST($2 AS date),$3 FROM gen_random_uuid() g`, id, hiredOn, rate)
	if member {
		f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, id)
	}
	return id
}

// pending is an annual-leave request waiting for the lead, written the way an older build left it: the
// reconciliation lists exactly such requests (submit is a later route).
func (f *leaveFixture) pending(t *testing.T, name string, dates ...string) string {
	t.Helper()
	id := f.one(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'annual-leave','pending_lead','Fixture' FROM gen_random_uuid() g
      RETURNING id::text`, f.employees[name], f.accounts["H"], f.team)
	for _, date := range dates {
		f.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
        VALUES($1,'annual-leave',CAST($2 AS date),540,1080,480)`, id, date)
	}
	return id
}

func (f *leaveFixture) balance(t *testing.T, actor, name, asOn string) (leavecore.BalanceView, bool) {
	t.Helper()
	view, found, err := f.service.Balance(t.Context(), f.fresh[actor], BalanceQuery{EmployeeID: f.employees[name], AsOn: &asOn})
	mustDB(t, err)
	return view, found
}

func (f *leaveFixture) entitled(t *testing.T, name, asOn string) int {
	t.Helper()
	view, found := f.balance(t, "H", name, asOn)
	if !found {
		t.Fatalf("HR does not see %s", name)
	}
	return view.EntitledMinutes
}

func (f *leaveFixture) reconciliation(t *testing.T, actor string, year, limit, offset int) ReconciliationView {
	t.Helper()
	view, err := f.service.Reconciliation(t.Context(), f.fresh[actor], ReconciliationQuery{Year: &year, Limit: limit, Offset: offset})
	mustDB(t, err)
	return view
}

func (f *leaveFixture) audits(t *testing.T, kind string) int {
	t.Helper()
	n, err := strconv.Atoi(f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')=$1`, kind))
	mustDB(t, err)
	return n
}

func TestTheBalanceAccruesThroughTheQuery(t *testing.T) {
	f := newLeaveFixture(t)
	f.hire(t, "A14", "2026-01-05", 6720, false)
	f.hire(t, "OLD", "2020-01-06", 5760, false)
	annual := 5760
	march, found := f.balance(t, "H", "E", "2026-03-31")
	want := leavecore.BalanceView{EmployeeID: f.employees["E"], Year: 2026, AsOn: "2026-03-31", AnnualMinutes: &annual, EntitledMinutes: 1440, AvailableMinutes: 1440}
	if !found || !reflect.DeepEqual(march, want) {
		t.Fatalf("march: %v %+v", found, march)
	}
	for _, tc := range []struct {
		name, asOn string
		want       int
	}{
		{"E", "2026-12-31", 5760}, {"A14", "2026-03-31", 1680}, {"A14", "2026-12-31", 6720},
		{"E", "2027-01-31", 480}, {"OLD", "2026-01-31", 480}, {"OLD", "2026-12-31", 5760},
	} {
		if got := f.entitled(t, tc.name, tc.asOn); got != tc.want {
			t.Errorf("%s at %s: %d, want %d", tc.name, tc.asOn, got, tc.want)
		}
	}
	if view, _ := f.balance(t, "H", "A14", "2026-03-31"); view.AnnualMinutes == nil || *view.AnnualMinutes != 6720 {
		t.Errorf("agreed rate %+v", view.AnnualMinutes)
	}
	today := f.one(t, `SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,'YYYY-MM-DD')`)
	view, found, err := f.service.Balance(t.Context(), f.fresh["E"], BalanceQuery{EmployeeID: f.employees["E"]})
	mustDB(t, err)
	if !found || view.AsOn != today {
		t.Errorf("default report date %v %q, want %q", found, view.AsOn, today)
	}
}

// Probation accrues nothing and is not paid back; a rate applies from the month whose 15th it covers. The
// periods are written as employee.official and employee.adjustLeaveRate leave them (both M2 routes).
func TestProbationAndARateChangeThroughTheQuery(t *testing.T) {
	f := newLeaveFixture(t)
	p2 := fixture.Employee(t, f.s, fixture.EmployeeSpec{HiredOn: "2026-07-01"}).ID
	f.employees["P2"] = p2
	f.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on,ends_on) VALUES
      (gen_random_uuid(),$1,'probation',DATE '2026-07-01',DATE '2026-09-01'),(gen_random_uuid(),$1,'official',DATE '2026-09-01',NULL)`, p2)
	f.exec(t, `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
      SELECT g,public.hr_register_object('leaveRate',g),$1,DATE '2026-09-01',5760 FROM gen_random_uuid() g`, p2)
	f.exec(t, `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
      SELECT g,public.hr_register_object('leaveRate',g),$1,DATE '2026-06-01',6720 FROM gen_random_uuid() g`, f.employees["O"])
	for _, tc := range []struct {
		name, asOn string
		want       int
	}{
		{"P2", "2026-08-31", 0}, {"P2", "2026-09-30", 480}, {"P2", "2026-12-31", 1920},
		{"O", "2026-05-31", 2400}, {"O", "2026-06-30", 2400 + 560}, {"O", "2026-12-31", 2400 + 6720 - 2800},
	} {
		if got := f.entitled(t, tc.name, tc.asOn); got != tc.want {
			t.Errorf("%s at %s: %d, want %d", tc.name, tc.asOn, got, tc.want)
		}
	}
	if view, _ := f.balance(t, "H", "P2", "2026-08-31"); view.AnnualMinutes != nil {
		t.Errorf("probation shows a rate %d", *view.AnnualMinutes)
	}
	_, err := f.conn.Exec(t.Context(), `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
      SELECT g,public.hr_register_object('leaveRate',g),$1,DATE '2026-07-01',5280 FROM gen_random_uuid() g`, f.employees["O"])
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "23514" {
		t.Errorf("a rate under 12 days: %v", testdb.Redact(err))
	}
}

func TestWhoReadsABalanceAndThatAbsentIsForeign(t *testing.T) {
	f := newLeaveFixture(t)
	for _, pair := range [][2]string{{"E", "E"}, {"L", "E"}, {"L", "L"}, {"H", "E"}, {"H", "C"}, {"C", "C"}, {"O", "O"}, {"R", "E"}} {
		if view, found := f.balance(t, pair[0], pair[1], "2026-03-31"); !found || view.EmployeeID != f.employees[pair[1]] {
			t.Errorf("%s -> %s: %v %+v", pair[0], pair[1], found, view)
		}
	}
	for _, pair := range [][2]string{{"E", "O"}, {"O", "E"}, {"L", "C"}, {"L", "O"}, {"C", "E"}, {"N", "E"}} {
		if view, found := f.balance(t, pair[0], pair[1], "2026-03-31"); found {
			t.Errorf("%s -> %s read %+v", pair[0], pair[1], view)
		}
	}
	absent := BalanceQuery{EmployeeID: "00000000-0000-4000-8000-000000000000"}
	for _, actor := range []string{"H", "E", "R"} {
		_, found, err := f.service.Balance(t.Context(), f.fresh[actor], absent)
		mustDB(t, err)
		if found {
			t.Errorf("%s found an absent employee", actor)
		}
	}
	if got := f.audits(t, "access.employee.readLeaveBalance"); got != 2 {
		t.Errorf("Root reads audited %d times, want 2 (one found, one absent)", got)
	}
}

func TestPendingLeaveIsPendingNeverUsed(t *testing.T) {
	f := newLeaveFixture(t)
	f.pending(t, "E", "2026-03-09")
	view, _ := f.balance(t, "E", "E", "2026-03-31")
	if view.UsedMinutes != 0 || view.FutureApprovedMinutes != 0 || view.PendingMinutes != 480 || view.AvailableMinutes != 960 || view.EntitledMinutes != 1440 {
		t.Fatalf("%+v", view)
	}
}

func excessOf(view ReconciliationView, employee string) []ExcessView {
	var mine []ExcessView
	for _, item := range view.Items {
		if item.EmployeeID == employee {
			mine = append(mine, item)
		}
	}
	return mine
}

func TestTheReconciliationListsPendingLeaveAboveTheAccrualInTheScope(t *testing.T) {
	f := newLeaveFixture(t)
	f.hire(t, "R1", "2026-01-05", 5760, true)
	f.hire(t, "R2", "2026-01-05", 5760, true)
	id := f.pending(t, "R1", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06")
	f.pending(t, "R2", "2026-03-02")
	state := `SELECT state||':'||version FROM work_request WHERE id=$1`
	before := f.one(t, state, id)
	page := f.reconciliation(t, "H", 2026, 100, 0)
	mine := excessOf(page, f.employees["R1"])
	if page.Year != 2026 || len(mine) != 2 {
		t.Fatalf("%+v", page)
	}
	for i, want := range [][4]int{{3, 1440, 2400, 960}, {4, 1920, 2400, 480}} {
		got := [4]int{mine[i].Month, mine[i].AccruedMinutes, mine[i].PendingMinutes, mine[i].ExcessMinutes}
		if got != want || !reflect.DeepEqual(mine[i].RequestIDs, []string{id}) || mine[i].EmployeeCode[0] != 'V' {
			t.Errorf("month %d: %+v", want[0], mine[i])
		}
	}
	if len(excessOf(page, f.employees["R2"])) != 0 {
		t.Error("a fitting request is listed")
	}
	if after := f.one(t, state, id); after != before {
		t.Errorf("the list changed the request: %s -> %s", before, after)
	}
	if own := f.reconciliation(t, "E", 2026, 100, 0); len(own.Items) != 0 || own.Total != "0" {
		t.Errorf("E sees %+v", own)
	}
	if led := f.reconciliation(t, "L", 2026, 100, 0); len(excessOf(led, f.employees["R1"])) != 2 || led.Total != "2" {
		t.Errorf("the lead sees %+v", led)
	}
	for _, actor := range []string{"O", "C", "N"} {
		if other := f.reconciliation(t, actor, 2026, 100, 0); len(other.Items) != 0 || other.Total != "0" {
			t.Errorf("%s sees %+v", actor, other)
		}
	}
	beyond := f.reconciliation(t, "H", 2026, 1, 2)
	if len(beyond.Items) != 0 || beyond.Total != page.Total || page.Total != "2" {
		t.Errorf("beyond the last page: %+v, total %s", beyond, page.Total)
	}
	if other := f.reconciliation(t, "H", 2031, 100, 0); len(other.Items) != 0 || other.Year != 2031 {
		t.Errorf("2031: %+v", other)
	}
}

// The page is cut after the scope: an employee outside the lead's team who sorts first by code does not
// take the lead's only row.
func TestTheReconciliationScopesBeforeItPages(t *testing.T) {
	f := newLeaveFixture(t)
	f.exec(t, `UPDATE employee SET code='A-first' WHERE id=$1`, f.employees["O"])
	f.exec(t, `UPDATE employee SET code='Z-last' WHERE id=$1`, f.employees["E"])
	f.pending(t, "O", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05")
	f.pending(t, "E", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05")
	led := f.reconciliation(t, "L", 2026, 1, 0)
	if led.Total != "1" || len(led.Items) != 1 || led.Items[0].EmployeeID != f.employees["E"] {
		t.Fatalf("lead page %+v", led)
	}
	if all := f.reconciliation(t, "H", 2026, 1, 0); all.Total != "2" || len(all.Items) != 1 || all.Items[0].EmployeeID != f.employees["O"] {
		t.Fatalf("HR page %+v", all)
	}
}

// X has an approved day in February (a debit in the ledger), a pending request for two days in March
// written before one for a day in February, and one for a day in May: March alone exceeds, by the approved
// day, and lists the two earlier requests oldest first but not May's.
func TestTheReconciliationCountsApprovedLeaveAndListsRequestsUpToTheMonth(t *testing.T) {
	f := newLeaveFixture(t)
	f.hire(t, "X", "2026-01-05", 5760, false)
	approved := f.pending(t, "X", "2026-02-10")
	f.exec(t, `UPDATE work_request SET state='approved' WHERE id=$1`, approved)
	f.exec(t, `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,source_request_id,source_work_date)
      VALUES(gen_random_uuid(),$1,'debit',DATE '2026-02-10',480,$2,DATE '2026-02-10')`, f.employees["X"], approved)
	march := f.pending(t, "X", "2026-03-03", "2026-03-04")
	february := f.pending(t, "X", "2026-02-16")
	f.pending(t, "X", "2026-05-04")
	page := f.reconciliation(t, "H", 2026, 100, 0)
	want := []ExcessView{{
		EmployeeID: f.employees["X"], Month: 3, AccruedMinutes: 1440, ApprovedMinutes: 480, PendingMinutes: 1440,
		ExcessMinutes: 480, RequestIDs: []string{february, march},
	}}
	mine := excessOf(page, f.employees["X"])
	for i := range mine {
		mine[i].EmployeeCode, mine[i].EmployeeName = "", ""
	}
	if page.Total != "1" || !reflect.DeepEqual(mine, want) {
		t.Fatalf("total %s, %+v", page.Total, mine)
	}
	year, err := strconv.Atoi(f.one(t, `SELECT EXTRACT(year FROM (statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh'))::text`))
	mustDB(t, err)
	current, err := f.service.Reconciliation(t.Context(), f.fresh["H"], ReconciliationQuery{Limit: 100})
	mustDB(t, err)
	if explicit := f.reconciliation(t, "H", year, 100, 0); current.Year != year || !reflect.DeepEqual(current, explicit) {
		t.Errorf("no year: %+v, want the business year %d: %+v", current, year, explicit)
	}
}

func TestANegativeEntitlementOnlyForbidsTakingLeave(t *testing.T) {
	f := newLeaveFixture(t)
	f.exec(t, `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,reference)
      VALUES(gen_random_uuid(),$1,'adjustment',DATE '2026-01-02',-3000,'adjustment:fixture')`, f.employees["E"])
	f.pending(t, "E", "2026-03-02")
	mine := excessOf(f.reconciliation(t, "H", 2026, 100, 0), f.employees["E"])
	if len(mine) == 0 || mine[0].Month != 3 || mine[0].AccruedMinutes != -1560 || mine[0].ExcessMinutes != 480 {
		t.Fatalf("%+v", mine)
	}
}

func TestTheLedgerSchemaAndTheRuntimeLoginsOnlyAppend(t *testing.T) {
	f := newLeaveFixture(t)
	approved := f.pending(t, "E", "2026-04-07")
	f.exec(t, `UPDATE work_request SET state='approved' WHERE id=$1`, approved)
	insert := func(kind string, minutes int, source, reverses, reference *string, date string) string {
		var sourceDate *string
		if source != nil {
			sourceDate = &date
		}
		_, err := f.conn.Exec(t.Context(), `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,source_request_id,source_work_date,reverses_entry_id,reference)
        VALUES(gen_random_uuid(),$1,$2,CAST($3 AS date),$4,$5,CAST($6 AS date),$7,$8)`, f.employees["E"], kind, date, minutes, source, sourceDate, reverses, reference)
		if pg, ok := errors.AsType[*pgconn.PgError](err); ok {
			return pg.Code
		}
		mustDB(t, err)
		return ""
	}
	ref := func(s string) *string { return &s }
	for _, tc := range []struct {
		name, want string
		code       string
	}{
		{"opening without a source", "23514", insert("opening", 480, nil, nil, nil, "2026-04-07")},
		{"empty source", "23514", insert("opening", 480, nil, nil, ref(""), "2026-04-07")},
		{"zero adjustment", "23514", insert("adjustment", 0, nil, nil, ref("x"), "2026-04-07")},
		{"debit above 720", "23514", insert("debit", 721, &approved, nil, nil, "2026-04-07")},
		{"debit without segment", "23514", insert("debit", 480, nil, nil, nil, "2026-04-07")},
		{"reversal without debit", "23514", insert("reversal", 480, nil, nil, nil, "2026-04-07")},
		{"accrual kind", "23514", insert("accrual", 480, nil, nil, ref("x"), "2026-04-07")},
		{"adjustment above 175680", "23514", insert("adjustment", 175681, nil, nil, ref("x"), "2026-04-07")},
		{"debit of a missing segment", "23503", insert("debit", 480, &approved, nil, nil, "2026-04-08")},
	} {
		if tc.code != tc.want {
			t.Errorf("%s: %q, want %s", tc.name, tc.code, tc.want)
		}
	}
	if code := insert("adjustment", -175680, nil, nil, ref("adjustment:fixture"), "2026-04-07"); code != "" {
		t.Errorf("signed adjustment with a source refused: %s", code)
	}
	debit := f.one(t, `INSERT INTO leave_ledger(id,employee_id,entry_kind,effective_on,minutes,source_request_id,source_work_date)
      VALUES(gen_random_uuid(),$1,'debit',DATE '2026-04-07',480,$2,DATE '2026-04-07') RETURNING id::text`, f.employees["E"], approved)
	unpaid := f.one(t, `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'unpaid-leave','approved','Fixture' FROM gen_random_uuid() g
      RETURNING id::text`, f.employees["E"], f.accounts["H"], f.team)
	f.exec(t, `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      VALUES($1,'unpaid-leave',DATE '2026-04-09',540,1080,480)`, unpaid)
	for _, tc := range []struct {
		name, want, code string
	}{
		{"second debit of a segment", "23505", insert("debit", 480, &approved, nil, nil, "2026-04-07")},
		{"debit of an unpaid-leave segment", "23503", insert("debit", 480, &unpaid, nil, nil, "2026-04-09")},
		{"reversal of other minutes", "23503", insert("reversal", 240, nil, &debit, nil, "2026-04-07")},
		{"reversal on another date", "23503", insert("reversal", 480, nil, &debit, nil, "2026-04-08")},
		{"first reversal", "", insert("reversal", 480, nil, &debit, nil, "2026-04-07")},
		{"second reversal", "23505", insert("reversal", 480, nil, &debit, nil, "2026-04-07")},
	} {
		if tc.code != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, tc.code, tc.want)
		}
	}
	login := func(name string) *pgx.Conn {
		conn, err := pgx.Connect(t.Context(), f.s.LoginURL(name))
		mustDB(t, err)
		t.Cleanup(func() { mustDB(t, conn.Close(context.WithoutCancel(t.Context()))) })
		return conn
	}
	sqlState := func(conn *pgx.Conn, sql string, args ...any) string {
		_, err := conn.Exec(t.Context(), sql, args...)
		if pg, ok := errors.AsType[*pgconn.PgError](err); ok {
			return pg.Code
		}
		mustDB(t, err)
		return ""
	}
	data := login("data")
	for _, statement := range []string{
		"UPDATE leave_ledger SET minutes = 1", "DELETE FROM leave_ledger", "DELETE FROM leave_bucket",
		"UPDATE leave_bucket SET year = 2000", "UPDATE leave_bucket SET employee_id = employee_id",
		"UPDATE hr_idempotency SET payload_hash = payload_hash", "DELETE FROM hr_idempotency",
	} {
		if code := sqlState(data, statement); code != "42501" {
			t.Errorf("data %s: %q", statement, code)
		}
	}
	if code := sqlState(data, `INSERT INTO leave_bucket(employee_id, year) VALUES ($1, 2031) ON CONFLICT DO NOTHING`, f.employees["E"]); code != "" {
		t.Errorf("data cannot create a bucket: %s", code)
	}
	if code := sqlState(data, `UPDATE leave_bucket SET revision = revision + 1 WHERE year = 2031`); code != "" {
		t.Errorf("data cannot bump a bucket: %s", code)
	}
	for _, name := range []string{"authority", "identity", "sync"} {
		conn := login(name)
		for _, table := range []string{"leave_ledger", "leave_bucket", "hr_idempotency"} {
			if code := sqlState(conn, "SELECT 1 FROM "+table); code != "42501" {
				t.Errorf("%s reads %s: %q", name, table, code)
			}
		}
	}
}

// waitBlocked returns once n data-login backends wait on a lock, inside the runner's lock timeout.
func (f *leaveFixture) waitBlocked(t *testing.T, n int) {
	t.Helper()
	for deadline := time.Now().Add(900 * time.Millisecond); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if f.one(t, `SELECT (count(*) >= $1)::text FROM pg_stat_activity WHERE datname=current_database() AND usename='product_data' AND cardinality(pg_blocking_pids(pid))>0`, n) == "true" {
			return
		}
	}
	t.Fatalf("%d adjustments did not wait on a lock", n)
}
