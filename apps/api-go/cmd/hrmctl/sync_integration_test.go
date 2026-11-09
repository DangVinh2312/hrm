//go:build integration

package main

import (
	"context"
	"testing"

	"hrm/api-go/test"
)

func TestSyncCommandUsesRuntimeCredentialsAndDoesNotRepublishSameRelease(t *testing.T) {
	s := test.NewDatabase(t)
	env := map[string]string{"NODE_ENV": "test", "PGSSLMODE": "disable",
		"PRODUCT_DATA_DATABASE_URL": s.LoginURL("data"), "PRODUCT_IDENTITY_DATABASE_URL": s.LoginURL("identity"),
		"PRODUCT_AUTHORITY_DATABASE_URL": s.LoginURL("authority"), "PRODUCT_SYNC_DATABASE_URL": s.LoginURL("sync"),
	}
	connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	var before, after string
	if err := connection.QueryRow(t.Context(), "SELECT revision::text FROM authz_state WHERE singleton").Scan(&before); err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := run(t.Context(), []string{"sync"}, func(name string) string { return env[name] }); err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := connection.QueryRow(t.Context(), "SELECT revision::text FROM authz_state WHERE singleton").Scan(&after); err != nil {
		t.Fatal(test.Redact(err))
	}
	if before != after {
		t.Fatal("sync command republished unchanged release")
	}
}
