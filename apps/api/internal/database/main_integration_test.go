//go:build integration

package database_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"hrm/api/internal/database"
	"hrm/api/internal/offline"
	"hrm/api/test"
)

const databaseName = "hrm"

var (
	cluster   *test.Postgres
	admin     offline.Connection
	passwords offline.Passwords
	pools     database.Pools
	// expected is what the API adds for the application tables, taken from the contract.
	expected map[database.Purpose][]string
)

var runtimeLogins = []database.Purpose{
	database.PurposeData, database.PurposeIdentity, database.PurposeAuthority, database.PurposeSync, database.PurposeBootstrap,
}

func TestMain(m *testing.M) {
	code, err := runMain(m)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fixture: %T\n", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func runMain(m *testing.M) (int, error) {
	ctx := context.Background()
	var err error
	cluster, err = test.StartPostgres(ctx)
	if err != nil {
		return 0, err
	}
	defer func() {
		if stop := cluster.Stop(ctx); stop != nil {
			fmt.Fprintf(os.Stderr, "stop: %T\n", stop)
		}
	}()
	secrets := [7]string{}
	for i := range secrets {
		if secrets[i], err = test.RandomSecret(); err != nil {
			return 0, err
		}
	}
	passwords = offline.Passwords{
		Data: secrets[0], Identity: secrets[1], Authority: secrets[2], Sync: secrets[3],
		Migration: secrets[4], Bootstrap: secrets[5], Outbox: secrets[6],
	}
	admin = offline.Connection{
		Host: cluster.Host(), Port: cluster.Port(),
		Username: test.Superuser(), Password: cluster.SuperuserPassword(),
		Database: databaseName, TLS: database.TLSDisabled,
	}
	if err := offline.CreateDatabase(ctx, admin, databaseName); err != nil {
		return 0, err
	}
	if err := offline.Provision(ctx, admin, passwords); err != nil {
		return 0, err
	}
	if expected, err = readExpectedGrants(); err != nil {
		return 0, err
	}
	pools = database.Pools{}
	for _, purpose := range runtimeLogins {
		pool, err := openPool(ctx, purpose, cluster.Address())
		if err != nil {
			return 0, err
		}
		pools[purpose] = pool
	}
	defer pools.Close()
	return m.Run(), nil
}

func readExpectedGrants() (map[database.Purpose][]string, error) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "contract", "privileges.json"))
	if err != nil {
		return nil, err
	}
	var contract struct {
		ApplicationPrivileges map[database.Purpose][]string `json:"applicationPrivileges"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		return nil, err
	}
	return contract.ApplicationPrivileges, nil
}

func passwordOf(purpose database.Purpose) string {
	switch purpose {
	case database.PurposeData:
		return passwords.Data
	case database.PurposeIdentity:
		return passwords.Identity
	case database.PurposeAuthority:
		return passwords.Authority
	case database.PurposeSync:
		return passwords.Sync
	case database.PurposeBootstrap:
		return passwords.Bootstrap
	case database.PurposeOutbox:
		return passwords.Outbox
	default:
		return ""
	}
}

func loginURL(purpose database.Purpose, address string) string {
	return "postgres://product_" + string(purpose) + ":" + passwordOf(purpose) + "@" + address + "/" + databaseName
}

func openPool(ctx context.Context, purpose database.Purpose, address string) (*pgxpool.Pool, error) {
	config, err := database.NewPoolConfig(purpose, loginURL(purpose, address), database.TLSDisabled)
	if err != nil {
		return nil, err
	}
	return database.NewPool(ctx, config)
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

// asSuperuser runs fixtures through the simple protocol, so one string may hold several statements.
func asSuperuser(t *testing.T, statements ...string) {
	t.Helper()
	if err := trySuperuser(testContext(t), statements...); err != nil {
		t.Fatalf("fixture failed: %s: %v", strings.Join(statements, "; "), err)
	}
}

func trySuperuser(ctx context.Context, statements ...string) (err error) {
	conn, err := cluster.ConnectSuperuser(ctx, databaseName)
	if err != nil {
		return err
	}
	defer func() {
		if closing := conn.Close(ctx); err == nil {
			err = closing
		}
	}()
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

// querySuperuser reads one text value.
func querySuperuser(t *testing.T, sql string, args ...any) string {
	t.Helper()
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
	var value string
	if err := conn.QueryRow(ctx, sql, args...).Scan(&value); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return value
}

func newRunner(t *testing.T, options database.RunnerOptions) *database.Runner {
	t.Helper()
	runner, err := database.NewRunner(pools, options)
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func revision(t *testing.T) string {
	t.Helper()
	return querySuperuser(t, "SELECT revision::text FROM authz_state")
}
