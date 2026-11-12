//go:build integration

package database_test

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/database"
	"hrm/api/test"
)

// execModeProbe connects through the wire proxy under one mode, as the NestJS driver would see the same
// statements: the parameter types come from the server and every statement is counted.
type execModeProbe struct {
	t     *testing.T
	ctx   context.Context
	proxy *test.WireProxy
	conn  *pgx.Conn
}

func newExecModeProbe(t *testing.T, mode pgx.QueryExecMode) *execModeProbe {
	t.Helper()
	ctx := testContext(t)
	proxy, err := test.StartWireProxy(cluster.Address())
	if err != nil {
		t.Fatal(err)
	}
	config, err := database.NewConnConfig("postgres://"+test.Superuser()+":"+cluster.SuperuserPassword()+"@"+proxy.Address()+"/"+databaseName, database.TLSDisabled)
	if err != nil {
		t.Fatal(err)
	}
	config.DefaultQueryExecMode = mode
	config.StatementCacheCapacity = 512
	config.DescriptionCacheCapacity = 512
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(ctx); err != nil && !conn.IsClosed() {
			t.Error(err)
		}
		if err := proxy.Close(); err != nil {
			t.Error(err)
		}
	})
	return &execModeProbe{t: t, ctx: ctx, proxy: proxy, conn: conn}
}

// roundTrips counts the messages the client waited on for one call.
func (p *execModeProbe) roundTrips(call func() error) (int, error) {
	p.proxy.Reset()
	err := call()
	return p.proxy.RoundTrips(), err
}

func (p *execModeProbe) text(sql string, args ...any) (string, error) {
	var value string
	err := p.conn.QueryRow(p.ctx, sql, args...).Scan(&value)
	return value, err
}

func (p *execModeProbe) queryAll(sql string, args ...any) error {
	rows, err := p.conn.Query(p.ctx, sql, args...)
	if err != nil {
		return err
	}
	rows.Close()
	return rows.Err()
}

type execModeResult struct {
	name string
	// firstCall and secondCall are the round trips of the same statement on one connection.
	firstCall, secondCall int
	// transaction is the round trips of the fence sequence of a shared mode, on a cold connection.
	transaction     int
	typesFromServer string
	multiExec       string
	multiQuery      string
	multiWithArgs   string
	afterDDL        string
	sessionKilled   string
	prepared        string
	literalInLog    bool
}

func errorCode(err error) string {
	if err == nil {
		return "ok"
	}
	if code := sqlState(err); code != "" {
		return code
	}
	return "client error"
}

