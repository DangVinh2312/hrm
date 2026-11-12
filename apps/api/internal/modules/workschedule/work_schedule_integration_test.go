//go:build integration

package workschedule

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
	"hrm/api/internal/modules/schedulecore"
	testdb "hrm/api/test"
	"hrm/api/test/fixture"
)

// scheduleFixture: H = HR/Admin, L = lead of the team of E, E = employee, O = employee outside the team,
// N = signed in without any HR role, R = Root. Synthetic people only.
type scheduleFixture struct {
	s         *testdb.Stack
	conn      *pgx.Conn
	service   *Service
	fresh     map[string]string
	stale     map[string]string
	employees map[string]string
}

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

// refused takes the answer of a two-value call: refused(t, want)(call(...)).
func refused(t *testing.T, want error) func(any, error) {
	return func(value any, err error) {
		t.Helper()
		if !errors.Is(err, want) {
			t.Fatalf("want %v, got %+v %v", want, value, err)
		}
	}
}

func newScheduleFixture(t *testing.T) *scheduleFixture {
	t.Helper()
	f := &scheduleFixture{s: testdb.NewDatabase(t), fresh: map[string]string{}, stale: map[string]string{}, employees: map[string]string{}}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	ids := map[string]string{"R": fixture.Root(t, f.s).ID}
	for name, roles := range map[string][]string{"H": {"hr.employee", "hr.admin"}, "L": {"hr.employee"}, "E": {"hr.employee"}, "O": {"hr.employee"}, "N": nil} {
		ids[name] = fixture.Account(t, f.s, fixture.AccountSpec{Roles: roles}).ID
		if name == "L" || name == "E" || name == "O" {
			f.employees[name] = fixture.Employee(t, f.s, fixture.EmployeeSpec{AccountID: ids[name]}).ID
		}
	}
	for name, id := range ids {
		f.fresh[name] = fixture.Session(t, f.s, id, fixture.SessionSpec{Fresh: true})
		f.stale[name] = fixture.Session(t, f.s, id, fixture.SessionSpec{})
	}
	team := f.one(t, `INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Schedule' FROM gen_random_uuid() g RETURNING id::text`)
	f.exec(t, `INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES
      (gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour'),(gen_random_uuid(),$1,$3,true,statement_timestamp()-interval '1 hour')`, team, f.employees["L"], f.employees["E"])
	f.exec(t, `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, team, f.employees["L"])
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

func (f *scheduleFixture) one(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	mustDB(t, f.conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *scheduleFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.conn.Exec(t.Context(), sql, args...)
	mustDB(t, err)
}

// day is the business date offset days after the DB's today.
func (f *scheduleFixture) day(t *testing.T, offset int) string {
	t.Helper()
	return f.one(t, `SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $1::int,'YYYY-MM-DD')`, offset)
}

func (f *scheduleFixture) weekdayFrom(t *testing.T, offset int, want func(int) bool) int {
	t.Helper()
	for ; ; offset++ {
		weekday, err := schedulecore.IsoWeekday(f.day(t, offset))
		mustDB(t, err)
		if want(weekday) {
			return offset
		}
	}
}

func (f *scheduleFixture) audits(t *testing.T, kind string) int {
	t.Helper()
	n, err := strconv.Atoi(f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')=$1`, kind))
	mustDB(t, err)
	return n
}

// makeup writes a calendar change the way a calendar command does: one new version.
func (f *scheduleFixture) makeup(t *testing.T, date string, asWeekday any) {
	t.Helper()
	kind, source := "standard", any(nil)
	if asWeekday != nil {
		kind, source = "makeup_workday", "company"
	}
	f.exec(t, `WITH c AS (UPDATE work_calendar SET version = version + 1 WHERE id = $1 RETURNING version)
      INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) SELECT c.version,CAST($2 AS date),$3,NULL,$4,$5 FROM c`,
		permission.WorkCalendarID, date, kind, asWeekday, source)
}

