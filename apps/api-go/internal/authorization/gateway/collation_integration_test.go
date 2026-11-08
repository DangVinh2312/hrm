//go:build integration

package gateway_test

import (
	"context"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/offline"
	"hrm/api-go/test"
)

func extractLoginPassword(t *testing.T, s *test.Stack, login string) string {
	t.Helper()
	parsed, err := url.Parse(s.LoginURL(login))
	if err != nil {
		t.Fatal(err)
	}
	pw, ok := parsed.User.Password()
	if !ok {
		t.Fatalf("missing password for %s", login)
	}
	return pw
}

func TestStringOrderingIsIndependentOfDatabaseCollation(t *testing.T) {
	s := test.NewDatabase(t)
	ctx := t.Context()

	const icuDB = "icu_product"
	pgConn, err := s.Cluster.ConnectSuperuser(ctx, "postgres")
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := pgConn.Exec(ctx, `DROP DATABASE IF EXISTS `+icuDB+` WITH (FORCE)`); err != nil {
		if closeErr := pgConn.Close(ctx); closeErr != nil {
			t.Error(test.Redact(closeErr))
		}
		t.Fatal(test.Redact(err))
	}
	if _, err := pgConn.Exec(
		ctx,
		`CREATE DATABASE `+icuDB+` TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'und' LOCALE 'C.UTF-8'`,
	); err != nil {
		if closeErr := pgConn.Close(ctx); closeErr != nil {
			t.Error(test.Redact(closeErr))
		}
		t.Fatal(test.Redact(err))
	}
	if err := pgConn.Close(ctx); err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		cleanCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if c, err := s.Cluster.ConnectSuperuser(cleanCtx, "postgres"); err == nil {
			if _, dropErr := c.Exec(cleanCtx, `DROP DATABASE IF EXISTS `+icuDB+` WITH (FORCE)`); dropErr != nil {
				t.Error(test.Redact(dropErr))
			}
			if closeErr := c.Close(cleanCtx); closeErr != nil {
				t.Error(test.Redact(closeErr))
			}
		}
	})

	admin := offline.Connection{
		Host:     s.Cluster.Host(),
		Port:     s.Cluster.Port(),
		Username: test.Superuser(),
		Password: s.Cluster.SuperuserPassword(),
		Database: icuDB,
		TLS:      database.TLSDisabled,
	}
	passwords := offline.Passwords{
		Data:      extractLoginPassword(t, s, "data"),
		Identity:  extractLoginPassword(t, s, "identity"),
		Authority: extractLoginPassword(t, s, "authority"),
		Sync:      extractLoginPassword(t, s, "sync"),
		Migration: extractLoginPassword(t, s, "migration"),
		Bootstrap: extractLoginPassword(t, s, "bootstrap"),
		Outbox:    extractLoginPassword(t, s, "outbox"),
	}
	if err := offline.Provision(ctx, admin, passwords); err != nil {
		t.Fatal(test.Redact(err))
	}

	fixture := buildProductFixture()
	icuSuper, err := s.Cluster.ConnectSuperuser(ctx, icuDB)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	seedProduct(t, ctx, icuSuper, fixture)
	if err := icuSuper.Close(ctx); err != nil {
		t.Fatal(test.Redact(err))
	}

	dataCfg, err := database.NewPoolConfig(
		database.PurposeData,
		s.Cluster.LoginURL("product_data", passwords.Data, icuDB),
		database.TLSDisabled,
	)
	if err != nil {
		t.Fatal(err)
	}
	dataPool, err := database.NewPool(ctx, dataCfg)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(dataPool.Close)

	t.Run("the database default collation really orders differently from code points", func(t *testing.T) {
		var icuOrder, cOrder bool
		err := dataPool.QueryRow(ctx, `SELECT 'Zeta' < 'a' AS icu, 'Zeta' < 'a' COLLATE "C" AS c`).Scan(&icuOrder, &cOrder)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		if icuOrder || !cOrder {
			t.Fatalf("expected icu=false c=true, got icu=%v c=%v", icuOrder, cOrder)
		}
	})

	bindings, err := compiler.NewRegistry(integrationCore, fixtureDeclarations(t), fullStorageBindings())
	if err != nil {
		t.Fatal(err)
	}

	for _, bound := range []string{"a", "Zeta", angstromLower} {
		t.Run("lt on strings matches the evaluator (bound "+bound+")", func(t *testing.T) {
			authorized := readPlan(t, []core.RuleFact{
				makeRule("submission.read", core.EffectAllow, "titleBefore", map[string]core.Scalar{"title": core.Text(bound)}, nil),
			}, planOptions{})
			compiled, err := compiler.CompilePlan(authorized, bindings)
			if err != nil {
				t.Fatal(err)
			}
			rows, err := dataPool.Query(
				ctx,
				`SELECT r.id::text FROM submission r WHERE `+compiled.SQL+` ORDER BY r.id`,
				queryParams(compiled.Parameters)...,
			)
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			sqlIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			nowTS, err := integrationCore.CanonicalTimestamp(time.Now().UTC().Format("2006-01-02T15:04:05.000000Z"))
			if err != nil {
				t.Fatal(err)
			}
			expected := make([]string, 0)
			for _, row := range fixture.submissions {
				if integrationCore.Evaluate(authorized, submissionFacts(fixture, row, nowTS)).Allowed() {
					expected = append(expected, row.id)
				}
			}
			slices.SortFunc(expected, compareBigIntStrings)
			if !slices.Equal(sqlIDs, expected) {
				t.Fatalf("bound %q: SQL %v != evaluator %v", bound, sqlIDs, expected)
			}
		})
	}
}
