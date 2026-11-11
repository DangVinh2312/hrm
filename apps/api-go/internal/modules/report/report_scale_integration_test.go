//go:build integration && reportscale

package report_test

import (
	"context"
	"fmt"
	"reflect"
	"strconv"
	"testing"

	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/report"
	"hrm/api-go/test/fixture/attendanceoracle"
)

func TestThousandsOfEmployeesStillMatchTheCorrelatedFactsReportAndSnapshot(t *testing.T) {
	f := newReportFixture(t)
	equivalenceDataset(f)
	f.closeMonth("2026-03")
	const bulk = 2100
	f.exec(`INSERT INTO employee(id,object_id,code,full_name,hired_on)
      SELECT id,public.hr_register_object('employee',id),'B'||lpad(g::text,6,'0'),'Bulk fixture '||g,DATE '2025-01-06'
      FROM (SELECT g,('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid id FROM generate_series(1,$1::int) g) x`, bulk)
	f.exec(`WITH requests AS (
      SELECT g,k.slot,k.kind,('00000000-0000-4000-a000-'||lpad((g*10+k.slot)::text,12,'0'))::uuid id
      FROM generate_series(1,$1::int) g,
      (VALUES(1,'annual-leave'),(2,'unpaid-leave'),(3,'wfh'),(4,'late-arrival'),(5,'early-departure')) k(slot,kind))
      INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
      SELECT r.id,public.hr_register_object('workRequest',r.id),
      ('00000000-0000-4000-8000-'||lpad(r.g::text,12,'0'))::uuid,$2,$3,r.kind,'approved','Bulk request' FROM requests r`, bulk, f.accounts["root"], f.team)
	f.exec(`WITH requests AS (
      SELECT g,k.slot,k.kind,('00000000-0000-4000-a000-'||lpad((g*10+k.slot)::text,12,'0'))::uuid id
      FROM generate_series(1,$1::int) g,
      (VALUES(1,'annual-leave'),(2,'unpaid-leave'),(3,'wfh'),(4,'late-arrival'),(5,'early-departure')) k(slot,kind))
      INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
      SELECT r.id,r.kind,d.day,d.s,d.e,d.m FROM requests r
      JOIN (VALUES(1,DATE '2026-03-04',540,1080,480),(2,DATE '2026-03-10',540,1080,480),
      (3,DATE '2026-03-11',540,1080,480),(3,DATE '2026-03-12',540,1080,480),
      (4,DATE '2026-03-17',540,600,60),(5,DATE '2026-03-18',1020,1080,60)) d(slot,day,s,e,m) ON d.slot=r.slot`, bulk)
	f.exec(`INSERT INTO attendance_adjustment(id,employee_id,work_date,minutes,reason,actor_account_id)
      SELECT gen_random_uuid(),('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,DATE '2026-03-10',
      CASE WHEN g%3=0 THEN -30 ELSE 45 END,'Bulk adjustment',$2 FROM generate_series(1,$1::int) g WHERE g%2=0`, bulk, f.accounts["H"])
	f.exec("ANALYZE")
	idsOf := func(n int) []string {
		ids := make([]string, n)
		for i := range ids {
			ids[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
		}
		return ids
	}
	for _, month := range []string{"2026-03", "2026-04"} {
		for _, ids := range [][]string{nil, idsOf(attendancecore.EffectsSetBasedMinRows + 50), idsOf(attendancecore.EffectsSetBasedMinRows - 1)} {
			fast, err := database.Run(t.Context(), f.s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) ([]attendancecore.FactsRow, error) {
				if ids == nil {
					return attendancecore.LoadAllFacts(tx, month)
				}
				return attendancecore.LoadFacts(tx, month, ids)
			}, database.RunOptions{})
			mustDB(t, err)
			slow, err := database.Run(t.Context(), f.s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) ([]attendancecore.FactsRow, error) {
				return attendanceoracle.LoadFacts(tx, month, ids)
			}, database.RunOptions{})
			mustDB(t, err)
			if !reflect.DeepEqual(fast, slow) {
				t.Fatalf("%s facts differ for ids=%d (all=%v)", month, len(ids), ids == nil)
			}
		}
	}
	for _, q := range []report.Query{
		monthly(report.KindAttendance, "2026-04", "2026-04", 5000, 0),
		monthly(report.KindAttendance, "2026-03", "2026-04", 5000, 0),
		monthly(report.KindAttendance, "2026-04", "2026-04", 700, 1500),
		monthly(report.KindAttendance, "2026-04", "2026-04", 50, 0),
	} {
		f.compare(t, "H", q)
		page := attendanceOf(t, f.report("H", q))
		wantTotal := bulk + len(f.employees) - 1
		if q.From == "2026-03" {
			wantTotal += len(f.employees)
		}
		wantRows := min(q.Limit, wantTotal-q.Offset)
		if page.Total != strconv.Itoa(wantTotal) || len(page.Rows) != wantRows {
			t.Fatalf("%s..%s limit %d offset %d: total %s rows %d, want total %d rows %d", q.From, q.To, q.Limit, q.Offset, page.Total, len(page.Rows), wantTotal, wantRows)
		}
	}
	want := f.oracleSnapshot("2026-04")
	if len(want.Employees) < bulk {
		t.Fatal("the scale fixture has fewer than 2100 employees")
	}
	f.closeMonth("2026-04")
	got, hash := f.storedSnapshot("2026-04")
	wantHash, err := attendancecore.SnapshotHash(want)
	mustDB(t, err)
	if !reflect.DeepEqual(got, want) || hash != wantHash {
		t.Fatal("the large close differs from the correlated snapshot")
	}
}
