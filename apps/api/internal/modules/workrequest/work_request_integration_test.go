//go:build integration

package workrequest

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/modules/hrbase"
	testdb "hrm/api/test"
	"hrm/api/test/fixture"
)

// requestFixture: H = HR/Admin, L = lead of the team, E = member, O = profile in no team, C = COO in the
// team, N = signed in without any HR role, R = Root. Every profile is official since 2020 at 5760 minutes
// a year. Dates are business days of the week after next, read from the DB clock, so nothing depends on
// the run date. Synthetic people only.
type requestFixture struct {
	s         *testdb.Stack
	conn      *pgx.Conn
	service   *Service
	sessions  map[string]string
	accounts  map[string]string
	employees map[string]string
	team      string
	monday    string
}

const newKey = `SELECT gen_random_uuid()::text`

// requestState is every row a submit writes, in one value.
const requestState = `SELECT concat_ws('|',
  (SELECT count(*) FROM work_request), (SELECT count(*) FROM work_request_segment),
  (SELECT count(*) FROM request_decision), (SELECT count(*) FROM hr_idempotency),
  (SELECT count(*) FROM audit_outbox), (SELECT count(*) FROM leave_ledger),
  (SELECT coalesce(sum(approved_count),0) FROM wfh_month_counter), (SELECT count(*) FROM object_ref))`

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func newRequestFixture(t *testing.T) *requestFixture {
	t.Helper()
	return newRequestFixtureWith(t, createApprovedEffects())
}

func newRequestFixtureWith(t *testing.T, effects ApprovedEffects) *requestFixture {
	t.Helper()
	f := &requestFixture{s: testdb.NewDatabase(t), sessions: map[string]string{}, accounts: map[string]string{}, employees: map[string]string{}}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	f.accounts["R"] = fixture.Root(t, f.s).ID
	f.team = f.one(t, `INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Requests' FROM gen_random_uuid() g RETURNING id::text`)
	for _, name := range []string{"H", "L", "E", "O", "C", "N"} {
		roles := map[string][]string{"H": {"hr.employee", "hr.admin"}, "C": {"hr.employee", "hr.coo"}, "L": {"hr.employee"}, "E": {"hr.employee"}, "O": {"hr.employee"}}[name]
		f.accounts[name] = fixture.Account(t, f.s, fixture.AccountSpec{Roles: roles}).ID
		if name != "N" {
			f.hire(t, name, name == "L" || name == "E" || name == "C")
		}
	}
	f.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, f.team, f.employees["L"])
	for name, id := range f.accounts {
		f.sessions[name] = fixture.Session(t, f.s, id, fixture.SessionSpec{Fresh: true})
	}
	f.monday = f.one(t, `WITH n AS (SELECT `+hrbase.BusinessToday+` + (15 - extract(isodow FROM `+hrbase.BusinessToday+`)::int) AS d)
      SELECT to_char(CASE WHEN extract(year FROM d) = extract(year FROM d + 11) THEN d ELSE d + 14 END,'YYYY-MM-DD') FROM n`)
	c, err := declarations.NewCore()
	mustDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	mustDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	mustDB(t, err)
	ops := newOperations(effects)
	a, err := authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), nil, ops.All()...)
	mustDB(t, err)
	f.service = ops.Bind(a)
	return f
}

func (f *requestFixture) one(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	mustDB(t, f.conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *requestFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.conn.Exec(t.Context(), sql, args...)
	mustDB(t, err)
}

// hire gives name an official profile linked to its account since 2020 at 5760 a year, in the team when
// member.
func (f *requestFixture) hire(t *testing.T, name string, member bool) {
	t.Helper()
	id := fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: f.accounts[name], HiredOn: "2020-01-06"}).ID
	f.employees[name] = id
	f.exec(t, `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES(gen_random_uuid(),$1,'official',DATE '2020-01-06')`, id)
	f.exec(t, `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
      SELECT g,public.hr_register_object('leaveRate',g),$1,DATE '2020-01-06',5760 FROM gen_random_uuid() g`, id)
	if member {
		f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, f.team, id)
	}
}

