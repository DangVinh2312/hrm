//go:build integration

package attendancecore_test

import (
	"errors"
	"fmt"
	"reflect"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/test/fixture"
)

var months = []string{"2026-02", "2026-03", "2026-04", "2026-05"}

// people is the mixed dataset of the TypeScript equivalence spec: every request state, overlaps, a tie,
// WFH across a month edge, hire and leaving inside the month, calendar versions, signed adjustments, a
// closed month, company versions and employee frames, plus bulk employees past the set-based threshold.
func people(f *hr) (map[string]string, []string) {
	named := map[string]string{}
	for _, name := range []string{"A1", "A2", "A3", "A4", "A5", "B1", "B2", "IDLE"} {
		named[name] = f.employee("2026-01-05", nil)
	}
	named["NEW"] = f.employee("2026-03-16", nil)
	named["GONE"] = f.employee("2025-01-06", "2026-03-20")
	named["OLD"] = f.employee("2024-01-02", "2026-01-30")
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
		f.request(named[r.who], r.kind, r.state, r.dates, r.slot[0], r.slot[1])
	}
	f.adjustment(named["A1"], "2026-03-10", 120)
	f.adjustment(named["A1"], "2026-03-11", -60)
	f.adjustment(named["A1"], "2026-04-03", 30)
	f.adjustment(named["A3"], "2026-03-09", -30)
	f.adjustment(named["B1"], "2026-03-25", 45)
	f.adjustment(named["NEW"], "2026-03-18", 15)
	f.adjustment(named["A5"], "2026-02-27", -15)
	f.calendar("2026-03-12", "paid_holiday", nil, nil)
	f.calendar("2026-03-19", "paid_holiday", nil, nil)
	f.calendar("2026-03-12", "standard", nil, nil)
	f.calendar("2026-03-14", "makeup_workday", 1, "company")
	f.calendar("2026-04-30", "paid_holiday", nil, nil)
	f.calendar("2026-05-09", "makeup_workday", 2, "employee")
	f.companyVersion("2026-04-13", [][3]int{{1, 480, 720}, {1, 780, 1020}, {2, 480, 1020}, {3, 480, 1020}, {4, 480, 1020}, {5, 480, 960}})
	f.employeeFrames(named["A2"], "2026-03-09", "2026-04-20", [][3]int{{1, 600, 900}, {3, 480, 720}})
	f.employeeFrames(named["B2"], "2026-05-01", nil, [][3]int{{2, 420, 840}})
	f.closeMonth("2026-02-01")

	f.exec(`INSERT INTO employee(id,object_id,code,full_name,hired_on,terminated_on)
      SELECT g.id,public.hr_register_object('employee',g.id),'BULK-'||g.n,'Bulk '||g.n,DATE '2025-06-02'+(g.n % 90),
             CASE WHEN g.n % 7 = 0 THEN DATE '2026-02-01'+(g.n % 90) END
        FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1,300) n) g`)
	rows, err := f.conn.Query(f.t.Context(), "SELECT id::text FROM employee WHERE code LIKE 'BULK-%' ORDER BY code")
	mustDB(f.t, err)
	bulk, err := pgx.CollectRows(rows, pgx.RowTo[string])
	mustDB(f.t, err)
	for i, id := range bulk[:40] {
		day := fmt.Sprintf("2026-03-%02d", 2+i%20)
		f.request(id, []string{"wfh", "annual-leave", "unpaid-leave", "late-arrival"}[i%4], []string{"approved", "pending_lead", "approved", "cancelled", "approved"}[i%5],
			[]string{day}, 540, []int{1080, 1080, 1080, 600}[i%4])
		if i%3 == 0 {
			f.adjustment(id, day, 10+i)
		}
	}
	f.employeeFrames(bulk[1], "2026-02-16", "2026-03-15", [][3]int{{1, 480, 720}})
	return named, bulk
}

func firstDifference(got, want []attendancecore.FactsRow) string {
	for i := range min(len(got), len(want)) {
		if !reflect.DeepEqual(got[i], want[i]) {
			return fmt.Sprintf("row %d\n got %+v\nwant %+v", i, got[i], want[i])
		}
	}
	return fmt.Sprintf("%d rows, want %d", len(got), len(want))
}

// readFacts reads exactly ids, or with all every employee of month (LoadAllFacts; the oracle's nil).
func readFacts(t *testing.T, f *hr, month string, ids []string, all bool) (got, oracle []attendancecore.FactsRow) {
	t.Helper()
	_, err := inMode(t, f.s, database.ModeRead, func(tx *database.Tx) (struct{}, error) {
		var err error
		if all {
			got, err = attendancecore.LoadAllFacts(tx, month)
		} else {
			got, err = attendancecore.LoadFacts(tx, month, ids)
		}
		if err != nil {
			return struct{}{}, err
		}
		if !all {
			ids = append([]string{}, ids...)
		}
		oracle, err = fixture.OracleLoadFacts(tx, month, ids)
		return struct{}{}, err
	})
	mustDB(t, err)
	return got, oracle
}

