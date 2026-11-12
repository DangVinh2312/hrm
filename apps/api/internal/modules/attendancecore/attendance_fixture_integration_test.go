//go:build integration

package attendancecore_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
	testdb "hrm/api/test"
	"hrm/api/test/fixture"
)

// hr writes the rows of other modules (teams, requests, calendar, schedules) with the superuser of the
// disposable cluster; the code under test runs with the runtime logins through the runner.
type hr struct {
	t     *testing.T
	s     *testdb.Stack
	conn  *pgx.Conn
	team  string
	owner string
}

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func newHR(t *testing.T) *hr {
	t.Helper()
	s := testdb.NewDatabase(t)
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, conn.Close(context.WithoutCancel(t.Context()))) })
	f := &hr{t: t, s: s, conn: conn, owner: fixture.Account(t, s, fixture.AccountSpec{}).ID}
	f.team = f.id("INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Core' FROM gen_random_uuid() g RETURNING id::text")
	return f
}

func (f *hr) exec(sql string, args ...any) {
	f.t.Helper()
	_, err := f.conn.Exec(f.t.Context(), sql, args...)
	mustDB(f.t, err)
}

func (f *hr) id(sql string, args ...any) string {
	f.t.Helper()
	var value string
	mustDB(f.t, f.conn.QueryRow(f.t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *hr) count(sql string, args ...any) int {
	f.t.Helper()
	var value int
	mustDB(f.t, f.conn.QueryRow(f.t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *hr) employee(hiredOn string, terminatedOn any) string {
	f.t.Helper()
	id := fixture.Employee(f.t, f.s, fixture.EmployeeSpec{HiredOn: hiredOn}).ID
	if terminatedOn != nil {
		f.exec("UPDATE employee SET terminated_on = CAST($2 AS date) WHERE id = $1", id, terminatedOn)
	}
	return id
}

// request inserts a request of kind in state with one segment [start, end) per date.
func (f *hr) request(employee, kind, state string, dates []string, start, end int) string {
	f.t.Helper()
	id := f.id(`INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,$4,$5,'Fixture' FROM gen_random_uuid() g
      RETURNING id::text`, employee, f.owner, f.team, kind, state)
	minutes := end - start
	if lunch := max(0, min(end, 840)-max(start, 780)); kind != "late-arrival" && kind != "early-departure" {
		minutes -= lunch
	}
	f.exec(`INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      SELECT $1,$2,CAST(d AS date),$3,$4,$5 FROM unnest(CAST($6 AS text[])) d`, id, kind, start, end, minutes, dates)
	return id
}

// calendar records the next calendar change and moves the calendar to its version.
func (f *hr) calendar(day, kind string, asWeekday any, frameSource any) {
	f.t.Helper()
	var name any
	if kind == "paid_holiday" {
		name = "Holiday " + day
	}
	f.exec(`WITH c AS (UPDATE work_calendar SET version = version + 1 WHERE id = $1 RETURNING version)
      INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source)
      SELECT c.version,CAST($2 AS date),$3,$4,$5,$6 FROM c`, permission.WorkCalendarID, day, kind, name, asWeekday, frameSource)
}

// shifts inserts [weekday, start, end] rows of a schedule; position follows the order given per weekday.
func (f *hr) shifts(table, schedule string, shifts [][3]int) {
	f.t.Helper()
	position := map[int]int{}
	for _, s := range shifts {
		position[s[0]]++
		f.exec(`INSERT INTO `+table+`(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,$2,$3,$4,$5)`,
			schedule, s[0], position[s[0]], s[1], s[2])
	}
}

func (f *hr) companyVersion(from string, shifts [][3]int) {
	f.t.Helper()
	id := f.id("INSERT INTO work_schedule(id,effective_from) VALUES(gen_random_uuid(),CAST($1 AS date)) RETURNING id::text", from)
	f.shifts("work_schedule_shift", id, shifts)
}

func (f *hr) employeeFrames(employee, from string, to any, shifts [][3]int) {
	f.t.Helper()
	id := f.id(`INSERT INTO employee_schedule(id,employee_id,valid_from,valid_to)
      VALUES(gen_random_uuid(),$1,CAST($2 AS date),CAST($3 AS date)) RETURNING id::text`, employee, from, to)
	f.shifts("employee_schedule_shift", id, shifts)
}

func (f *hr) adjustment(employee, day string, minutes int) {
	f.t.Helper()
	f.exec(`INSERT INTO attendance_adjustment(id,employee_id,work_date,minutes,reason,actor_account_id)
      VALUES(gen_random_uuid(),$1,CAST($2 AS date),$3,'Fixture adjustment',$4)`, employee, day, minutes, f.owner)
}

func (f *hr) closeMonth(month string) {
	f.t.Helper()
	f.exec(`INSERT INTO attendance_period(month,state,version,snapshot,snapshot_hash)
      VALUES(CAST($1 AS date),'closed',2,'{}'::jsonb,repeat('a',64))
      ON CONFLICT (month) DO UPDATE SET state='closed',version=2,snapshot='{}'::jsonb,snapshot_hash=repeat('a',64)`, month)
}

func inMode[T any](t *testing.T, s *testdb.Stack, mode database.Mode, work func(tx *database.Tx) (T, error)) (T, error) {
	return database.Run(t.Context(), s.Runner, mode, func(_ context.Context, tx *database.Tx) (T, error) { return work(tx) }, database.RunOptions{})
}

func write(t *testing.T, s *testdb.Stack, work func(tx *database.Tx) error) error {
	_, err := inMode(t, s, database.ModeWrite, func(tx *database.Tx) (struct{}, error) { return struct{}{}, work(tx) })
	return err
}
