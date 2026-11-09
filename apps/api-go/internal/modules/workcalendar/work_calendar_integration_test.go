//go:build integration

package workcalendar

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/permission"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

// calendarFixture: H = HR/Admin, C = COO, E = employee, N = signed in without HR role, R = Root. fresh holds
// sessions with a step-up 5 s ago, stale sessions without. Holidays are fixtures, not the legal calendar.
type calendarFixture struct {
	s       *testdb.Stack
	conn    *pgx.Conn
	service *Service
	fresh   map[string]string
	stale   map[string]string
}

// outcome is one command answer, so a helper can take it whole.
type outcome struct {
	result VersionResult
	err    error
}

func answered(result VersionResult, err error) outcome { return outcome{result, err} }

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func ok(t *testing.T, o outcome) VersionResult {
	t.Helper()
	mustDB(t, o.err)
	return o.result
}

func refused(t *testing.T, want error, o outcome) {
	t.Helper()
	if !errors.Is(o.err, want) {
		t.Fatalf("want %v, got %+v %v", want, o.result, o.err)
	}
}

func newCalendarFixture(t *testing.T) *calendarFixture {
	t.Helper()
	f := &calendarFixture{s: testdb.NewDatabase(t), fresh: map[string]string{}, stale: map[string]string{}}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	ids := map[string]string{"R": fixture.Root(t, f.s).ID}
	for name, roles := range map[string][]string{"H": {"hr.employee", "hr.admin"}, "C": {"hr.employee", "hr.coo"}, "E": {"hr.employee"}, "N": nil} {
		ids[name] = fixture.Account(t, f.s, fixture.AccountSpec{Roles: roles}).ID
	}
	for name, id := range ids {
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

func (f *calendarFixture) one(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	mustDB(t, f.conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}

func (f *calendarFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.conn.Exec(t.Context(), sql, args...)
	mustDB(t, err)
}

func (f *calendarFixture) version(t *testing.T) string {
	t.Helper()
	return f.one(t, `SELECT version::text FROM work_calendar WHERE id=$1`, permission.WorkCalendarID)
}

// state is the calendar version and the number of change rows: a refused change leaves both.
func (f *calendarFixture) state(t *testing.T) string {
	t.Helper()
	return f.version(t) + "|" + f.one(t, `SELECT count(*)::text FROM work_calendar_change`)
}

func (f *calendarFixture) unchangedBy(t *testing.T, refusals func()) {
	t.Helper()
	before := f.state(t)
	refusals()
	if after := f.state(t); after != before {
		t.Fatalf("refusals changed %s -> %s", before, after)
	}
}

func (f *calendarFixture) audits(t *testing.T) int {
	t.Helper()
	n, err := strconv.Atoi(f.one(t, `SELECT count(*)::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='hr.work-calendar.update'`))
	mustDB(t, err)
	return n
}

func (f *calendarFixture) closeMonth(t *testing.T, month string) {
	t.Helper()
	f.exec(t, `INSERT INTO attendance_period(month,state,version,snapshot,snapshot_hash)
      VALUES(CAST($1 AS date),'closed',2,'{}'::jsonb,repeat('a',64))
      ON CONFLICT (month) DO UPDATE SET state='closed',version=2,snapshot='{}'::jsonb,snapshot_hash=repeat('a',64)`, month)
}

func text(value string) *string { return &value }

func (f *calendarFixture) holiday(t *testing.T, secret, date string, name *string) outcome {
	t.Helper()
	return answered(f.service.SetDay(t.Context(), secret, DayInput{ExpectedVersion: f.version(t), Date: date, Holiday: name}))
}

func (f *calendarFixture) makeup(t *testing.T, secret, date string, hours *MakeupHours) outcome {
	t.Helper()
	return answered(f.service.SetDay(t.Context(), secret, DayInput{ExpectedVersion: f.version(t), Date: date, IsMakeup: true, Makeup: hours}))
}

func (f *calendarFixture) holidays(t *testing.T, secret, from, to, name string) outcome {
	t.Helper()
	return answered(f.service.SetHolidays(t.Context(), secret, HolidaysInput{ExpectedVersion: f.version(t), From: from, To: to, Name: name}))
}

func (f *calendarFixture) year(t *testing.T, year int) YearView {
	t.Helper()
	view, found, err := f.service.Year(t.Context(), f.stale["E"], year)
	mustDB(t, err)
	if !found {
		t.Fatalf("year %d not found", year)
	}
	return view
}

func plus(t *testing.T, version string, n int64) string {
	t.Helper()
	v, err := strconv.ParseInt(version, 10, 64)
	mustDB(t, err)
	return strconv.FormatInt(v+n, 10)
}

func TestTheCalendarOnPostgreSQL(t *testing.T) {
	f := newCalendarFixture(t)
	monday := &MakeupHours{AsWeekday: 1, FrameSource: "company"}

	t.Run("every HR role reads the calendar; an account without HR role finds nothing", func(t *testing.T) {
		for _, name := range []string{"H", "C", "E", "R"} {
			view, found, err := f.service.Year(t.Context(), f.stale[name], 2026)
			if err != nil || !found || !reflect.DeepEqual(view, YearView{Version: "1", Year: 2026, Holidays: []Holiday{}, MakeupDays: []MakeupDay{}}) {
				t.Fatalf("%s: %+v %v %v", name, view, found, err)
			}
		}
		if _, found, err := f.service.Year(t.Context(), f.stale["N"], 2026); err != nil || found {
			t.Fatalf("N: %v %v", found, err)
		}
	})

	t.Run("only fresh HR/Admin and fresh Root change the calendar", func(t *testing.T) {
		f.unchangedBy(t, func() {
			for _, secret := range []string{f.stale["H"], f.fresh["C"], f.fresh["E"], f.fresh["N"], f.stale["R"]} {
				refused(t, apperror.ErrAccessDenied, f.holiday(t, secret, "2026-09-01", text("Ngay le gia")))
			}
		})
		version := f.version(t)
		if got := ok(t, f.holiday(t, f.fresh["H"], "2026-09-01", text("Ngay le gia"))); got.Version != plus(t, version, 1) {
			t.Fatalf("version %+v", got)
		}
		ok(t, f.holiday(t, f.fresh["R"], "2026-09-01", nil))
	})

	t.Run("holidays are versioned and history stays", func(t *testing.T) {
		start, h := f.version(t), f.fresh["H"]
		tet := "T" + string(rune(0x1ebf)) + "t gia"
		ok(t, f.holiday(t, h, "2026-11-02", text("Ngay le gia A")))
		ok(t, f.holiday(t, h, "2026-12-31", text("Ngay le gia B")))
		ok(t, f.holiday(t, h, "2027-01-01", &tet))
		want := YearView{Version: plus(t, start, 3), Year: 2026, Holidays: []Holiday{{"2026-11-02", "Ngay le gia A"}, {"2026-12-31", "Ngay le gia B"}}, MakeupDays: []MakeupDay{}}
		if got := f.year(t, 2026); !reflect.DeepEqual(got, want) {
			t.Fatalf("%+v", got)
		}
		if got := f.year(t, 2027).Holidays; !reflect.DeepEqual(got, []Holiday{{"2027-01-01", tet}}) {
			t.Fatalf("%+v", got)
		}
		ok(t, f.holiday(t, h, "2026-11-02", text("Ngay le gia A (doi ten)")))
		ok(t, f.holiday(t, h, "2026-11-02", nil))
		view := f.year(t, 2026)
		if view.Version != plus(t, start, 5) || !reflect.DeepEqual(view.Holidays, []Holiday{{"2026-12-31", "Ngay le gia B"}}) {
			t.Fatalf("%+v", view)
		}
		if got := f.one(t, `SELECT string_agg(kind, ',' ORDER BY version) FROM work_calendar_change WHERE day = DATE '2026-11-02'`); got != "paid_holiday,paid_holiday,standard" {
			t.Fatal(got)
		}
		if got := f.one(t, `SELECT name FROM work_calendar_change WHERE day = DATE '2026-11-02' AND version <= CAST($1 AS int8) ORDER BY version DESC LIMIT 1`, plus(t, start, 1)); got != "Ngay le gia A" {
			t.Fatal(got)
		}
	})

	t.Run("makeup days are versioned like holidays and listed apart; makeup:null clears only a makeup day", func(t *testing.T) {
		start, h := f.version(t), f.fresh["H"]
		ok(t, f.makeup(t, h, "2026-06-07", &MakeupHours{AsWeekday: 3, FrameSource: "employee"}))
		ok(t, f.makeup(t, h, "2026-06-06", monday))
		ok(t, f.makeup(t, h, "2030-01-05", monday))
		view := f.year(t, 2026)
		if view.Version != plus(t, start, 3) || !reflect.DeepEqual(view.MakeupDays, []MakeupDay{{"2026-06-06", 1, "company"}, {"2026-06-07", 3, "employee"}}) {
			t.Fatalf("%+v", view)
		}
		if got := f.year(t, 2030).MakeupDays; !reflect.DeepEqual(got, []MakeupDay{{"2030-01-05", 1, "company"}}) {
			t.Fatalf("future makeup day: %+v", got)
		}
		f.unchangedBy(t, func() {
			refused(t, errUnchanged, f.makeup(t, h, "2026-06-06", monday))
			refused(t, errUnchanged, f.makeup(t, h, "2026-06-13", nil))
			// A makeup day only on a day the schedule has off, with the hours of a day it works.
			for date, weekday := range map[string]int{"2026-06-08": 1, "2026-06-13": 6} {
				refused(t, apperror.ErrInvalidRequest, f.makeup(t, h, date, &MakeupHours{AsWeekday: weekday, FrameSource: "company"}))
			}
		})
		ok(t, f.makeup(t, h, "2026-06-06", &MakeupHours{AsWeekday: 2, FrameSource: "company"}))
		ok(t, f.makeup(t, h, "2026-06-06", nil))
		if got := f.year(t, 2026).MakeupDays; !reflect.DeepEqual(got, []MakeupDay{{"2026-06-07", 3, "employee"}}) {
			t.Fatalf("%+v", got)
		}
		if got := f.one(t, `SELECT string_agg(kind||':'||coalesce(name,'-')||':'||coalesce(as_weekday::text,'-'), ',' ORDER BY version) FROM work_calendar_change WHERE day = DATE '2026-06-06'`); got != "makeup_workday:-:1,makeup_workday:-:2,standard:-:-" {
			t.Fatal(got)
		}
		for _, secret := range []string{f.stale["H"], f.fresh["C"], f.fresh["E"]} {
			refused(t, apperror.ErrAccessDenied, f.makeup(t, secret, "2026-06-13", monday))
		}
		audits := f.audits(t)
		ok(t, f.makeup(t, h, "2026-06-13", monday))
		if f.audits(t) != audits+1 {
			t.Fatal("no audit")
		}
	})

	t.Run("holiday:null never clears a makeup day, makeup:null never a holiday", func(t *testing.T) {
		h := f.fresh["H"]
		ok(t, f.holiday(t, h, "2026-06-17", text("Ngay le gia D")))
		ok(t, f.makeup(t, h, "2026-06-20", monday))
		f.unchangedBy(t, func() {
			refused(t, errUnchanged, f.makeup(t, h, "2026-06-17", nil))
			refused(t, errUnchanged, f.holiday(t, h, "2026-06-20", nil))
		})
		ok(t, f.holiday(t, h, "2026-06-17", nil))
		ok(t, f.makeup(t, h, "2026-06-20", nil))
	})

	t.Run("no-op changes and stale versions are refused without a new version", func(t *testing.T) {
		h := f.fresh["H"]
		ok(t, f.holiday(t, h, "2026-10-01", text("Ngay le gia C")))
		f.unchangedBy(t, func() {
			refused(t, errUnchanged, f.holiday(t, h, "2026-10-01", text("Ngay le gia C")))
			refused(t, errUnchanged, f.holiday(t, h, "2026-10-02", nil))
			refused(t, errStaleVersion, answered(f.service.SetDay(t.Context(), h, DayInput{ExpectedVersion: "1", Date: "2026-10-05", Holiday: text("x")})))
		})
	})

	t.Run("two concurrent changes on the same version: exactly one commits", func(t *testing.T) {
		expected := f.version(t)
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i, date := range []string{"2026-08-03", "2026-08-04"} {
			wg.Go(func() {
				_, errs[i] = f.service.SetDay(context.WithoutCancel(t.Context()), f.fresh["H"], DayInput{ExpectedVersion: expected, Date: date, Holiday: text("Dong thoi")})
			})
		}
		wg.Wait()
		if (errs[0] == nil) == (errs[1] == nil) || (!errors.Is(errs[0], errStaleVersion) && !errors.Is(errs[1], errStaleVersion)) {
			t.Fatalf("%v / %v", errs[0], errs[1])
		}
		if f.version(t) != plus(t, expected, 1) {
			t.Fatal("not one version")
		}
	})

	t.Run("each change is audited by id only and rolls back with a failing audit writer", func(t *testing.T) {
		h, audits := f.fresh["H"], f.audits(t)
		ok(t, f.holiday(t, h, "2026-07-01", text("Ngay le gia E")))
		if f.audits(t) != audits+1 {
			t.Fatal("no audit")
		}
		metadata := f.one(t, `SELECT safe_metadata::text FROM audit_outbox WHERE convert_from(event_kind,'UTF8')='hr.work-calendar.update' ORDER BY occurred_at DESC LIMIT 1`)
		for _, value := range []string{"2026-07-01", "Ngay le gia E"} {
			if strings.Contains(metadata, value) {
				t.Fatalf("audit metadata carries %q", value)
			}
		}
		f.unchangedBy(t, func() {
			f.exec(t, `REVOKE INSERT ON audit_outbox FROM product_data`)
			o := f.holiday(t, h, "2026-07-02", text("Ngay le gia F"))
			f.exec(t, `GRANT INSERT ON audit_outbox TO product_data`)
			if o.err == nil || errors.Is(o.err, apperror.ErrAccessDenied) {
				t.Fatalf("%+v %v", o.result, o.err)
			}
		})
	})

	t.Run("history is append-only for the runtime; a makeup row names its weekday and hours source", func(t *testing.T) {
		data := f.s.Pools[database.PurposeData]
		for _, sql := range []string{`UPDATE work_calendar_change SET name = 'x'`, `DELETE FROM work_calendar_change`, `UPDATE work_calendar SET id = id`} {
			if _, err := data.Exec(t.Context(), sql); sqlState(err) != "42501" {
				t.Errorf("%s: %v", sql, err)
			}
		}
		for _, values := range []string{
			`(999999, DATE '2026-11-07','makeup_workday',NULL,NULL,NULL)`,
			`(999998, DATE '2026-11-09','standard','x',NULL,NULL)`,
			`(999997, DATE '2026-11-07','makeup_workday','x',1,'company')`,
			`(999996, DATE '2026-11-07','makeup_workday',NULL,1,NULL)`,
			`(999995, DATE '2026-11-07','workday',NULL,NULL,NULL)`,
			`(999994, DATE '2101-01-01','standard',NULL,NULL,NULL)`,
			`(999993, DATE '2026-11-09','paid_holiday','x',1,'company')`,
		} {
			_, err := f.conn.Exec(t.Context(), `INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source) VALUES `+values)
			if sqlState(err) != "23514" {
				t.Errorf("%s: %s", values, sqlState(err))
			}
		}
	})

	t.Run("a holiday range is one transaction and one audit, one version per weekday, weekends skipped", func(t *testing.T) {
		start, audits := f.version(t), f.audits(t)
		name := "Nghi le gia khoang"
		if got := ok(t, f.holidays(t, f.fresh["H"], "2028-12-28", "2029-01-02", name)); got.Version != plus(t, start, 4) {
			t.Fatalf("%+v", got)
		}
		if f.audits(t) != audits+1 {
			t.Fatal("not one audit")
		}
		if got := f.year(t, 2028).Holidays; !reflect.DeepEqual(got, []Holiday{{"2028-12-28", name}, {"2028-12-29", name}}) {
			t.Fatalf("%+v", got)
		}
		if got := f.year(t, 2029).Holidays; !reflect.DeepEqual(got, []Holiday{{"2029-01-01", name}, {"2029-01-02", name}}) {
			t.Fatalf("%+v", got)
		}
		got := f.one(t, `SELECT string_agg((version - CAST($1 AS int8))::text||'@'||to_char(day,'YYYY-MM-DD'), ',' ORDER BY version) FROM work_calendar_change WHERE version > CAST($1 AS int8)`, start)
		if got != "1@2028-12-28,2@2028-12-29,3@2029-01-01,4@2029-01-02" {
			t.Fatal(got)
		}
	})

	t.Run("overlapping ranges write only the days that change; all unchanged, stale or weekend-only is refused", func(t *testing.T) {
		h := f.fresh["H"]
		ok(t, f.holidays(t, h, "2029-03-05", "2029-03-06", "Nghi khoang G"))
		start := f.version(t)
		if got := ok(t, f.holidays(t, h, "2029-03-06", "2029-03-07", "Nghi khoang G")); got.Version != plus(t, start, 1) {
			t.Fatalf("%+v", got)
		}
		f.unchangedBy(t, func() {
			refused(t, errUnchanged, f.holidays(t, h, "2029-03-05", "2029-03-07", "Nghi khoang G"))
			refused(t, errUnchanged, f.holidays(t, h, "2029-03-10", "2029-03-11", "Nghi khoang G"))
			refused(t, errStaleVersion, answered(f.service.SetHolidays(t.Context(), h, HolidaysInput{ExpectedVersion: "1", From: "2029-03-12", To: "2029-03-13", Name: "Nghi khoang H"})))
		})
	})

	t.Run("renaming a range rewrites every day: two days renamed make two versions", func(t *testing.T) {
		h := f.fresh["H"]
		ok(t, f.holidays(t, h, "2029-06-04", "2029-06-05", "Ten X"))
		start := f.version(t)
		if got := ok(t, f.holidays(t, h, "2029-06-04", "2029-06-05", "Ten Y")); got.Version != plus(t, start, 2) {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("a change waiting behind a close of its month sees the close: the period is checked under its lock", func(t *testing.T) {
		f.exec(t, `INSERT INTO attendance_period(month) VALUES (DATE '2026-08-01') ON CONFLICT DO NOTHING`)
		closing, err := f.conn.Begin(t.Context())
		mustDB(t, err)
		_, err = closing.Exec(t.Context(), `UPDATE attendance_period SET state='closed',version=2,snapshot='{}'::jsonb,snapshot_hash=repeat('a',64) WHERE month = DATE '2026-08-01'`)
		mustDB(t, err)
		before, done := f.version(t), make(chan outcome, 1)
		go func() {
			done <- answered(f.service.SetDay(context.WithoutCancel(t.Context()), f.fresh["H"], DayInput{ExpectedVersion: before, Date: "2026-08-20", Holiday: text("Sau khi chot")}))
		}()
		select {
		case o := <-done:
			t.Fatalf("the change did not wait for the close: %+v %v", o.result, o.err)
		case <-time.After(300 * time.Millisecond):
		}
		mustDB(t, closing.Commit(t.Context()))
		refused(t, apperror.Rejection{Code: "error.periodClosed"}, <-done)
		if f.version(t) != before {
			t.Fatal("a change in a closed month was written")
		}
	})

	t.Run("a closed month refuses a day, a makeup day and a whole range (409)", func(t *testing.T) {
		f.closeMonth(t, "2026-02-01")
		f.closeMonth(t, "2026-05-01")
		closed := apperror.Rejection{Code: "error.periodClosed"}
		f.unchangedBy(t, func() {
			for _, secret := range []string{f.stale["H"], f.fresh["C"], f.fresh["E"], f.fresh["N"], f.stale["R"]} {
				refused(t, apperror.ErrAccessDenied, f.holidays(t, secret, "2029-04-02", "2029-04-03", "Nghi khoang I"))
			}
			refused(t, closed, f.holidays(t, f.fresh["H"], "2026-02-26", "2026-03-03", "Nghi khoang J"))
			refused(t, closed, f.holidays(t, f.fresh["H"], "2026-04-29", "2026-05-04", "Nghi khoang K"))
			refused(t, closed, f.holiday(t, f.fresh["H"], "2026-02-10", text("Ngay le thang dong")))
			refused(t, closed, f.makeup(t, f.fresh["H"], "2026-05-02", monday))
		})
		if got := f.one(t, `SELECT count(*)::text FROM attendance_period WHERE month IN ('2026-02-01','2026-05-01') AND state='closed'`); got != "2" {
			t.Fatal(got)
		}
	})
}

func sqlState(err error) string {
	if driver, ok := errors.AsType[*pgconn.PgError](err); ok {
		return driver.Code
	}
	return ""
}