func measureExecMode(t *testing.T, name string, mode pgx.QueryExecMode) execModeResult {
	t.Helper()
	result := execModeResult{name: name}
	const account = "20000000-0000-4000-8000-0000000000aa"
	asSuperuser(t, "SET session_replication_role=replica; INSERT INTO app_user(id,email_canonical,state) VALUES ('"+account+"','exec-mode@example.test','active') ON CONFLICT DO NOTHING")

	cold := newExecModeProbe(t, mode)
	transaction := func() error {
		tx, err := cold.conn.BeginTx(cold.ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
		if err != nil {
			return err
		}
		if _, err := tx.Exec(cold.ctx, setTimeoutsSQL, "3000ms", "1000ms"); err != nil {
			return err
		}
		var (
			revision string
			required int
		)
		if err := tx.QueryRow(cold.ctx, sharedSQL, database.RuntimeCapability).Scan(&revision, &required); err != nil {
			return err
		}
		return tx.Commit(cold.ctx)
	}
	trips, err := cold.roundTrips(transaction)
	if err != nil {
		t.Fatalf("%s: fence sequence: %v", name, err)
	}
	result.transaction = trips

	probe := newExecModeProbe(t, mode)
	const byID = "SELECT email_canonical FROM app_user WHERE id=$1"
	var email string
	for index, target := range []*int{&result.firstCall, &result.secondCall} {
		trips, err := probe.roundTrips(func() error {
			var err error
			email, err = probe.text(byID, account)
			return err
		})
		if err != nil || email != "exec-mode@example.test" {
			t.Fatalf("%s: call %d: %q, %v", name, index, email, err)
		}
		*target = trips
	}

	types := []string{}
	if value, err := probe.text("SELECT $1", "untyped"); err != nil || value != "untyped" {
		types = append(types, "untyped:"+errorCode(err))
	}
	if value, err := probe.text("SELECT convert_from($1,'UTF8')", []byte("bytes")); err != nil || value != "bytes" {
		types = append(types, "bytea:"+errorCode(err))
	}
	if value, err := probe.text("SELECT count(*)::text FROM pg_proc WHERE proname=ANY($1)", []string{"resolve_session"}); err != nil || value != "1" {
		types = append(types, "name[]:"+errorCode(err))
	}
	if value, err := probe.text("SELECT pg_advisory_unlock_all()::text||$1", int64(9)); err != nil || value == "" {
		types = append(types, "int:"+errorCode(err))
	}
	if value, err := probe.text("SELECT $1::timestamptz::text", time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)); err != nil || !strings.Contains(value, ".123456") {
		types = append(types, "time:"+errorCode(err))
	}
	if len(types) == 0 {
		types = []string{"ok"}
	}
	result.typesFromServer = strings.Join(types, ",")

	const twoStatements = "SELECT 1; SELECT 2"
	_, err = probe.conn.Exec(probe.ctx, twoStatements)
	result.multiExec = errorCode(err)
	result.multiQuery = errorCode(probe.queryAll(twoStatements))
	_, err = probe.conn.Exec(probe.ctx, "SELECT $1::int; SELECT 2", 1)
	result.multiWithArgs = errorCode(err)

	literal := newExecModeProbe(t, mode)
	if _, err := literal.text("SELECT $1", "do-not-log-me"); err != nil {
		t.Fatal(err)
	}
	result.literalInLog = slices.ContainsFunc(literal.proxy.Statements(), func(statement string) bool {
		return strings.Contains(statement, "do-not-log-me")
	})

	ddl := newExecModeProbe(t, mode)
	asSuperuser(t, "CREATE TABLE exec_mode_table(a int)")
	const selectAll = "SELECT * FROM exec_mode_table"
	if err := ddl.queryAll(selectAll); err != nil {
		t.Fatal(err)
	}
	asSuperuser(t, "ALTER TABLE exec_mode_table ALTER COLUMN a TYPE text USING a::text, ADD COLUMN b int")
	result.afterDDL = errorCode(ddl.queryAll(selectAll))
	asSuperuser(t, "DROP TABLE exec_mode_table")

	killed := newExecModeProbe(t, mode)
	tx, err := killed.conn.Begin(killed.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(killed.ctx, "SELECT set_config('transaction_timeout',$1,true)", "100ms"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	_, err = tx.Exec(killed.ctx, "SELECT 1")
	result.sessionKilled = errorCode(err)
	if err == nil || !killed.conn.IsClosed() {
		t.Errorf("%s: the session killed by transaction_timeout looks alive: %v", name, err)
	}

	cached := newExecModeProbe(t, mode)
	for index := range 5 {
		if err := cached.queryAll("SELECT " + strings.Repeat("1,", index) + "1"); err != nil {
			t.Fatal(err)
		}
	}
	count, err := cached.text("SELECT count(*)::text FROM pg_prepared_statements")
	if err != nil {
		t.Fatal(err)
	}
	result.prepared = count
	return result
}

func TestExecModes(t *testing.T) {
	results := map[string]execModeResult{}
	for _, entry := range []struct {
		name string
		mode pgx.QueryExecMode
	}{
		{"CacheStatement", pgx.QueryExecModeCacheStatement},
		{"CacheDescribe", pgx.QueryExecModeCacheDescribe},
		{"DescribeExec", pgx.QueryExecModeDescribeExec},
		{"Exec", pgx.QueryExecModeExec},
		{"SimpleProtocol", pgx.QueryExecModeSimpleProtocol},
	} {
		result := measureExecMode(t, entry.name, entry.mode)
		results[entry.name] = result
		t.Logf("%-15s first=%d second=%d fence-sequence=%d types=%s multi-exec=%s multi-query=%s multi-args=%s after-ddl=%s killed=%s prepared=%s literal-on-wire=%t",
			result.name, result.firstCall, result.secondCall, result.transaction, result.typesFromServer,
			result.multiExec, result.multiQuery, result.multiWithArgs, result.afterDDL, result.sessionKilled, result.prepared, result.literalInLog)
	}
	chosen := results["Exec"]
	if chosen.firstCall != 1 || chosen.secondCall != 1 {
		t.Errorf("a statement must cost one round trip from the first call: %+v", chosen)
	}
	if chosen.transaction != 4 {
		t.Errorf("begin, set_config, fence, commit must be 4 round trips: %+v", chosen)
	}
	if chosen.typesFromServer != "ok" {
		t.Errorf("the server must infer the parameter types: %s", chosen.typesFromServer)
	}
	if chosen.multiExec != "ok" || chosen.multiWithArgs != "42601" {
		t.Errorf("Exec without arguments takes several statements, with arguments it must not: %+v", chosen)
	}
	if chosen.afterDDL != "ok" {
		t.Errorf("a schema change must not break the next call: %s", chosen.afterDDL)
	}
	if chosen.prepared != "0" {
		t.Errorf("dynamic SQL must not stay on the connection: %s", chosen.prepared)
	}
	if chosen.literalInLog {
		t.Error("a parameter went into the statement text")
	}
	if !results["SimpleProtocol"].literalInLog {
		t.Error("SimpleProtocol no longer puts a parameter into the statement text; the reason to refuse it changed")
	}
	if results["CacheStatement"].firstCall != 2 || results["CacheDescribe"].firstCall != 2 || results["DescribeExec"].secondCall != 2 {
		t.Errorf("the extra round trips of the other modes changed: %+v", results)
	}
}

func TestPoolsUseTheChosenExecMode(t *testing.T) {
	proxy, runner := proxied(t, database.PurposeData)
	trips := 0
	got, err := database.Run(testContext(t), runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (string, error) {
		proxy.Reset()
		value, err := queryOne(tx, "SELECT $1", "untyped")
		trips = proxy.RoundTrips()
		return value, err
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got != "untyped" || trips != 1 {
		t.Fatalf("%q in %d round trips", got, trips)
	}
}
