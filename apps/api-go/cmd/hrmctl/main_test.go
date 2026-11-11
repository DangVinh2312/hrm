package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"hrm/api-go/internal/database"
)

func TestAnUnknownNodeEnvIsRefusedBeforeConnecting(t *testing.T) {
	env := map[string]string{
		"DATABASE_ADMIN_URL":             "postgres://nobody:secret@127.0.0.1:1/postgres",
		"PRODUCT_DATABASE_NAME":          "hrm",
		"PRODUCT_MIGRATION_DATABASE_URL": "postgres://nobody:secret@127.0.0.1:1/hrm",
	}
	for _, value := range []string{"Production", "staging", "production "} {
		for _, command := range []string{"provision", "migrate"} {
			t.Run(command+" "+value, func(t *testing.T) {
				env["NODE_ENV"] = value
				err := run(context.Background(), []string{command}, func(name string) string { return env[name] }, io.Discard)
				var usage *usageError
				if !errors.As(err, &usage) || !strings.Contains(usage.message, "NODE_ENV") {
					t.Fatalf("got %v", err)
				}
			})
		}
	}
}

func TestAnUnsetOrKnownNodeEnvGoesOnToConnect(t *testing.T) {
	env := map[string]string{
		"DATABASE_ADMIN_URL":    "postgres://nobody:secret@127.0.0.1:1/postgres",
		"PRODUCT_DATABASE_NAME": "hrm",
	}
	for _, value := range []string{"", "development", "test", "production"} {
		env["NODE_ENV"] = value
		err := run(context.Background(), []string{"provision"}, func(name string) string { return env[name] }, io.Discard)
		var usage *usageError
		if err == nil || errors.As(err, &usage) {
			t.Errorf("%q: got %v, want a connection failure", value, err)
		}
	}
}

func TestPGSSLModeOutsideProduction(t *testing.T) {
	const refused = database.TLSMode(-1)
	for _, tc := range []struct {
		nodeEnv, sslMode string
		want             database.TLSMode
	}{
		{"", "", database.TLSDisabled},
		{"", "disable", database.TLSDisabled},
		{"development", "disable", database.TLSDisabled},
		{"test", "", database.TLSDisabled},
		{"", "prefer", database.TLSVerifyFull},
		{"", "require", database.TLSVerifyFull},
		{"development", "verify-ca", database.TLSVerifyFull},
		{"test", "verify-full", database.TLSVerifyFull},
		{"", "no-verify", refused},
		{"test", "allow", refused},
		{"", "Require", refused},
		{"production", "", database.TLSVerifyFull},
		{"production", "disable", database.TLSVerifyFull},
		{"production", "no-verify", database.TLSVerifyFull},
	} {
		t.Run(tc.nodeEnv+"/"+tc.sslMode, func(t *testing.T) {
			env := map[string]string{"NODE_ENV": tc.nodeEnv, "PGSSLMODE": tc.sslMode}
			got, err := tlsMode(func(name string) string { return env[name] })
			var usage *usageError
			if tc.want == refused {
				if !errors.As(err, &usage) || !strings.Contains(usage.message, "PGSSLMODE") {
					t.Fatalf("got %v, %v, want a refusal", got, err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %v, %v, want %v", got, err, tc.want)
			}
		})
	}
}
