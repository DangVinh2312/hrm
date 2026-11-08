//go:build integration

package database_test

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

const (
	beginSQL       = "begin isolation level read committed"
	commitSQL      = "commit"
	setTimeoutsSQL = "SELECT set_config('statement_timeout',$1,true),set_config('transaction_timeout',$1,true),set_config('lock_timeout',$2,true)"
	advisorySQL    = "SELECT pg_advisory_xact_lock($1)"
	sharedSQL      = "SELECT public.authz_acquire_shared_fence($1)::text AS revision,0 AS required"
	exclusiveSQL   = "SELECT revision::text AS revision,min_runtime_capability AS required FROM public.authz_state WHERE singleton FOR UPDATE"
	bumpSQL        = "UPDATE public.authz_state SET revision=revision+1 WHERE singleton"
	insertRoleSQL  = "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','Fault fixture')"
	countRoleSQL   = "SELECT count(*)::text FROM role_definition WHERE role_key=$1"
)

func none[T any](value T) func(context.Context, *database.Tx) (T, error) {
	return func(context.Context, *database.Tx) (T, error) { return value, nil }
}

func effect(work func(tx *database.Tx) error) func(context.Context, *database.Tx) (struct{}, error) {
	return func(_ context.Context, tx *database.Tx) (struct{}, error) { return struct{}{}, work(tx) }
}

func proxied(t *testing.T, purpose database.Purpose) (*test.WireProxy, *database.Runner) {
	t.Helper()
	return proxiedWith(t, purpose, database.RunnerOptions{})
}

func proxiedWith(t *testing.T, purpose database.Purpose, options database.RunnerOptions) (*test.WireProxy, *database.Runner) {
	t.Helper()
	proxy, err := test.StartWireProxy(cluster.Address())
	if err != nil {
		t.Fatal(err)
	}
	pool, err := openPool(testContext(t), purpose, proxy.Address())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		if err := proxy.Close(); err != nil {
			t.Error(err)
		}
	})
	runner, err := database.NewRunner(database.Pools{purpose: pool}, options)
	if err != nil {
		t.Fatal(err)
	}
	return proxy, runner
}

func TestStatementOrderOfEachFence(t *testing.T) {
	key := int64(1379171467)
	for _, tc := range []struct {
		name     string
		mode     database.Mode
		purpose  database.Purpose
		options  database.RunOptions
		expected []string
	}{
		{"read", database.ModeRead, database.PurposeData, database.RunOptions{}, []string{beginSQL, setTimeoutsSQL, sharedSQL, "SELECT 'facts'", commitSQL}},
		{"write", database.ModeWrite, database.PurposeData, database.RunOptions{}, []string{beginSQL, setTimeoutsSQL, sharedSQL, "SELECT 'facts'", commitSQL}},
		{"identity with advisory", database.ModeIdentity, database.PurposeIdentity, database.RunOptions{Serialize: &key}, []string{beginSQL, setTimeoutsSQL, advisorySQL, sharedSQL, "SELECT 'facts'", commitSQL}},
		{"revoke", database.ModeRevoke, database.PurposeIdentity, database.RunOptions{}, []string{beginSQL, setTimeoutsSQL, exclusiveSQL, "SELECT 'facts'", bumpSQL, commitSQL}},
		{"admin", database.ModeAdmin, database.PurposeAuthority, database.RunOptions{}, []string{beginSQL, setTimeoutsSQL, exclusiveSQL, "SELECT 'facts'", bumpSQL, commitSQL}},
		{"sync", database.ModeSync, database.PurposeSync, database.RunOptions{}, []string{beginSQL, setTimeoutsSQL, exclusiveSQL, "SELECT 'facts'", commitSQL}},
		{"bootstrap", database.ModeBootstrap, database.PurposeBootstrap, database.RunOptions{}, []string{beginSQL, setTimeoutsSQL, exclusiveSQL, "SELECT 'facts'", bumpSQL, commitSQL}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			proxy, runner := proxied(t, tc.purpose)
			_, err := database.Run(testContext(t), runner, tc.mode, effect(func(tx *database.Tx) error {
				_, err := tx.Exec("SELECT 'facts'")
				return err
			}), tc.options)
			if err != nil {
				t.Fatal(err)
			}
			if got := proxy.Statements(); !slices.Equal(got, tc.expected) {
				t.Fatalf("statements\n got %q\nwant %q", got, tc.expected)
			}
		})
	}
}

func TestEachModeUsesItsLogin(t *testing.T) {
	runner := newRunner(t, database.RunnerOptions{})
	for mode, login := range map[database.Mode]string{
		database.ModeRead:      "product_data",
		database.ModeWrite:     "product_data",
		database.ModeIdentity:  "product_identity",
		database.ModeRevoke:    "product_identity",
		database.ModeAdmin:     "product_authority",
		database.ModeSync:      "product_sync",
		database.ModeBootstrap: "product_bootstrap",
	} {
		got, err := database.Run(testContext(t), runner, mode, func(_ context.Context, tx *database.Tx) (string, error) {
			return queryOne(tx, "SELECT current_user::text")
		}, database.RunOptions{})
		if err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		if got != login {
			t.Errorf("%s ran as %s, want %s", mode, got, login)
		}
	}
}