func TestLoadFactsEqualsTheCorrelatedOracleSetBasedAndPerRow(t *testing.T) {
	f := newHR(t)
	named, bulk := people(f)
	var everyone []string
	for _, id := range named {
		everyone = append(everyone, id)
	}
	slices.Sort(everyone)
	reversed := slices.Clone(everyone)
	slices.Reverse(reversed)
	all := append(slices.Clone(bulk), everyone...)
	slices.Reverse(all)
	if len(all) < attendancecore.EffectsSetBasedMinRows {
		t.Fatalf("%d ids do not reach the set-based reader", len(all))
	}
	sets := map[string][]string{
		"all": nil, "nil": nil, "empty": {}, "one": {named["A1"]}, "idle": {named["IDLE"]},
		"mixed":   {named["A2"], named["NEW"], named["GONE"], named["B1"]},
		"named":   reversed,
		"unknown": {"10000000-0000-4000-8000-0000000000aa"}, "set-based": all,
	}
	nonEmpty := 0
	for _, month := range months {
		for label, ids := range sets {
			got, oracle := readFacts(t, f, month, ids, label == "all")
			if !reflect.DeepEqual(got, oracle) {
				t.Fatalf("facts %s ids=%s differ from the oracle: %s", month, label, firstDifference(got, oracle))
			}
			if (label == "nil" || label == "empty") && (got == nil || len(got) != 0) {
				t.Fatalf("facts %s ids=%s read %d employees, want none", month, label, len(got))
			}
			for _, row := range got {
				if len(row.Effects) > 0 {
					nonEmpty++
				}
				if _, err := attendancecore.TotalsOf(month, row); err != nil {
					t.Fatalf("totals %s %s: %v", month, row.ID, err)
				}
			}
		}
		perRow, _ := readFacts(t, f, month, everyone, false)
		setBased, _ := readFacts(t, f, month, all, false)
		setBased = slices.DeleteFunc(setBased, func(row attendancecore.FactsRow) bool { return !slices.Contains(everyone, row.ID) })
		if !reflect.DeepEqual(perRow, setBased) {
			t.Fatalf("%s: the set-based rows of the named employees differ from the per-row ones", month)
		}
	}
	if nonEmpty == 0 {
		t.Fatal("the dataset has no effect at all")
	}

	// Over a window of several months, every employee-month group is the correlated fragment, text-identical.
	source := `SELECT e.id, m.first, CAST(m.next AS date) AS next FROM employee e,
      (VALUES (DATE '2026-02-01', DATE '2026-03-01'), (DATE '2026-03-01', DATE '2026-04-01'),
              (DATE '2026-04-01', DATE '2026-05-01'), (DATE '2026-05-01', DATE '2026-06-01')) m(first, next)`
	window := attendancecore.MonthsWindow{First: "DATE '2026-02-01'", Next: "DATE '2026-06-01'"}
	texts := func(sql string) []string {
		rows, err := f.conn.Query(t.Context(), sql)
		mustDB(t, err)
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		mustDB(t, err)
		return found
	}
	fast := texts(`WITH k AS (` + source + `), fx AS (` + attendancecore.ApprovedEffectsBySQL("(SELECT DISTINCT id FROM k)", window) + `)
      SELECT k.id::text || k.first::text || COALESCE(fx.effects, '[]'::json)::text
        FROM k LEFT JOIN fx ON fx.id = k.id AND fx.first = k.first ORDER BY k.id, k.first`)
	slow := texts(`WITH k AS (` + source + `)
      SELECT k.id::text || k.first::text || ` + fixture.OracleApprovedEffectsSQL("k.id", "k.first", "k.next") + `::text FROM k ORDER BY k.id, k.first`)
	if len(slow) != len(all)*len(months) || !slices.Equal(fast, slow) {
		t.Fatalf("multi-month window: %d groups, %d correlated", len(fast), len(slow))
	}
	one := texts(`WITH k AS (SELECT CAST('` + named["A1"] + `' AS uuid) AS id), fx AS (` + attendancecore.ApprovedEffectsBySQL("k", window) + `)
      SELECT count(DISTINCT id)::text FROM fx`)
	if !slices.Equal(one, []string{"1"}) {
		t.Fatalf("the reader read %v employees for one", one)
	}
}