// day is the business date n days after the fixture's Monday.
func (f *requestFixture) day(t *testing.T, n int) string {
	t.Helper()
	return f.one(t, `SELECT to_char(CAST($1 AS date) + CAST($2 AS int),'YYYY-MM-DD')`, f.monday, n)
}

func (f *requestFixture) late(t *testing.T, n, minute int) SubmitInput {
	return SubmitInput{Kind: hrbase.RequestLateArrival, Reason: "x", Date: f.day(t, n), ExpectedMinute: minute}
}

func (f *requestFixture) leave(t *testing.T, kind hrbase.RequestKind, n, start, end int) SubmitInput {
	return SubmitInput{Kind: kind, Reason: "x", Segments: []Slot{{f.day(t, n), start, end}}}
}

func (f *requestFixture) wfh(t *testing.T, days ...int) SubmitInput {
	input := SubmitInput{Kind: hrbase.RequestWfh, Reason: "x"}
	for _, n := range days {
		input.Dates = append(input.Dates, f.day(t, n))
	}
	return input
}

func (f *requestFixture) submit(t *testing.T, actor string, input SubmitInput) (SubmitResult, error) {
	t.Helper()
	if input.IdempotencyKey == "" {
		input.IdempotencyKey = f.one(t, newKey)
	}
	return f.service.Submit(t.Context(), f.sessions[actor], input)
}

func (f *requestFixture) mustSubmit(t *testing.T, actor string, input SubmitInput) SubmitResult {
	t.Helper()
	result, err := f.submit(t, actor, input)
	mustDB(t, err)
	return result
}

func (f *requestFixture) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	n, err := strconv.Atoi(f.one(t, sql, args...))
	mustDB(t, err)
	return n
}

func (f *requestFixture) audits(t *testing.T, kind string) int {
	t.Helper()
	return f.count(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')=$1`, kind)
}

func (f *requestFixture) setting(t *testing.T, key string, value int) {
	t.Helper()
	f.exec(t, `INSERT INTO system_setting(key,value,version,updated_by) VALUES($1,CAST($2 AS jsonb),1,$3)`, key, strconv.Itoa(value), f.accounts["H"])
}

func (f *requestFixture) closeMonth(t *testing.T, date string) {
	t.Helper()
	f.exec(t, `INSERT INTO attendance_period(month,state,version,snapshot,snapshot_hash)
      VALUES(date_trunc('month',CAST($1 AS date))::date,'closed',2,'{}'::jsonb,repeat('a',64))
      ON CONFLICT (month) DO UPDATE SET state='closed',version=2,snapshot='{}'::jsonb,snapshot_hash=repeat('a',64)`, date)
}

func rejectedWith(err error, code apperror.Code) bool {
	rejection, ok := errors.AsType[apperror.Rejection](err)
	return ok && rejection.Code == code
}

// waitBlocked returns once n data-login backends wait on a lock, inside the runner's lock timeout.
func (f *requestFixture) waitBlocked(t *testing.T, n int) {
	t.Helper()
	for deadline := time.Now().Add(900 * time.Millisecond); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if f.one(t, `SELECT (count(*) >= $1)::text FROM pg_stat_activity WHERE datname=current_database() AND usename='product_data' AND cardinality(pg_blocking_pids(pid))>0`, n) == "true" {
			return
		}
	}
	t.Fatalf("%d submits did not wait on a lock", n)
}

type outcome struct {
	result SubmitResult
	err    error
}

// lockOrder holds second in a superuser transaction until a submit of E waits, then expects first to be
// already locked by that submit (55P03 under a 50 ms lock_timeout).
func (f *requestFixture) lockOrder(t *testing.T, input SubmitInput, second, first string) {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), second, f.employees["E"])
	mustDB(t, err)
	input.IdempotencyKey = f.one(t, newKey)
	done := make(chan outcome, 1)
	go func() {
		result, err := f.service.Submit(context.Background(), f.sessions["E"], input)
		done <- outcome{result, err}
	}()
	f.waitBlocked(t, 1)
	_, err = tx.Exec(t.Context(), `SET LOCAL lock_timeout = '50ms'`)
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), first, f.employees["E"])
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "55P03" {
		t.Errorf("%s was free while the submit waited on %s: %v", first, second, err)
	}
	mustDB(t, tx.Rollback(t.Context()))
	mustDB(t, (<-done).err)
}