func queryOne(tx *database.Tx, sql string, args ...any) (string, error) {
	rows, err := tx.Query(sql, args...)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var value string
	if rows.Next() {
		if err := rows.Scan(&value); err != nil {
			return "", err
		}
	}
	return value, rows.Err()
}

func TestTxCarriesModeAndRevision(t *testing.T) {
	before := revision(t)
	got, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeRead, func(_ context.Context, tx *database.Tx) (*database.Tx, error) {
		return tx, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Mode != database.ModeRead || got.Revision != before {
		t.Fatalf("mode %s revision %s, want %s", got.Mode, got.Revision, before)
	}
}

func TestRevisionAdvancesOnlyForSecurityModes(t *testing.T) {
	runner := newRunner(t, database.RunnerOptions{})
	for _, tc := range []struct {
		mode database.Mode
		step int64
	}{
		{database.ModeRead, 0}, {database.ModeWrite, 0}, {database.ModeIdentity, 0}, {database.ModeSync, 0},
		{database.ModeRevoke, 1}, {database.ModeAdmin, 1}, {database.ModeBootstrap, 1},
	} {
		before, err := strconv.ParseInt(revision(t), 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.Run(testContext(t), runner, tc.mode, none(1), database.RunOptions{}); err != nil {
			t.Fatalf("%s: %v", tc.mode, err)
		}
		after, err := strconv.ParseInt(revision(t), 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		if after-before != tc.step {
			t.Errorf("%s advanced the revision by %d, want %d", tc.mode, after-before, tc.step)
		}
	}
}

func TestAFailedAdminLeavesTheRevision(t *testing.T) {
	before := revision(t)
	failure := errors.New("business rejection")
	_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeAdmin, effect(func(*database.Tx) error { return failure }), database.RunOptions{})
	if !errors.Is(err, failure) {
		t.Fatalf("an unrelated error must pass unchanged, got %v", err)
	}
	if got := revision(t); got != before {
		t.Fatalf("revision moved from %s to %s", before, got)
	}
}

func TestSharedFenceBlocksRevokeAndLaterStatementsSeeTheNewEpoch(t *testing.T) {
	runner := newRunner(t, database.RunnerOptions{})
	ctx := testContext(t)
	before, err := strconv.ParseInt(revision(t), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	acquired := make(chan struct{})
	release := make(chan struct{})
	read := make(chan error, 1)
	go func() {
		_, err := database.Run(ctx, runner, database.ModeRead, effect(func(*database.Tx) error {
			close(acquired)
			<-release
			return nil
		}), database.RunOptions{})
		read <- err
	}()
	<-acquired
	var revoked atomic.Bool
	revoke := make(chan error, 1)
	go func() {
		_, err := database.Run(ctx, runner, database.ModeRevoke, effect(func(*database.Tx) error {
			revoked.Store(true)
			return nil
		}), database.RunOptions{})
		revoke <- err
	}()
	time.Sleep(75 * time.Millisecond)
	if revoked.Load() {
		t.Error("revoke went through a held shared fence")
	}
	close(release)
	if err := <-read; err != nil {
		t.Fatal(err)
	}
	if err := <-revoke; err != nil {
		t.Fatal(err)
	}
	got, err := database.Run(ctx, runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (string, error) {
		return tx.Revision, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got != strconv.FormatInt(before+1, 10) {
		t.Fatalf("revision %s after %d", got, before)
	}
}

func holdSharedFence(t *testing.T) func() {
	t.Helper()
	ctx := testContext(t)
	held, err := pools[database.PurposeData].Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := held.Exec(ctx, "SELECT public.authz_acquire_shared_fence(1)"); err != nil {
		t.Fatal(err)
	}
	return func() {
		if err := held.Rollback(ctx); err != nil {
			t.Error(err)
		}
	}
}

func TestRealLockTimeoutRetriesAreBounded(t *testing.T) {
	var retries atomic.Int32
	runner := newRunner(t, database.RunnerOptions{
		LockTimeout: 20 * time.Millisecond,
		OnMetric: func(metric database.Metric, _ database.Mode, _ float64) {
			if metric == database.MetricRetry {
				retries.Add(1)
			}
		},
	})
	release := holdSharedFence(t)
	defer release()
	_, err := database.Run(testContext(t), runner, database.ModeAdmin, none(1), database.RunOptions{})
	var conflict *database.ConflictError
	if !errors.As(err, &conflict) || conflict.Code != "55P03" {
		t.Fatalf("got %v, want a 55P03 conflict", err)
	}
	if retries.Load() != 2 {
		t.Fatalf("%d retries, want 2", retries.Load())
	}
}

func TestRetriesCannotBeRaised(t *testing.T) {
	var attempts atomic.Int32
	many := 50
	runner := newRunner(t, database.RunnerOptions{MaxRetries: &many})
	_, err := database.Run(testContext(t), runner, database.ModeRead, func(context.Context, *database.Tx) (int, error) {
		attempts.Add(1)
		return 0, &pgconn.PgError{Code: "40001"}
	}, database.RunOptions{})
	var conflict *database.ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("got %v", err)
	}
	if attempts.Load() != 3 {
		t.Fatalf("%d attempts, want 3", attempts.Load())
	}
	zero := 0
	attempts.Store(0)
	_, err = database.Run(testContext(t), newRunner(t, database.RunnerOptions{MaxRetries: &zero}), database.ModeRead, func(context.Context, *database.Tx) (int, error) {
		attempts.Add(1)
		return 0, &pgconn.PgError{Code: "40P01"}
	}, database.RunOptions{})
	if !errors.As(err, &conflict) || attempts.Load() != 1 {
		t.Fatalf("%v after %d attempts", err, attempts.Load())
	}
}

func TestInjectedConflictRollsBackAndCommitsOneEffect(t *testing.T) {
	for _, code := range []string{"40P01", "40001", "55P03"} {
		t.Run(code, func(t *testing.T) {
			attempts := 0
			var retries atomic.Int32
			runner := newRunner(t, database.RunnerOptions{OnMetric: func(metric database.Metric, _ database.Mode, _ float64) {
				if metric == database.MetricRetry {
					retries.Add(1)
				}
			}})
			key := []byte("custom.fault" + strings.ToLower(code))
			before, err := strconv.ParseInt(revision(t), 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			_, err = database.Run(testContext(t), runner, database.ModeAdmin, effect(func(tx *database.Tx) error {
				attempts++
				if _, err := tx.Exec(insertRoleSQL, key); err != nil {
					return err
				}
				if attempts < 3 {
					return &pgconn.PgError{Code: code}
				}
				return nil
			}), database.RunOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if attempts != 3 || retries.Load() != 2 {
				t.Fatalf("%d attempts, %d retries", attempts, retries.Load())
			}
			if got := querySuperuser(t, countRoleSQL, key); got != "1" {
				t.Fatalf("%s rows", got)
			}
			after, err := strconv.ParseInt(revision(t), 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			if after != before+1 {
				t.Fatalf("revision %d after %d", after, before)
			}
		})
	}
}

func TestOnlyTheThreeCodesRetry(t *testing.T) {
	for code, unavailable := range map[string]bool{
		"23505": false, "42501": false, "40000": false, "25P02": false,
		"57014": true, "57P01": true, "53300": true, "08006": true, "25P03": true, "25P04": true, "AZ001": true, "P0002": true,
	} {
		t.Run(code, func(t *testing.T) {
			attempts := 0
			injected := &pgconn.PgError{Code: code}
			_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeRead, func(context.Context, *database.Tx) (int, error) {
				attempts++
				return 0, injected
			}, database.RunOptions{})
			if attempts != 1 {
				t.Fatalf("%d attempts", attempts)
			}
			var failed *database.UnavailableError
			if unavailable != errors.As(err, &failed) {
				t.Fatalf("got %v", err)
			}
			if !unavailable && !errors.Is(err, injected) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestAFailingMetricDoesNotChangeTheCommit(t *testing.T) {
	runner := newRunner(t, database.RunnerOptions{OnMetric: func(database.Metric, database.Mode, float64) {
		panic("metrics unavailable")
	}})
	key := []byte("custom.badmetric")
	if _, err := database.Run(testContext(t), runner, database.ModeAdmin, effect(func(tx *database.Tx) error {
		_, err := tx.Exec(insertRoleSQL, key)
		return err
	}), database.RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := querySuperuser(t, countRoleSQL, key); got != "1" {
		t.Fatalf("%s rows", got)
	}
}

func TestMetricsAreReported(t *testing.T) {
	seen := map[database.Metric]database.Mode{}
	runner := newRunner(t, database.RunnerOptions{OnMetric: func(metric database.Metric, mode database.Mode, _ float64) {
		seen[metric] = mode
	}})
	if _, err := database.Run(testContext(t), runner, database.ModeRevoke, none(1), database.RunOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, metric := range []database.Metric{database.MetricPoolWait, database.MetricLockWait, database.MetricLockHold, database.MetricTransaction, database.MetricRevokeCommit} {
		if seen[metric] != database.ModeRevoke {
			t.Errorf("%s not reported", metric)
		}
	}
}

func TestLimitsReachTheServerAndCannotBeRaised(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		options               database.RunnerOptions
		statement, lockWanted string
	}{
		{"defaults", database.RunnerOptions{}, "3s", "1s"},
		{"above the caps", database.RunnerOptions{Deadline: time.Minute, LockTimeout: time.Minute}, "3s", "1s"},
		{"lowered", database.RunnerOptions{Deadline: 2 * time.Second, LockTimeout: 200 * time.Millisecond}, "2s", "200ms"},
		{"lock under the deadline", database.RunnerOptions{Deadline: 300 * time.Millisecond}, "300ms", "300ms"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := database.Run(testContext(t), newRunner(t, tc.options), database.ModeRead, func(_ context.Context, tx *database.Tx) ([3]string, error) {
				var values [3]string
				var err error
				for i, name := range []string{"statement_timeout", "transaction_timeout", "lock_timeout"} {
					if values[i], err = queryOne(tx, "SELECT current_setting('"+name+"')"); err != nil {
						return values, err
					}
				}
				return values, nil
			}, database.RunOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if got != [3]string{tc.statement, tc.statement, tc.lockWanted} {
				t.Fatalf("settings %v", got)
			}
		})
	}
}

func TestNewRunnerRefusesNegativeLimits(t *testing.T) {
	negative := -1
	for name, options := range map[string]database.RunnerOptions{
		"deadline": {Deadline: -time.Second},
		"lock":     {LockTimeout: -time.Second},
		"retries":  {MaxRetries: &negative},
		"too fine": {Deadline: time.Microsecond},
	} {
		if _, err := database.NewRunner(pools, options); !errors.Is(err, database.ErrInvalidRunner) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

func TestStatementTimeoutIsUnavailable(t *testing.T) {
	attempts := 0
	runner := newRunner(t, database.RunnerOptions{Deadline: 100 * time.Millisecond})
	started := time.Now()
	_, err := database.Run(testContext(t), runner, database.ModeRead, effect(func(tx *database.Tx) error {
		attempts++
		_, err := tx.Exec("SELECT pg_sleep(5)")
		return err
	}), database.RunOptions{})
	var failed *database.UnavailableError
	if !errors.As(err, &failed) {
		t.Fatalf("got %v", err)
	}
	if attempts != 1 {
		t.Fatalf("%d attempts", attempts)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %s", elapsed)
	}
	t.Logf("code %s", failed.Code)
}

func TestWorkPastTheDeadlineDoesNotCommit(t *testing.T) {
	key := []byte("custom.pastdeadline")
	runner := newRunner(t, database.RunnerOptions{Deadline: 100 * time.Millisecond})
	_, err := database.Run(testContext(t), runner, database.ModeAdmin, effect(func(tx *database.Tx) error {
		if _, err := tx.Exec(insertRoleSQL, key); err != nil {
			if code := sqlState(err); code != "25P04" && code != "57014" {
				t.Errorf("insert: %v", err)
			}
			return err
		}
		time.Sleep(200 * time.Millisecond)
		_, err := tx.Exec("SELECT 1")
		return err
	}), database.RunOptions{})
	var failed *database.UnavailableError
	if !errors.As(err, &failed) {
		t.Fatalf("got %v", err)
	}
	if got := querySuperuser(t, countRoleSQL, key); got != "0" {
		t.Fatalf("%s rows", got)
	}
}

func TestDeadlineCheckRunsBeforeCommit(t *testing.T) {
	key := []byte("custom.lateeffect")
	runner := newRunner(t, database.RunnerOptions{Deadline: 150 * time.Millisecond})
	_, err := database.Run(testContext(t), runner, database.ModeAdmin, effect(func(tx *database.Tx) error {
		if _, err := tx.Exec(insertRoleSQL, key); err != nil {
			return err
		}
		time.Sleep(200 * time.Millisecond)
		return nil
	}), database.RunOptions{})
	var failed *database.UnavailableError
	if !errors.As(err, &failed) {
		t.Fatalf("got %v", err)
	}
	if got := querySuperuser(t, countRoleSQL, key); got != "0" {
		t.Fatalf("%s rows after a missed deadline", got)
	}
}

// The check before commit counts from before the connection was acquired, as the NestJS runner does; the
// timeouts on the server count from the transaction. Only this check sees a long wait plus a short body.
func TestWaitForAConnectionCountsInTheCheckBeforeCommit(t *testing.T) {
	ctx := testContext(t)
	config, err := database.NewPoolConfig(database.PurposeAuthority, loginURL(database.PurposeAuthority, cluster.Address()), database.TLSDisabled)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := database.NewPool(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	runner, err := database.NewRunner(database.Pools{database.PurposeAuthority: pool}, database.RunnerOptions{Deadline: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	held, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(800*time.Millisecond, held.Release)
	key := []byte("custom.waited")
	_, err = database.Run(ctx, runner, database.ModeAdmin, effect(func(tx *database.Tx) error {
		if _, err := tx.Exec(insertRoleSQL, key); err != nil {
			return err
		}
		time.Sleep(300 * time.Millisecond)
		return nil
	}), database.RunOptions{})
	var failed *database.UnavailableError
	if !errors.As(err, &failed) || failed.Code != "deadline" {
		t.Fatalf("got %v, want the deadline check", err)
	}
	if got := querySuperuser(t, countRoleSQL, key); got != "0" {
		t.Fatalf("%s rows", got)
	}
}

func TestTransactionTimeoutBetweenStatementsIsUnavailable(t *testing.T) {
	runner := newRunner(t, database.RunnerOptions{Deadline: 150 * time.Millisecond})
	attempts := 0
	_, err := database.Run(testContext(t), runner, database.ModeRead, effect(func(tx *database.Tx) error {
		attempts++
		time.Sleep(300 * time.Millisecond)
		_, err := tx.Exec("SELECT 1")
		return err
	}), database.RunOptions{})
	var failed *database.UnavailableError
	if !errors.As(err, &failed) {
		t.Fatalf("got %v", err)
	}
	if attempts != 1 {
		t.Fatalf("%d attempts", attempts)
	}
	t.Logf("code %s", failed.Code)
	if _, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeRead, none(1), database.RunOptions{}); err != nil {
		t.Fatalf("the killed session stayed in the pool: %v", err)
	}
}

func TestPoolWaitOverTwoSecondsIsUnavailable(t *testing.T) {
	ctx := testContext(t)
	pool := pools[database.PurposeAuthority]
	var held []*pgxpool.Conn
	for range 2 {
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, conn)
	}
	defer func() {
		for _, conn := range held {
			conn.Release()
		}
	}()
	started := time.Now()
	_, err := database.Run(ctx, newRunner(t, database.RunnerOptions{}), database.ModeAdmin, none(1), database.RunOptions{})
	elapsed := time.Since(started)
	var failed *database.UnavailableError
	if !errors.As(err, &failed) || failed.Code != "pool_timeout" {
		t.Fatalf("got %v", err)
	}
	if elapsed < 1900*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("waited %s", elapsed)
	}
}

func withCapability(t *testing.T, value string, check func()) {
	t.Helper()
	asSuperuser(t, "SET session_replication_role=replica; UPDATE authz_state SET min_runtime_capability="+value)
	defer asSuperuser(t, "SET session_replication_role=replica; UPDATE authz_state SET min_runtime_capability=1")
	check()
}

func TestRuntimeIncompatibleFailsClosedWithoutRetry(t *testing.T) {
	withCapability(t, "2", func() {
		for mode, code := range map[database.Mode]string{
			database.ModeRead:     "AZ001",
			database.ModeWrite:    "AZ001",
			database.ModeIdentity: "AZ001",
			database.ModeAdmin:    "runtime_incompatible",
			database.ModeRevoke:   "runtime_incompatible",
			database.ModeSync:     "runtime_incompatible",
		} {
			ran := false
			_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), mode, effect(func(*database.Tx) error {
				ran = true
				return nil
			}), database.RunOptions{})
			var failed *database.UnavailableError
			if !errors.As(err, &failed) || failed.Code != code {
				t.Errorf("%s: got %v, want %s", mode, err, code)
			}
			if ran {
				t.Errorf("%s: the callback ran", mode)
			}
		}
	})
}

func TestMissingFenceFailsClosed(t *testing.T) {
	ctx := testContext(t)
	conn, err := cluster.ConnectSuperuser(ctx, databaseName)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	}()
	for _, statement := range []string{
		"SET session_replication_role=replica",
		"CREATE TABLE public.authz_state_saved AS SELECT * FROM public.authz_state",
		"DELETE FROM public.authz_state",
	} {
		if _, err := conn.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		for _, statement := range []string{
			"INSERT INTO public.authz_state SELECT * FROM public.authz_state_saved",
			"DROP TABLE public.authz_state_saved",
		} {
			if _, err := conn.Exec(ctx, statement); err != nil {
				t.Error(err)
			}
		}
	}()
	for mode, code := range map[database.Mode]string{
		database.ModeRead:  "P0002",
		database.ModeAdmin: "fence_missing",
	} {
		_, err := database.Run(ctx, newRunner(t, database.RunnerOptions{}), mode, none(1), database.RunOptions{})
		var failed *database.UnavailableError
		if !errors.As(err, &failed) || failed.Code != code {
			t.Errorf("%s: got %v, want %s", mode, err, code)
		}
	}
}

func TestPanicRollsBackAndReleases(t *testing.T) {
	key := []byte("custom.panic")
	before := revision(t)
	sentinel := errors.New("handler aborted")
	func() {
		defer func() {
			if got := recover(); got != sentinel {
				t.Errorf("recovered %v, the panic must go on unchanged", got)
			}
		}()
		if _, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeAdmin, effect(func(tx *database.Tx) error {
			if _, err := tx.Exec(insertRoleSQL, key); err != nil {
				return err
			}
			panic(sentinel)
		}), database.RunOptions{}); err != nil {
			t.Errorf("returned %v", err)
		}
	}()
	if got := querySuperuser(t, countRoleSQL, key); got != "0" {
		t.Fatalf("%s rows after a panic", got)
	}
	if got := revision(t); got != before {
		t.Fatalf("revision moved from %s to %s", before, got)
	}
	for range 3 {
		if _, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeAdmin, none(1), database.RunOptions{}); err != nil {
			t.Fatalf("the connection did not come back: %v", err)
		}
	}
}

func TestTimeoutsDoNotLeakAcrossTransactionsOfOneConnection(t *testing.T) {
	ctx := testContext(t)
	config, err := database.NewPoolConfig(database.PurposeSync, loginURL(database.PurposeSync, cluster.Address()), database.TLSDisabled)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := database.NewPool(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	settings := func() string {
		var statement, transaction, lock string
		if err := pool.QueryRow(ctx, "SELECT current_setting('statement_timeout'),current_setting('transaction_timeout'),current_setting('lock_timeout')").Scan(&statement, &transaction, &lock); err != nil {
			t.Fatal(err)
		}
		return statement + "|" + transaction + "|" + lock
	}
	var backend int
	if err := pool.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&backend); err != nil {
		t.Fatal(err)
	}
	initial := settings()
	runner, err := database.NewRunner(database.Pools{database.PurposeSync: pool}, database.RunnerOptions{Deadline: time.Second, LockTimeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("rolled back")
	for _, work := range []func(context.Context, *database.Tx) (int, error){
		none(1),
		func(context.Context, *database.Tx) (int, error) { return 0, failure },
	} {
		if _, err := database.Run(ctx, runner, database.ModeSync, work, database.RunOptions{}); err != nil && !errors.Is(err, failure) {
			t.Fatal(err)
		}
		if got := settings(); got != initial {
			t.Fatalf("settings changed from %s to %s", initial, got)
		}
		var after int
		if err := pool.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&after); err != nil {
			t.Fatal(err)
		}
		if after != backend {
			t.Fatal("this test no longer looks at the same connection")
		}
	}
}

func TestCallerCancelDoesNotAbortTheTransaction(t *testing.T) {
	first, second := []byte("custom.cancel1"), []byte("custom.cancel2")
	ctx, cancel := context.WithCancel(testContext(t))
	defer cancel()
	before, err := strconv.ParseInt(revision(t), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Run(ctx, newRunner(t, database.RunnerOptions{}), database.ModeAdmin, func(inner context.Context, tx *database.Tx) (int, error) {
		if _, err := tx.Exec(insertRoleSQL, first); err != nil {
			return 0, err
		}
		cancel()
		if ctx.Err() == nil {
			t.Error("the context of the caller is not cancelled")
		}
		if inner.Err() != nil {
			t.Errorf("the context of the transaction ended with the caller: %v", inner.Err())
		}
		// A statement in flight when the client goes away, then the second half of the mutation.
		go cancel()
		if _, err := tx.Exec("SELECT pg_sleep(0.2)"); err != nil {
			return 0, err
		}
		_, err := tx.Exec(insertRoleSQL, second)
		return 0, err
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range [][]byte{first, second} {
		if got := querySuperuser(t, countRoleSQL, key); got != "1" {
			t.Fatalf("%s: %s rows", key, got)
		}
	}
	after, err := strconv.ParseInt(revision(t), 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if after != before+1 {
		t.Fatalf("revision %d after %d", after, before)
	}
}

func TestAContextAlreadyEndedStillRuns(t *testing.T) {
	ctx, cancel := context.WithCancel(testContext(t))
	cancel()
	got, err := database.Run(ctx, newRunner(t, database.RunnerOptions{}), database.ModeRead, none(7), database.RunOptions{})
	if err != nil || got != 7 {
		t.Fatalf("got %d, %v", got, err)
	}
}

func TestTheTransactionKeepsItsOwnDeadline(t *testing.T) {
	_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeRead, func(inner context.Context, _ *database.Tx) (int, error) {
		deadline, set := inner.Deadline()
		if !set {
			t.Error("no deadline")
		}
		if remaining := time.Until(deadline); remaining > 4*time.Second || remaining <= 0 {
			t.Errorf("deadline in %s", remaining)
		}
		return 0, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
}

func TestAKilledSessionIsUnavailableAndNotRetried(t *testing.T) {
	attempts := 0
	_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeRead, effect(func(tx *database.Tx) error {
		attempts++
		backend, err := queryOne(tx, "SELECT pg_backend_pid()::text")
		if err != nil {
			return err
		}
		asSuperuser(t, "SELECT pg_terminate_backend("+backend+")")
		_, err = tx.Exec("SELECT 1")
		return err
	}), database.RunOptions{})
	var failed *database.UnavailableError
	if !errors.As(err, &failed) {
		t.Fatalf("got %v", err)
	}
	if attempts != 1 {
		t.Fatalf("%d attempts", attempts)
	}
	t.Logf("code %s", failed.Code)
}

func TestCommitOfAnAbortedTransactionIsNotASuccess(t *testing.T) {
	// Sync bumps no revision, so the failed statement reaches Commit itself.
	_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeSync, effect(func(tx *database.Tx) error {
		if _, err := tx.Exec("SELECT 1/0"); err == nil {
			t.Error("the division did not fail")
		}
		return nil
	}), database.RunOptions{})
	if !errors.Is(err, pgx.ErrTxCommitRollback) {
		t.Fatalf("got %v, want the commit to report the rollback", err)
	}
}

func TestUnclosedRowsFailTheCommit(t *testing.T) {
	key := []byte("custom.openrows")
	_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeAdmin, effect(func(tx *database.Tx) error {
		if _, err := tx.Exec(insertRoleSQL, key); err != nil {
			return err
		}
		rows, err := tx.Query("SELECT generate_series(1,100000)") //nolint:rowserrcheck,sqlclosecheck // leaving rows open is what this test is about
		if err != nil {
			return err
		}
		if !rows.Next() {
			t.Error("no row")
		}
		return nil
	}), database.RunOptions{})
	if err == nil {
		t.Fatal("committed with rows still open")
	}
	if got := querySuperuser(t, countRoleSQL, key); got != "0" {
		t.Fatalf("%s rows", got)
	}
}

func TestTxIsUnusableAfterTheCallback(t *testing.T) {
	leaked, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeRead, func(_ context.Context, tx *database.Tx) (*database.Tx, error) {
		return tx, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var failed *database.UnavailableError
	if _, err := leaked.Exec("SELECT 1"); !errors.As(err, &failed) {
		t.Fatalf("Exec: %v", err)
	}
	rows, err := leaked.Query("SELECT 1") //nolint:rowserrcheck,sqlclosecheck // a Tx after its callback returns no rows
	if rows != nil || !errors.As(err, &failed) {
		t.Fatalf("Query: %v", err)
	}
}

func TestNoFallbackToAnotherLogin(t *testing.T) {
	runner, err := database.NewRunner(database.Pools{
		database.PurposeData:      pools[database.PurposeData],
		database.PurposeIdentity:  pools[database.PurposeIdentity],
		database.PurposeAuthority: pools[database.PurposeAuthority],
		database.PurposeSync:      pools[database.PurposeSync],
	}, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Run(testContext(t), runner, database.ModeBootstrap, none(1), database.RunOptions{})
	var failed *database.UnavailableError
	if !errors.As(err, &failed) || failed.Code != "capability_unavailable" {
		t.Fatalf("got %v", err)
	}
}

func TestProgrammingErrorsOfTheCaller(t *testing.T) {
	runner := newRunner(t, database.RunnerOptions{})
	if _, err := database.Run(testContext(t), runner, database.Mode("other"), none(1), database.RunOptions{}); !errors.Is(err, database.ErrUnknownMode) {
		t.Fatalf("unknown mode: %v", err)
	}
	var zero database.Mode
	if _, err := database.Run(testContext(t), runner, zero, none(1), database.RunOptions{}); !errors.Is(err, database.ErrUnknownMode) {
		t.Fatalf("zero mode: %v", err)
	}
	unsafe := int64(1) << 53
	if _, err := database.Run(testContext(t), runner, database.ModeIdentity, none(1), database.RunOptions{Serialize: &unsafe}); !errors.Is(err, database.ErrInvalidAdvisoryKey) {
		t.Fatalf("advisory key: %v", err)
	}
}

func TestAdvisoryLockSerializesBeforeTheFence(t *testing.T) {
	ctx := testContext(t)
	runner := newRunner(t, database.RunnerOptions{})
	key := int64(1379171467)
	entered := make(chan struct{})
	release := make(chan struct{})
	first := make(chan error, 1)
	go func() {
		_, err := database.Run(ctx, runner, database.ModeIdentity, effect(func(*database.Tx) error {
			close(entered)
			<-release
			return nil
		}), database.RunOptions{Serialize: &key})
		first <- err
	}()
	<-entered
	var queued atomic.Bool
	second := make(chan error, 1)
	go func() {
		_, err := database.Run(ctx, runner, database.ModeIdentity, effect(func(*database.Tx) error {
			queued.Store(true)
			return nil
		}), database.RunOptions{Serialize: &key})
		second <- err
	}()
	time.Sleep(100 * time.Millisecond)
	if queued.Load() {
		t.Error("the second holder entered while the first held the key")
	}
	waiting := querySuperuser(t, "SELECT count(*)::text FROM pg_locks WHERE locktype='advisory' AND NOT granted")
	if waiting != "1" {
		t.Errorf("%s advisory waiters", waiting)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if !queued.Load() {
		t.Fatal("the second holder never ran")
	}
}

func TestAnErrorInTheMiddleOfRowsFailsTheRead(t *testing.T) {
	got, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeRead, func(_ context.Context, tx *database.Tx) ([]int32, error) {
		rows, err := tx.Query("SELECT 10/(3-g) FROM generate_series(1,5) g")
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowTo[int32])
	}, database.RunOptions{})
	if sqlState(err) != "22012" {
		t.Fatalf("got %v and %v: a read cut short must not look complete", got, err)
	}
	if got != nil {
		t.Fatalf("partial rows %v", got)
	}
}

func TestAnIdleConnectionIsPingedOnce(t *testing.T) {
	proxy, runner := proxied(t, database.PurposeData)
	if _, err := database.Run(testContext(t), runner, database.ModeRead, none(1), database.RunOptions{}); err != nil {
		t.Fatal(err)
	}
	proxy.Reset()
	if _, err := database.Run(testContext(t), runner, database.ModeRead, none(1), database.RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := proxy.RoundTrips(); got != 4 {
		t.Fatalf("%d round trips right after the last use, want begin, set_config, fence, commit: %q", got, proxy.Statements())
	}
	time.Sleep(1100 * time.Millisecond)
	proxy.Reset()
	if _, err := database.Run(testContext(t), runner, database.ModeRead, none(1), database.RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := proxy.RoundTrips(); got != 5 || proxy.Statements()[0] != "-- ping" {
		t.Fatalf("%d round trips after idling: %q", got, proxy.Statements())
	}
}

func TestAConnectionKilledWhileIdleIsReplacedWithoutAnError(t *testing.T) {
	ctx := testContext(t)
	config, err := database.NewPoolConfig(database.PurposeSync, loginURL(database.PurposeSync, cluster.Address()), database.TLSDisabled)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := database.NewPool(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var backend string
	if err := pool.QueryRow(ctx, "SELECT pg_backend_pid()::text").Scan(&backend); err != nil {
		t.Fatal(err)
	}
	asSuperuser(t, "SELECT pg_terminate_backend("+backend+")")
	time.Sleep(1100 * time.Millisecond)
	runner, err := database.NewRunner(database.Pools{database.PurposeSync: pool}, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Run(ctx, runner, database.ModeSync, none(1), database.RunOptions{}); err != nil {
		t.Fatalf("a request paid for a connection that died while idle: %v", err)
	}
}

func TestTxIsClosedOnceTheCallbackReturns(t *testing.T) {
	proxy, runner := proxied(t, database.PurposeAuthority)
	handoff := make(chan *database.Tx, 1)
	refused := make(chan error, 1)
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		defer proxy.Release()
		var leaked *database.Tx
		select {
		case leaked = <-handoff:
		case <-finished:
			return
		}
		for limit := time.After(10 * time.Second); !slices.Contains(proxy.Statements(), bumpSQL); {
			select {
			case <-finished:
				return
			case <-limit:
				refused <- errors.New("the runner never reached the revision bump")
				return
			case <-time.After(time.Millisecond):
			}
		}
		rows, err := leaked.Query("SELECT 1") //nolint:rowserrcheck,sqlclosecheck // a refused Query returns no rows
		if rows != nil {
			rows.Close()
			err = errors.Join(err, rows.Err())
		}
		refused <- err
	}()
	_, err := database.Run(testContext(t), runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (int, error) {
		proxy.Hold()
		handoff <- tx
		return 1, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var failed *database.UnavailableError
	if err := <-refused; !errors.As(err, &failed) {
		t.Fatalf("a statement between the callback and the commit got %v", err)
	}
}

func TestAServerThatStopsAnsweringIsUnavailableOnTime(t *testing.T) {
	proxy, runner := proxiedWith(t, database.PurposeData, database.RunnerOptions{Deadline: 300 * time.Millisecond})
	ctx := testContext(t)
	done := make(chan error, 1)
	started := time.Now()
	go func() {
		_, err := database.Run(ctx, runner, database.ModeRead, effect(func(tx *database.Tx) error {
			proxy.Hold()
			_, err := tx.Exec("SELECT 1")
			return err
		}), database.RunOptions{})
		done <- err
	}()
	select {
	case err := <-done:
		proxy.Release()
		var failed *database.UnavailableError
		if !errors.As(err, &failed) {
			t.Fatalf("got %v", err)
		}
		if elapsed := time.Since(started); elapsed > 2*time.Second {
			t.Fatalf("returned after %s", elapsed)
		}
		t.Logf("code %s", failed.Code)
	case <-time.After(5 * time.Second):
		proxy.Release()
		t.Fatalf("the runner waited on a server that does not answer, then returned %v", <-done)
	}
}

// Each attempt fits its own deadline; only the budget of the request ends them. Sleeping only adds time,
// so a slow machine cannot bring the total under 5 s; the commit case keeps a second under the deadline.
func TestTheRequestBudgetCoversEveryAttempt(t *testing.T) {
	for _, tc := range []struct {
		name     string
		sleep    time.Duration
		attempts int
		last     error
	}{
		{"retry", 2600 * time.Millisecond, 2, &pgconn.PgError{Code: "40001"}},
		{"commit", 2 * time.Second, 3, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key := []byte("custom.budget" + tc.name)
			attempts := 0
			_, err := database.Run(testContext(t), newRunner(t, database.RunnerOptions{}), database.ModeAdmin, effect(func(tx *database.Tx) error {
				attempts++
				if _, err := tx.Exec(insertRoleSQL, key); err != nil {
					return err
				}
				time.Sleep(tc.sleep)
				if attempts < tc.attempts {
					return &pgconn.PgError{Code: "40001"}
				}
				return tc.last
			}), database.RunOptions{})
			if attempts != tc.attempts {
				t.Fatalf("%d attempts, want %d: %v", attempts, tc.attempts, err)
			}
			var conflict *database.ConflictError
			var failed *database.UnavailableError
			if tc.last != nil && (!errors.As(err, &conflict) || conflict.Code != "40001") {
				t.Fatalf("got %v, want the conflict", err)
			}
			if tc.last == nil && (!errors.As(err, &failed) || failed.Code != "deadline") {
				t.Fatalf("got %v, want the deadline check", err)
			}
			if got := querySuperuser(t, countRoleSQL, key); got != "0" {
				t.Fatalf("%s rows", got)
			}
		})
	}
}