func TestOnlyApprovedRequestsAreEffects(t *testing.T) {
	f := newHR(t)
	named, _ := people(f)
	for _, ids := range [][]string{{named["A1"]}, nil} {
		got, _ := readFacts(t, f, "2026-03", ids, ids == nil)
		index := slices.IndexFunc(got, func(row attendancecore.FactsRow) bool { return row.ID == named["A1"] })
		if index < 0 {
			t.Fatal("A1 is missing")
		}
		var effects []string
		for _, e := range got[index].Effects {
			effects = append(effects, e.Date+" "+string(e.Kind))
		}
		want := []string{"2026-03-04 annual-leave", "2026-03-05 annual-leave", "2026-03-05 unpaid-leave",
			"2026-03-10 late-arrival", "2026-03-12 early-departure", "2026-03-31 wfh"}
		if !slices.Equal(effects, want) || got[index].AdjustmentMinutes != 60 {
			t.Fatalf("ids=%v: %v, adjustments %d", ids != nil, effects, got[index].AdjustmentMinutes)
		}
		if got[index].PeriodState != nil || got[index].CalendarVersion != "7" {
			t.Fatalf("period %v calendar %s", got[index].PeriodState, got[index].CalendarVersion)
		}
	}
	got, _ := readFacts(t, f, "2026-03", []string{named["IDLE"]}, false)
	if len(got) != 1 || len(got[0].Effects) != 0 || got[0].AdjustmentMinutes != 0 || got[0].Effects == nil {
		t.Fatalf("IDLE: %+v", got)
	}
	february, _ := readFacts(t, f, "2026-02", nil, true)
	if len(february) == 0 || february[0].PeriodState == nil || *february[0].PeriodState != attendancecore.PeriodClosed {
		t.Fatalf("closed February: %+v", february)
	}
	if slices.ContainsFunc(february, func(row attendancecore.FactsRow) bool { return row.ID == named["OLD"] || row.ID == named["NEW"] }) {
		t.Fatal("employment outside February is listed")
	}
	if _, err := inMode(t, f.s, database.ModeRead, func(tx *database.Tx) ([]attendancecore.FactsRow, error) {
		return attendancecore.LoadFacts(tx, "2026-13", []string{named["A1"]})
	}); !errors.Is(err, attendancecore.ErrInvalidMonth) {
		t.Fatalf("invalid month: %v", err)
	}
	if _, err := inMode(t, f.s, database.ModeRead, func(tx *database.Tx) ([]attendancecore.FactsRow, error) {
		return attendancecore.LoadAllFacts(tx, "2026-13")
	}); !errors.Is(err, attendancecore.ErrInvalidMonth) {
		t.Fatalf("invalid month, every employee: %v", err)
	}
}

func periodsOpen(t *testing.T, f *hr, dates ...string) error {
	return write(t, f.s, func(tx *database.Tx) error { return attendancecore.AssertPeriodsOpen(tx, dates) })
}

func TestAssertPeriodsOpenUpsertsRefusesAClosedMonthAndLocksForShare(t *testing.T) {
	f := newHR(t)
	mustDB(t, periodsOpen(t, f, "2026-04-02", "2026-03-15", "2026-03-01"))
	if n := f.count("SELECT count(*)::int FROM attendance_period WHERE state = 'open' AND month IN ('2026-03-01','2026-04-01')"); n != 2 {
		t.Fatalf("%d open periods upserted", n)
	}
	f.closeMonth("2026-04-01")
	err := periodsOpen(t, f, "2026-03-10", "2026-04-10")
	if rejection, ok := errors.AsType[apperror.Rejection](err); !ok || rejection.Code != "error.periodClosed" {
		t.Fatalf("closed April: %v", err)
	}
	if status, code, known := apperror.Response(err); status != 409 || code != "error.periodClosed" || !known {
		t.Fatalf("answers %d %s %v", status, code, known)
	}
	mustDB(t, periodsOpen(t, f, "2026-03-31"))

	// While the runner holds March FOR SHARE, an exclusive lock cannot be taken (a close waits for it).
	mustDB(t, write(t, f.s, func(tx *database.Tx) error {
		if err := attendancecore.AssertPeriodsOpen(tx, []string{"2026-03-20"}); err != nil {
			return err
		}
		probe, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
		if err != nil {
			return err
		}
		defer func() { mustDB(t, probe.Close(t.Context())) }()
		_, err = probe.Exec(t.Context(), "SELECT 1 FROM attendance_period WHERE month = '2026-03-01' FOR UPDATE NOWAIT")
		if driver, ok := errors.AsType[*pgconn.PgError](err); !ok || driver.Code != "55P03" {
			t.Errorf("the period row was not held FOR SHARE: NOWAIT FOR UPDATE got %v", err != nil)
		}
		_, err = probe.Exec(t.Context(), "SELECT 1 FROM attendance_period WHERE month = '2026-03-01' FOR SHARE NOWAIT")
		return err
	}))

	// A close holding the row FOR UPDATE makes the writer wait, and fail on lock_timeout.
	f.exec("BEGIN")
	f.exec("SELECT 1 FROM attendance_period WHERE month = '2026-03-01' FOR UPDATE")
	err = periodsOpen(t, f, "2026-03-20")
	var conflict *database.ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("a held period row did not stop the writer: %v", err)
	}
	f.exec("COMMIT")
	mustDB(t, periodsOpen(t, f, "2026-03-20"))
}
