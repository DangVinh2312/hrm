//go:build integration

package workschedule

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// lockOrder holds later (the period row FOR UPDATE, as a close does) until command waits, then expects
// earlier to be held by that command already (55P03 under a 50 ms lock_timeout).
func (f *scheduleFixture) lockOrder(t *testing.T, name, later, earlier string, command func(context.Context) error) {
	t.Helper()
	holder, err := f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	defer func() { mustDB(t, holder.Close(context.WithoutCancel(t.Context()))) }()
	tx, err := holder.Begin(t.Context())
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), later)
	mustDB(t, err)
	done := make(chan error, 1)
	go func() { done <- command(context.Background()) }()
	waiting := false
	for deadline := time.Now().Add(900 * time.Millisecond); !waiting && time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		waiting = f.one(t, `SELECT (count(*) > 0)::text FROM pg_stat_activity WHERE datname=current_database() AND usename='product_data' AND cardinality(pg_blocking_pids(pid))>0`) == "true"
	}
	if !waiting {
		t.Fatalf("%s did not wait on the period", name)
	}
	_, err = tx.Exec(t.Context(), `SET LOCAL lock_timeout = '50ms'`)
	mustDB(t, err)
	_, err = tx.Exec(t.Context(), earlier)
	if pg, ok := errors.AsType[*pgconn.PgError](err); !ok || pg.Code != "55P03" {
		t.Errorf("%s: %s was free while the command waited on the period: %v", name, earlier, err)
	}
	mustDB(t, tx.Rollback(t.Context()))
	if err := <-done; err != nil {
		t.Errorf("%s: %v", name, err)
	}
}

// The company week and an employee frame lock their target (the calendar row, the employee row) before the
// attendance period FOR SHARE, the order a submit and a close share; the reverse could deadlock.
func TestScheduleCommandsLockTheirTargetBeforeThePeriod(t *testing.T) {
	f := newScheduleFixture(t)
	from := f.day(t, 40)
	f.exec(t, `INSERT INTO attendance_period(month) VALUES (date_trunc('month',CAST($1 AS date))::date) ON CONFLICT DO NOTHING`, from)
	period := `SELECT 1 FROM attendance_period WHERE month = date_trunc('month',DATE '` + from + `')::date FOR UPDATE`
	f.lockOrder(t, "company week", period, `SELECT 1 FROM work_calendar FOR UPDATE`, func(ctx context.Context) error {
		_, err := f.service.PutCompanySchedule(ctx, f.fresh["H"], CompanyScheduleInput{EffectiveFrom: from, Days: week(earlyDay)})
		return err
	})
	f.lockOrder(t, "employee frame", period, `SELECT 1 FROM employee WHERE id='`+f.employees["E"]+`' FOR UPDATE`, func(ctx context.Context) error {
		_, _, err := f.service.AddEmployeeFrame(ctx, f.fresh["H"], EmployeeFrameInput{EmployeeID: f.employees["E"], ValidFrom: from, Days: week(earlyDay)})
		return err
	})
}
