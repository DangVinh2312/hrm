//go:build integration

package schedulecore_test

import (
	"context"
	"reflect"
	"testing"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/internal/modules/schedulecore"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func TestEmployeeScheduleReadsTheCalendarAtItsVersionCompanyVersionsAndFrames(t *testing.T) {
	s := testdb.NewDatabase(t)
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, conn.Close(context.WithoutCancel(t.Context()))) })
	exec := func(sql string, args ...any) string {
		t.Helper()
		var id string
		mustDB(t, conn.QueryRow(t.Context(), sql+" RETURNING CAST(1 AS text)", args...).Scan(&id))
		return id
	}
	insertID := func(sql string, args ...any) string {
		t.Helper()
		var id string
		mustDB(t, conn.QueryRow(t.Context(), sql+" RETURNING id::text", args...).Scan(&id))
		return id
	}
	change := func(day, kind string, asWeekday, frameSource any) {
		var name any
		if kind == "paid_holiday" {
			name = "Holiday " + day
		}
		exec(`WITH c AS (UPDATE work_calendar SET version = version + 1 WHERE id = $1 RETURNING version)
      INSERT INTO work_calendar_change(version,day,kind,name,as_weekday,frame_source)
      SELECT c.version,CAST($2 AS date),$3,$4,$5,$6 FROM c`, permission.WorkCalendarID, day, kind, name, asWeekday, frameSource)
	}
	employee := fixture.Employee(t, s, fixture.EmployeeSpec{}).ID
	other := fixture.Employee(t, s, fixture.EmployeeSpec{}).ID

	change("2026-03-12", "paid_holiday", nil, nil)        // v2
	change("2026-03-14", "makeup_workday", 1, "employee") // v3
	change("2026-03-12", "standard", nil, nil)            // v4
	change("2026-03-19", "paid_holiday", nil, nil)        // v5
	change("2026-03-28", "paid_holiday", nil, nil)        // v6, outside the dates read
	company := insertID("INSERT INTO work_schedule(id,effective_from) VALUES(gen_random_uuid(),'2026-03-16')")
	exec("INSERT INTO work_schedule_shift(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,1,1,480,720),($1,4,1,480,1020)", company)
	insertID("INSERT INTO work_schedule(id,effective_from) VALUES(gen_random_uuid(),'2026-04-01')")
	frames := insertID("INSERT INTO employee_schedule(id,employee_id,valid_from,valid_to) VALUES(gen_random_uuid(),$1,'2026-03-02','2026-03-14')", employee)
	exec("INSERT INTO employee_schedule_shift(schedule_id,weekday,position,start_minute,end_minute) VALUES($1,1,1,600,900),($1,1,2,960,1080)", frames)
	insertID("INSERT INTO employee_schedule(id,employee_id,valid_from,valid_to) VALUES(gen_random_uuid(),$1,'2026-03-23',NULL)", employee)
	insertID("INSERT INTO employee_schedule(id,employee_id,valid_from) VALUES(gen_random_uuid(),$1,'2026-03-01')", other)

	dates := []string{"2026-03-20", "2026-03-09", "2026-03-12", "2026-03-14", "2026-03-16", "2026-03-19"}
	read := func(version string) schedulecore.ScheduleFacts {
		t.Helper()
		facts, err := database.Run(t.Context(), s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (schedulecore.ScheduleFacts, error) {
			return schedulecore.EmployeeSchedule(tx, employee, dates, version)
		}, database.RunOptions{})
		mustDB(t, err)
		return facts
	}
	frameOn := func(facts schedulecore.ScheduleFacts, date string) schedulecore.DaySchedule {
		t.Helper()
		day, err := schedulecore.FrameOn(date, facts)
		mustDB(t, err)
		return day
	}

	v3 := read("3")
	if len(v3.Versions) != 2 || v3.Versions[0].EffectiveFrom != "1900-01-01" || v3.Versions[1].EffectiveFrom != "2026-03-16" {
		t.Fatalf("company versions %+v", v3.Versions)
	}
	if len(v3.Overrides) != 1 || v3.Overrides[0].ValidFrom != "2026-03-02" || *v3.Overrides[0].ValidTo != "2026-03-14" {
		t.Fatalf("own frames %+v", v3.Overrides)
	}
	if !reflect.DeepEqual(v3.PaidHolidays, map[string]bool{"2026-03-12": true}) ||
		!reflect.DeepEqual(v3.MakeupDays, map[string]schedulecore.MakeupDay{"2026-03-14": {AsWeekday: 1, FrameSource: schedulecore.FrameSourceEmployee}}) {
		t.Fatalf("calendar at v3: %v %v", v3.PaidHolidays, v3.MakeupDays)
	}
	for date, want := range map[string]schedulecore.DaySchedule{
		"2026-03-09": {Kind: schedulecore.DayWorkday, Frame: schedulecore.Frame{{600, 900}, {960, 1080}}},
		"2026-03-12": {Kind: schedulecore.DayPaidHoliday, Frame: schedulecore.Frame{{540, 780}, {840, 1080}}},
		"2026-03-14": {Kind: schedulecore.DayMakeupWorkday, Frame: schedulecore.Frame{{600, 900}, {960, 1080}}},
		"2026-03-16": {Kind: schedulecore.DayWorkday, Frame: schedulecore.Frame{{480, 720}}},
		"2026-03-17": {Kind: schedulecore.DayOff, Frame: schedulecore.Frame{}},
		"2026-03-19": {Kind: schedulecore.DayWorkday, Frame: schedulecore.Frame{{480, 1020}}},
	} {
		if got := frameOn(v3, date); !reflect.DeepEqual(got, want) {
			t.Errorf("v3 %s: %+v, want %+v", date, got, want)
		}
	}

	v5 := read("5")
	if !reflect.DeepEqual(v5.PaidHolidays, map[string]bool{"2026-03-19": true}) || len(v5.MakeupDays) != 1 {
		t.Fatalf("calendar at v5 (03-12 reverted, 03-28 outside the dates): %v %v", v5.PaidHolidays, v5.MakeupDays)
	}
	if got := frameOn(v5, "2026-03-12"); got.Kind != schedulecore.DayWorkday {
		t.Fatalf("a reverted holiday at v5: %+v", got)
	}
	if v1 := read("1"); len(v1.PaidHolidays) != 0 || len(v1.MakeupDays) != 0 {
		t.Fatalf("calendar at v1: %v %v", v1.PaidHolidays, v1.MakeupDays)
	}
}
