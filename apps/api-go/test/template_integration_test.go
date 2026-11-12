//go:build integration

package test_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

func TestOpeningPoolsOutlastsAServerThatAnswersLate(t *testing.T) {
	stack := test.NewDatabase(t)
	proxy, err := test.StartWireProxy(stack.Cluster.Address())
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := proxy.Close(); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	url := strings.Replace(stack.LoginURL("data"), stack.Cluster.Address(), proxy.Address(), 1)
	proxy.Hold()
	released := time.AfterFunc(3*time.Second, proxy.Release)
	defer released.Stop()
	logs := &countedLogs{TB: t}
	pools, err := test.OpenPoolsWaiting(t.Context(), logs, map[database.Purpose]string{database.PurposeData: url})
	if err != nil {
		t.Fatalf("%v", err)
	}
	pools.Close()
	if len(logs.lines) == 0 || !strings.Contains(logs.lines[0], "deadline") {
		t.Errorf("%q", logs.lines)
	}
}

func TestEveryPackageOfARunnerRunClonesOneTemplate(t *testing.T) {
	ctx := t.Context()
	postgres, err := test.StartPostgres(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := postgres.Stop(context.WithoutCancel(ctx)); err != nil {
			t.Error(err)
		}
	})
	super, err := postgres.ConnectSuperuser(ctx, "postgres")
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := super.Close(context.WithoutCancel(ctx)); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := super.Exec(ctx, "CREATE DATABASE tpl_fixture_building"); err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Setenv(test.RunnerCluster, postgres.SuperuserURL("postgres"))
	var templates []string
	for _, name := range []string{"first_package", "second_package"} {
		url, err := test.AttachAndClone(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		login, err := pgx.Connect(ctx, url)
		if err != nil {
			t.Fatalf("%s: %s", name, test.Redact(err))
		}
		var rows int
		err = login.QueryRow(ctx, "SELECT count(*) FROM work_calendar").Scan(&rows)
		if closed := login.Close(ctx); err != nil || closed != nil {
			t.Fatalf("%s: %s %v", name, test.Redact(err), closed)
		}
		var template string
		if err := super.QueryRow(ctx, "SELECT string_agg(oid::text||':'||datname, ',' ORDER BY datname) FROM pg_database WHERE datname LIKE 'tpl_fixture%'").Scan(&template); err != nil {
			t.Fatal(test.Redact(err))
		}
		templates = append(templates, template)
	}
	if templates[0] != templates[1] || strings.Contains(templates[0], ",") || !strings.HasSuffix(templates[0], ":tpl_fixture") {
		t.Errorf("%q", templates)
	}
}