func (f *scheduleFixture) closeMonth(t *testing.T, month string) {
	t.Helper()
	f.exec(t, `INSERT INTO attendance_period(month,state,version,snapshot,snapshot_hash)
      VALUES(CAST($1 AS date),'closed',2,'{}'::jsonb,repeat('a',64))
      ON CONFLICT (month) DO UPDATE SET state='closed',version=2,snapshot='{}'::jsonb,snapshot_hash=repeat('a',64)`, month)
}

var (
	companyDay = schedulecore.Frame{{540, 780}, {840, 1080}}
	earlyDay   = schedulecore.Frame{{480, 720}, {780, 1020}}
)

func week(workday schedulecore.Frame) []schedulecore.Frame {
	return []schedulecore.Frame{workday, workday, workday, workday, workday, {}, {}}
}

func with(days []schedulecore.Frame, index int, frame schedulecore.Frame) []schedulecore.Frame {
	changed := append([]schedulecore.Frame(nil), days...)
	changed[index] = frame
	return changed
}

func TestWorkingHoursOnPostgreSQL(t *testing.T) {
	f := newScheduleFixture(t)

	t.Run("every HR role reads the company week in force; an account without HR role finds nothing", func(t *testing.T) {
		for _, name := range []string{"H", "L", "E", "R"} {
			view, found, err := f.service.CompanySchedule(t.Context(), f.stale[name])
			want := CompanyScheduleView{Today: f.day(t, 0), MaxMinutes: 480, Versions: []CompanyScheduleVersion{{"1900-01-01", week(companyDay)}}}
			if err != nil || !found || !reflect.DeepEqual(view, want) {
				t.Fatalf("%s: %+v %v %v", name, view, found, err)
			}
		}
		if _, found, err := f.service.CompanySchedule(t.Context(), f.stale["N"]); err != nil || found {
			t.Fatalf("N: %v %v", found, err)
		}
	})

	t.Run("only fresh HR/Admin changes the company week, from tomorrow on, and only to a valid week", func(t *testing.T) {
		tomorrow, later := f.day(t, 1), f.day(t, 30)
		put := func(secret, from string, days []schedulecore.Frame) (EffectiveResult, error) {
			return f.service.PutCompanySchedule(t.Context(), secret, CompanyScheduleInput{EffectiveFrom: from, Days: days})
		}
		audits := f.audits(t, "hr.work-schedule.update")
		for _, secret := range []string{f.stale["H"], f.fresh["L"], f.fresh["E"], f.fresh["N"], f.stale["R"]} {
			refused(t, apperror.ErrAccessDenied)(put(secret, later, week(earlyDay)))
		}
		for _, date := range []string{f.day(t, 0), f.day(t, -1)} {
			refused(t, apperror.ErrInvalidRequest)(put(f.fresh["H"], date, week(earlyDay)))
		}
		for _, frame := range []schedulecore.Frame{{{480, 1020}}, {}, {{540, 800}, {780, 1000}}, {{840, 1080}, {540, 780}}, {{541, 780}}, {{540, 780}, {780, 900}}} {
			refused(t, apperror.ErrInvalidRequest)(put(f.fresh["H"], later, week(frame)))
		}
		if f.audits(t, "hr.work-schedule.update") != audits {
			t.Fatal("a refusal was audited")
		}
		if got, err := put(f.fresh["H"], later, week(earlyDay)); err != nil || got.EffectiveFrom != later {
			t.Fatalf("%+v %v", got, err)
		}
		refused(t, errUnchanged)(put(f.fresh["H"], later, week(earlyDay)))
		if _, err := put(f.fresh["R"], later, week(companyDay)); err != nil {
			t.Fatal(err)
		}
		if _, err := put(f.fresh["H"], tomorrow, week(earlyDay)); err != nil {
			t.Fatal(err)
		}
		if f.audits(t, "hr.work-schedule.update") != audits+3 {
			t.Fatal("not three audits")
		}
		view, _, err := f.service.CompanySchedule(t.Context(), f.stale["E"])
		mustDB(t, err)
		want := []CompanyScheduleVersion{{"1900-01-01", week(companyDay)}, {tomorrow, week(earlyDay)}, {later, week(companyDay)}}
		if !reflect.DeepEqual(view.Versions, want) {
			t.Fatalf("%+v", view.Versions)
		}
		refused(t, apperror.ErrAccessDenied)(f.service.DeleteCompanySchedule(t.Context(), f.fresh["E"], later))
		refused(t, apperror.ErrInvalidRequest)(f.service.DeleteCompanySchedule(t.Context(), f.fresh["H"], "1900-01-01"))
		for _, date := range []string{later, tomorrow} {
			if got, err := f.service.DeleteCompanySchedule(t.Context(), f.fresh["H"], date); err != nil || got.EffectiveFrom != date {
				t.Fatalf("%+v %v", got, err)
			}
		}
		refused(t, errNoVersion)(f.service.DeleteCompanySchedule(t.Context(), f.fresh["H"], later))
		if f.audits(t, "hr.work-schedule.update") != audits+5 {
			t.Fatal("not five audits")
		}
		if got := f.one(t, `SELECT count(*)::text FROM work_schedule_shift`); got != "10" {
			t.Fatal(got)
		}
	})

	t.Run("employee frames: self and lead read, only fresh HR/Admin writes, frames never overlap", func(t *testing.T) {
		employee := f.employees["E"]
		from, to := f.day(t, 10), f.day(t, 40)
		add := func(secret, validFrom string, validTo *string, days []schedulecore.Frame) (IDResult, bool, error) {
			return f.service.AddEmployeeFrame(t.Context(), secret, EmployeeFrameInput{EmployeeID: employee, ValidFrom: validFrom, ValidTo: validTo, Days: days})
		}
		audits := f.audits(t, "hr.employee-schedule.update")
		for _, name := range []string{"E", "L", "H", "R"} {
			if view, found, err := f.service.EmployeeFrames(t.Context(), f.stale[name], employee); err != nil || !found || len(view.Frames) != 0 {
				t.Fatalf("%s: %+v %v %v", name, view, found, err)
			}
		}
		for _, name := range []string{"O", "N"} {
			if _, found, err := f.service.EmployeeFrames(t.Context(), f.stale[name], employee); err != nil || found {
				t.Fatalf("%s reads the frames: %v %v", name, found, err)
			}
			if _, found, err := f.service.EmployeeFrames(t.Context(), f.stale["H"], "00000000-0000-4000-8000-000000000000"); err != nil || found {
				t.Fatalf("absent employee: %v %v", found, err)
			}
		}
		for _, name := range []string{"E", "L", "O", "N"} {
			if _, found, err := add(f.fresh[name], from, &to, week(earlyDay)); err != nil || found {
				t.Fatalf("%s writes a frame: %v %v", name, found, err)
			}
		}
		if _, _, err := add(f.stale["H"], from, &to, week(earlyDay)); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Fatal(err)
		}
		if _, _, err := add(f.fresh["H"], f.day(t, 0), &to, week(earlyDay)); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Fatal(err)
		}
		if _, _, err := add(f.fresh["H"], from, &to, with(week(earlyDay), 5, schedulecore.Frame{{540, 780}})); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Fatalf("own hours on a company day off: %v", err)
		}
		if f.audits(t, "hr.employee-schedule.update") != audits {
			t.Fatal("a refusal was audited")
		}
		created, found, err := add(f.fresh["H"], from, &to, week(earlyDay))
		if err != nil || !found {
			t.Fatal(found, err)
		}
		for _, span := range [][2]string{{f.day(t, 40), ""}, {f.day(t, 2), f.day(t, 10)}, {f.day(t, 12), f.day(t, 20)}} {
			var end *string
			if span[1] != "" {
				end = &span[1]
			}
			if _, _, err := add(f.fresh["H"], span[0], end, week(earlyDay)); !errors.Is(err, errOverlap) {
				t.Fatalf("overlap %v: %v", span, err)
			}
		}
		next, _, err := add(f.fresh["H"], f.day(t, 41), nil, week(earlyDay))
		mustDB(t, err)
		view, _, err := f.service.EmployeeFrames(t.Context(), f.stale["E"], employee)
		mustDB(t, err)
		want := []FrameView{{created.ID, from, &to, week(earlyDay)}, {next.ID, f.day(t, 41), nil, week(earlyDay)}}
		if !reflect.DeepEqual(view.Frames, want) {
			t.Fatalf("%+v", view.Frames)
		}
		if got, found, err := f.service.EndEmployeeFrame(t.Context(), f.fresh["H"], FrameKey{employee, next.ID}); err != nil || !found || got.ID != next.ID {
			t.Fatal(got, found, err)
		}
		if _, _, err := f.service.EndEmployeeFrame(t.Context(), f.fresh["H"], FrameKey{f.employees["O"], created.ID}); !errors.Is(err, errNoFrame) {
			t.Fatalf("a frame of another employee: %v", err)
		}
		if _, _, err := f.service.EndEmployeeFrame(t.Context(), f.fresh["H"], FrameKey{employee, next.ID}); !errors.Is(err, errNoFrame) {
			t.Fatalf("a frame gone: %v", err)
		}
		if _, found, err := f.service.EndEmployeeFrame(t.Context(), f.fresh["E"], FrameKey{employee, created.ID}); err != nil || found {
			t.Fatal(found, err)
		}
		if view, _, err := f.service.EmployeeFrames(t.Context(), f.stale["E"], employee); err != nil || len(view.Frames) != 1 {
			t.Fatalf("%+v %v", view, err)
		}
		if f.audits(t, "hr.employee-schedule.update") != audits+3 {
			t.Fatal("not three audits")
		}
	})

	t.Run("a frame in force ends today: earlier days keep its hours, a second end is unchanged", func(t *testing.T) {
		employee, id := f.employees["O"], "00000000-0000-4000-8000-0000000000f1"
		f.exec(t, `INSERT INTO employee_schedule(id, employee_id, valid_from, valid_to) VALUES ($1, $2, CAST($3 AS date), NULL)`, id, employee, f.day(t, -20))
		f.exec(t, `INSERT INTO employee_schedule_shift(schedule_id, weekday, position, start_minute, end_minute) SELECT $1, w, 1, 480, 720 FROM generate_series(1, 5) w`, id)
		if got, found, err := f.service.EndEmployeeFrame(t.Context(), f.fresh["H"], FrameKey{employee, id}); err != nil || !found || got.ID != id {
			t.Fatal(got, found, err)
		}
		if _, _, err := f.service.EndEmployeeFrame(t.Context(), f.fresh["H"], FrameKey{employee, id}); !errors.Is(err, errUnchanged) {
			t.Fatal(err)
		}
		if got := f.one(t, `SELECT to_char(valid_to,'YYYY-MM-DD') FROM employee_schedule WHERE id = $1`, id); got != f.day(t, 0) {
			t.Fatal(got)
		}
		view, _, err := f.service.EmployeeFrames(t.Context(), f.stale["O"], employee)
		if err != nil || len(view.Frames) != 1 || view.Frames[0].ID != id {
			t.Fatalf("%+v %v", view, err)
		}
	})

	t.Run("the hours of each day: own frame over the company week, weekends off", func(t *testing.T) {
		employee := f.employees["E"]
		start := f.weekdayFrom(t, 60, func(w int) bool { return w < 6 })
		from, to := f.day(t, start), f.day(t, start+6)
		weekday, err := schedulecore.IsoWeekday(from)
		mustDB(t, err)
		days := []schedulecore.Frame{{}, {}, {}, {}, {}, {}, {}}
		days[weekday-1] = schedulecore.Frame{{600, 840}}
		if _, found, err := f.service.AddEmployeeFrame(t.Context(), f.fresh["H"], EmployeeFrameInput{EmployeeID: employee, ValidFrom: from, ValidTo: &from, Days: days}); err != nil || !found {
			t.Fatal(found, err)
		}
		view, found, err := f.service.EmployeeDays(t.Context(), f.stale["L"], ScheduleQuery{EmployeeID: employee, From: from, To: to})
		if err != nil || !found || view.EmployeeID != employee || len(view.Days) != 7 {
			t.Fatalf("%+v %v %v", view, found, err)
		}
		for _, day := range view.Days {
			w, err := schedulecore.IsoWeekday(day.Date)
			mustDB(t, err)
			want := ScheduleDay{Date: day.Date, Kind: schedulecore.DayWorkday, Shifts: companyDay}
			switch {
			case day.Date == from:
				want.Shifts = schedulecore.Frame{{600, 840}}
			case w > 5:
				want.Kind, want.Shifts = schedulecore.DayOff, schedulecore.Frame{}
			}
			if !reflect.DeepEqual(day, want) {
				t.Errorf("%+v, want %+v", day, want)
			}
		}
		for _, name := range []string{"O", "N"} {
			if _, found, err := f.service.EmployeeDays(t.Context(), f.stale[name], ScheduleQuery{EmployeeID: employee, From: from, To: to}); err != nil || found {
				t.Fatalf("%s: %v %v", name, found, err)
			}
		}
	})

	t.Run("a company change that would break a later makeup day is refused (409), nothing written", func(t *testing.T) {
		saturdayAt := f.weekdayFrom(t, 40, func(w int) bool { return w == 6 })
		saturday, effectiveFrom := f.day(t, saturdayAt), f.day(t, saturdayAt-7)
		f.makeup(t, saturday, 1)
		put := func(days []schedulecore.Frame) (EffectiveResult, error) {
			return f.service.PutCompanySchedule(t.Context(), f.fresh["H"], CompanyScheduleInput{EffectiveFrom: effectiveFrom, Days: days})
		}
		before := f.one(t, `SELECT count(*)::text FROM work_schedule`)
		refused(t, errMakeupDay)(put(with(week(companyDay), 5, schedulecore.Frame{{480, 720}})))
		refused(t, errMakeupDay)(put(with(week(companyDay), 0, schedulecore.Frame{})))
		if after := f.one(t, `SELECT count(*)::text FROM work_schedule`); after != before {
			t.Fatal(before, after)
		}
		f.makeup(t, saturday, nil)
		if _, err := put(with(week(companyDay), 5, schedulecore.Frame{{480, 720}})); err != nil {
			t.Fatal(err)
		}
		if _, err := f.service.DeleteCompanySchedule(t.Context(), f.fresh["H"], effectiveFrom); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("schedule changes are refused (409) while the month of their first changed day is closed", func(t *testing.T) {
		tomorrow := f.day(t, 1)
		running := "00000000-0000-4000-8000-0000000000f2"
		f.exec(t, `INSERT INTO employee_schedule(id, employee_id, valid_from, valid_to) VALUES ($1, $2, CAST($3 AS date), NULL)`, running, f.employees["L"], f.day(t, -5))
		later := f.day(t, 2)
		_, err := f.service.PutCompanySchedule(t.Context(), f.fresh["H"], CompanyScheduleInput{EffectiveFrom: later, Days: week(earlyDay)})
		mustDB(t, err)
		f.closeMonth(t, tomorrow[:8]+"01")
		f.closeMonth(t, later[:8]+"01")
		closed := apperror.Rejection{Code: "error.periodClosed"}
		state := func() string {
			return f.one(t, `SELECT concat_ws('|',(SELECT count(*) FROM work_schedule),(SELECT count(*) FROM employee_schedule),(SELECT count(*) FROM employee_schedule WHERE valid_to IS NULL))`)
		}
		before := state()
		refused(t, closed)(f.service.PutCompanySchedule(t.Context(), f.fresh["H"], CompanyScheduleInput{EffectiveFrom: tomorrow, Days: week(earlyDay)}))
		refused(t, closed)(f.service.DeleteCompanySchedule(t.Context(), f.fresh["H"], later))
		_, _, err = f.service.AddEmployeeFrame(t.Context(), f.fresh["H"], EmployeeFrameInput{EmployeeID: f.employees["O"], ValidFrom: tomorrow, ValidTo: &tomorrow, Days: week(earlyDay)})
		if !errors.Is(err, closed) {
			t.Fatal(err)
		}
		if _, _, err := f.service.EndEmployeeFrame(t.Context(), f.fresh["H"], FrameKey{f.employees["L"], running}); !errors.Is(err, closed) {
			t.Fatal(err)
		}
		if after := state(); after != before {
			t.Fatal(before, after)
		}
	})
}

// TestTheDataLoginReplacesSchedulesAndKeepsShiftsBounded ports the privilege and CHECK cases of
// hrm-work-schedule-upgrade: delete and insert replace a version, shifts are append-only and bounded,
// holidays may fall on any weekday, a makeup day names its weekday and hours source.
func TestTheDataLoginReplacesSchedulesAndKeepsShiftsBounded(t *testing.T) {
	s := testdb.NewDatabase(t)
	data := s.Pools[database.PurposeData]
	id := "00000000-0000-4000-8000-0000000000a1"
	_, err := data.Exec(t.Context(), `INSERT INTO work_schedule(id,effective_from) VALUES($1,'2027-01-01')`, id)
	mustDB(t, err)
	_, err = data.Exec(t.Context(), `INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,1,1,510,780),($1,6,1,480,720)`, id)
	mustDB(t, err)
	state := func(err error) string {
		if driver, ok := errors.AsType[*pgconn.PgError](err); ok {
			return driver.Code
		}
		return ""
	}
	for _, c := range []struct {
		sql, want string
		args      []any
	}{
		{`INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,2,1,541,780)`, "23514", []any{id}},
		{`INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,2,1,780,540)`, "23514", []any{id}},
		{`INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,2,1,540,1445)`, "23514", []any{id}},
		{`INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,3,4,540,780)`, "23514", []any{id}},
		{`UPDATE work_schedule_shift SET end_minute = 800`, "42501", nil},
		{`DELETE FROM work_schedule_shift WHERE schedule_id = $1`, "42501", []any{id}},
		{`INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES (12,'2026-11-21','makeup_workday',NULL,NULL,NULL)`, "23514", nil},
		{`INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES (13,'2026-11-21','makeup_workday',NULL,8,'company')`, "23514", nil},
		{`INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES (14,'2026-11-21','makeup_workday',NULL,1,'team')`, "23514", nil},
		{`INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES (15,'2026-11-21','standard',NULL,1,'company')`, "23514", nil},
		{`INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES (16,'2026-11-21','weekend',NULL,NULL,NULL)`, "23514", nil},
	} {
		if _, err := data.Exec(t.Context(), c.sql, c.args...); state(err) != c.want {
			t.Errorf("%s: %q", c.sql, state(err))
		}
	}
	for _, sql := range []string{
		`INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES (10,'2026-11-14','paid_holiday','Saturday holiday',NULL,NULL)`,
		`INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES (11,'2026-11-04','makeup_workday',NULL,3,'employee')`,
		`DELETE FROM work_schedule WHERE id = '` + id + `'`,
	} {
		_, err := data.Exec(t.Context(), sql)
		mustDB(t, err)
	}
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, conn.Close(context.WithoutCancel(t.Context()))) }()
	var left int
	mustDB(t, conn.QueryRow(t.Context(), `SELECT count(*)::int FROM work_schedule_shift WHERE schedule_id = $1`, id).Scan(&left))
	if left != 0 {
		t.Fatalf("%d shifts outlive their version", left)
	}
}
