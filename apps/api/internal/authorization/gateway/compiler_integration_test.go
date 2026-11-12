//go:build integration

package gateway_test

import (
	"context"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/gateway"
	"hrm/api/internal/database"
	"hrm/api/test"
)

func TestSQLCompilerMatchesEvaluatorAndGatewayOnPostgreSQL(t *testing.T) {
	s := test.NewDatabase(t)
	fixture := buildProductFixture()
	superConn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	seedProduct(t, t.Context(), superConn, fixture)
	if err := superConn.Close(t.Context()); err != nil {
		t.Fatal(test.Redact(err))
	}

	bindings, err := compiler.NewRegistry(integrationCore, fixtureDeclarations(t), fullStorageBindings())
	if err != nil {
		t.Fatal(err)
	}
	gw, err := gateway.New(bindings)
	if err != nil {
		t.Fatal(err)
	}

	dataPool := s.Pools[database.PurposeData]

	sqlIDs := func(t *testing.T, plan *core.AuthorizedPlan) []string {
		t.Helper()
		bound, err := compiler.CompilePlan(plan, bindings)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := dataPool.Query(
			t.Context(),
			`SELECT r.id::text FROM submission r WHERE `+bound.SQL+` ORDER BY r.id`,
			queryParams(bound.Parameters)...,
		)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		return ids
	}

	evaluatorIDs := func(t *testing.T, plan *core.AuthorizedPlan) []string {
		t.Helper()
		nowTS, err := integrationCore.CanonicalTimestamp(time.Now().UTC().Format("2006-01-02T15:04:05.000000Z"))
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, 0)
		for _, row := range fixture.submissions {
			if integrationCore.Evaluate(plan, submissionFacts(fixture, row, nowTS)).Allowed() {
				ids = append(ids, row.id)
			}
		}
		slices.SortFunc(ids, compareBigIntStrings)
		return ids
	}

	const readPerm = "submission.read"
	meSubj := &core.RuleSubject{Kind: core.SubjectIdentity, Identity: alice}
	mgrSubj := &core.RuleSubject{Kind: core.SubjectRole, Role: "custom.manager"}
	carolSubj := &core.RuleSubject{Kind: core.SubjectIdentity, Identity: carol}

	scenarios := []struct {
		name     string
		rules    []core.RuleFact
		roles    []string
		hasRoles bool
		identity core.IdentityID
		action   string
		expected []string
	}{
		{
			name:     "ReBAC identity edge (assignedToMe) + exceptions",
			rules:    []core.RuleFact{makeRule(readPerm, core.EffectAllow, "assignedToMe", nil, nil)},
			expected: []string{"1", "2", "8"},
		},
		{
			name:     "ReBAC two-step path with domain table (managedSite)",
			rules:    []core.RuleFact{makeRule(readPerm, core.EffectAllow, "managedSite", nil, mgrSubj)},
			roles:    []string{"custom.manager"},
			hasRoles: true,
			expected: []string{"1", "2", "5"},
		},
		{
			name:     "many-to-many path (carol manages both sites)",
			rules:    []core.RuleFact{makeRule(readPerm, core.EffectAllow, "managedSite", nil, carolSubj)},
			roles:    []string{},
			hasRoles: true,
			identity: carol,
		},
		{
			name:  "exact decimal lte",
			rules: []core.RuleFact{makeRule(readPerm, core.EffectAllow, "amountAtMost", map[string]core.Scalar{"limit": core.Text("100.1")}, nil)},
		},
		{
			name:  "integer lt with nulls never matching",
			rules: []core.RuleFact{makeRule(readPerm, core.EffectAllow, "priorityBelow", map[string]core.Scalar{"limit": core.Text("3")}, nil)},
		},
		{
			name:  "isNull",
			rules: []core.RuleFact{makeRule(readPerm, core.EffectAllow, "untitled", nil, nil)},
		},
		{
			name:     "UTF-8 exact equality",
			rules:    []core.RuleFact{makeRule(readPerm, core.EffectAllow, "titleIs", map[string]core.Scalar{"title": core.Text(angstromUpper)}, nil)},
			expected: []string{"2", "8"},
		},
		{
			name:  "code point ordering for strings",
			rules: []core.RuleFact{makeRule(readPerm, core.EffectAllow, "titleBefore", map[string]core.Scalar{"title": core.Text("Zeta")}, nil)},
		},
		{
			name:  "microsecond timestamp ordering",
			rules: []core.RuleFact{makeRule(readPerm, core.EffectAllow, "submittedBefore", map[string]core.Scalar{"at": core.Text("2025-06-01T12:00:00.123457Z")}, nil)},
		},
		{
			name:  "boolean literal",
			rules: []core.RuleFact{makeRule(readPerm, core.EffectAllow, "notArchived", nil, nil)},
		},
		{
			name:  "or inside a grant",
			rules: []core.RuleFact{makeRule(readPerm, core.EffectAllow, "pendingOrCheap", nil, nil)},
		},
		{
			name: "personal deny wins (NOT)",
			rules: []core.RuleFact{
				makeRule(readPerm, core.EffectAllow, "all", nil, nil),
				makeRule(readPerm, core.EffectDeny, "statusIs", map[string]core.Scalar{"status": core.Text("rejected")}, meSubj),
			},
		},
		{
			name: "deny through a relation (NOT EXISTS)",
			rules: []core.RuleFact{
				makeRule(readPerm, core.EffectAllow, "all", nil, nil),
				makeRule(readPerm, core.EffectDeny, "assignedToMe", nil, meSubj),
			},
		},
		{
			name: "deny with explicit null branch",
			rules: []core.RuleFact{
				makeRule(readPerm, core.EffectAllow, "all", nil, nil),
				makeRule(readPerm, core.EffectDeny, "untitled", nil, nil),
			},
		},
		{
			name:     "no grant: only valid record allows",
			rules:    []core.RuleFact{},
			expected: []string{"2", "8"},
		},
		{
			name:     "injection string is a bound value",
			rules:    []core.RuleFact{makeRule(readPerm, core.EffectAllow, "titleIs", map[string]core.Scalar{"title": core.Text("'; DROP TABLE submission; --")}, nil)},
			expected: []string{"2", "5", "8"},
		},
		{
			name:   "required scope outside record allow (approve)",
			rules:  []core.RuleFact{makeRule("submission.approve", core.EffectAllow, "all", nil, nil)},
			action: "approve",
		},
	}

	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			plan := readPlan(t, sc.rules, planOptions{
				roles:    sc.roles,
				hasRoles: sc.hasRoles,
				identity: sc.identity,
				action:   sc.action,
			})
			fromSQL := sqlIDs(t, plan)
			bound, err := compiler.CompilePlanAt(plan, bindings, "s", 3)
			if err != nil {
				t.Fatal(err)
			}
			args := append([]any{"prefix", int64(7)}, queryParams(bound.Parameters)...)
			rows, err := dataPool.Query(t.Context(), `SELECT s.id::text FROM submission s WHERE CAST($1 AS text) = 'prefix' AND CAST($2 AS int8) = 7 AND (`+bound.SQL+`) ORDER BY s.id`, args...)
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			shifted, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			if !slices.Equal(shifted, fromSQL) {
				t.Fatalf("CompilePlanAt %v != CompilePlan %v", shifted, fromSQL)
			}
			fromEval := evaluatorIDs(t, plan)
			if !slices.Equal(fromSQL, fromEval) {
				t.Fatalf("SQL %v != evaluator %v", fromSQL, fromEval)
			}
			if sc.expected != nil && !slices.Equal(fromSQL, sc.expected) {
				t.Fatalf("SQL %v != expected %v", fromSQL, sc.expected)
			}
		})
	}

	t.Run("required scope excludes a record allow on a non-pending record", func(t *testing.T) {
		ids := sqlIDs(t, readPlan(t, nil, planOptions{action: "approve"}))
		if len(ids) != 0 {
			t.Fatalf("expected [], got %v", ids)
		}
	})

	t.Run("values never appear in SQL text; the injection target table survives", func(t *testing.T) {
		plan := readPlan(t, []core.RuleFact{
			makeRule(readPerm, core.EffectAllow, "titleIs", map[string]core.Scalar{"title": core.Text("'; DROP TABLE submission; --")}, nil),
		}, planOptions{})
		bound, err := compiler.CompilePlan(plan, bindings)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"DROP", "Reilly", "reviewer", "submission.read"} {
			if strings.Contains(bound.SQL, forbidden) {
				t.Fatalf("SQL contains %q: %s", forbidden, bound.SQL)
			}
		}
		_ = sqlIDs(t, plan)
		var count string
		if err := dataPool.QueryRow(t.Context(), `SELECT count(*)::text FROM submission`).Scan(&count); err != nil {
			t.Fatal(test.Redact(err))
		}
		if count != strconv.Itoa(len(fixture.submissions)) {
			t.Fatalf("count = %s, want %d", count, len(fixture.submissions))
		}
	})

	t.Run("an expired plan selects nothing (checked with the database statement clock)", func(t *testing.T) {
		until := time.Now().UTC().Add(300 * time.Millisecond).Format("2006-01-02T15:04:05.000000Z")
		plan := readPlan(t, []core.RuleFact{makeRule(readPerm, core.EffectAllow, "all", nil, nil)}, planOptions{
			validUntil: until,
		})
		time.Sleep(1500 * time.Millisecond)
		if ids := sqlIDs(t, plan); len(ids) != 0 {
			t.Fatalf("expected [], got %v", ids)
		}
	})

	t.Run("ReBAC on a uuid-keyed resource (mySites)", func(t *testing.T) {
		bobSubj := &core.RuleSubject{Kind: core.SubjectIdentity, Identity: bob}
		plan := readPlan(t, []core.RuleFact{makeRule("site.read", core.EffectAllow, "mySites", nil, bobSubj)}, planOptions{
			resource: "site",
			identity: bob,
			roles:    []string{},
			hasRoles: true,
		})
		bound, err := compiler.CompilePlan(plan, bindings)
		if err != nil {
			t.Fatal(err)
		}
		rows, err := dataPool.Query(t.Context(), `SELECT r.id::text FROM site r WHERE `+bound.SQL, queryParams(bound.Parameters)...)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		if !slices.Equal(ids, []string{"5e0c2f1e-3b7a-4c1d-9f0e-1a2b3c4d5e6f"}) {
			t.Fatalf("got %v", ids)
		}
	})

	t.Run("EXPLAIN: native PK lookups keep their indexes (no cast on the key column)", func(t *testing.T) {
		cases := []struct {
			table, key, pgType, value, resource, template, index string
		}{
			{"submission", "id", "int8", "9007199254740992", "submission", "all", "submission_pkey"},
			{"site", "id", "uuid", "d97eecc9-8f23-4a76-a9aa-82b9d4ef33ac", "site", "allSites", "site_pkey"},
			{"tag", "code", "text", "plain", "tag", "allTags", "tag_pkey"},
		}
		tx, err := dataPool.Begin(t.Context())
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		defer func() {
			if rbErr := tx.Rollback(t.Context()); rbErr != nil {
				t.Error(test.Redact(rbErr))
			}
		}()
		if _, err := tx.Exec(t.Context(), `SET LOCAL enable_seqscan = off`); err != nil {
			t.Fatal(test.Redact(err))
		}
		for _, c := range cases {
			plan := readPlan(t, []core.RuleFact{makeRule(c.resource+".read", core.EffectAllow, c.template, nil, nil)}, planOptions{
				resource: c.resource,
			})
			bound, err := compiler.CompilePlan(plan, bindings)
			if err != nil {
				t.Fatal(err)
			}
			args := append(queryParams(bound.Parameters), c.value)
			sql := `EXPLAIN SELECT 1 FROM ` + c.table + ` r WHERE ` + bound.SQL +
				` AND r.` + c.key + ` = CAST($` + strconv.Itoa(len(args)) + ` AS ` + c.pgType + `)`
			rows, err := tx.Query(t.Context(), sql, args...)
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			lines, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			text := strings.Join(lines, "\n")
			re := regexp.MustCompile(`Index (Only )?Scan using ` + regexp.QuoteMeta(c.index))
			if !re.MatchString(text) {
				t.Fatalf("expected index scan on %s, got:\n%s", c.index, text)
			}
		}
	})

	t.Run("gateway List, Count and Detail enforce authorization, pagination and OR filter parenthesization", func(t *testing.T) {
		_, err := database.Run(t.Context(), s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			plan := readPlan(t, []core.RuleFact{makeRule(readPerm, core.EffectAllow, "assignedToMe", nil, nil)}, planOptions{
				revision: tx.Revision,
			})
			page, err := gw.List(plan, gateway.ListQuery{}, tx)
			if err != nil {
				t.Fatal(err)
			}
			gotKeys := make([]string, len(page.Items))
			for i, item := range page.Items {
				gotKeys[i], _ = item["key"].AsText()
				if _, leaked := item["internal_note"]; leaked {
					t.Fatal("unprojected column internal_note leaked")
				}
			}
			if !slices.Equal(gotKeys, []string{"1", "2", "8"}) || page.Total != "3" {
				t.Fatalf("page keys=%v total=%s, want [1 2 8] total=3", gotKeys, page.Total)
			}
			pastEnd, err := gw.List(plan, gateway.ListQuery{Limit: gateway.Limit(2), Offset: 10}, tx)
			if err != nil {
				t.Fatal(err)
			}
			if len(pastEnd.Items) != 0 || pastEnd.Items == nil || pastEnd.Total != "3" {
				t.Fatalf("past-end page items=%#v total=%s, want [] total=3", pastEnd.Items, pastEnd.Total)
			}
			// OR filter must stay within authorized rows [1, 2, 8], never leaking row 5 (rejected).
			orFilter := gateway.LogicalFilter{
				Op: core.OpOr,
				Args: []gateway.Filter{
					gateway.CompareFilter{Op: core.OpEq, Field: "status", Value: core.TextValue("pending")},
					gateway.CompareFilter{Op: core.OpEq, Field: "status", Value: core.TextValue("rejected")},
				},
			}
			orPage, err := gw.List(plan, gateway.ListQuery{Filter: orFilter}, tx)
			if err != nil {
				t.Fatal(err)
			}
			if len(orPage.Items) != 1 || orPage.Total != "1" {
				t.Fatalf("OR filter leaked rows: %#v", orPage)
			}
			if k, _ := orPage.Items[0]["key"].AsText(); k != "1" {
				t.Fatalf("expected key 1, got %q", k)
			}
			cnt, err := gw.Count(plan, gateway.CountQuery{Filter: orFilter}, tx)
			if err != nil || cnt != "1" {
				t.Fatalf("Count = %q, %v", cnt, err)
			}
			row1, err := gw.Detail(plan, core.Key{Kind: core.KeyInteger, Value: "1"}, tx)
			if err != nil || row1 == nil {
				t.Fatalf("Detail(1) = %v, %v", row1, err)
			}
			// Row 5 is unauthorized for alice -> nil, nil (same as absent row 999).
			for _, hiddenKey := range []string{"5", "999"} {
				row, err := gw.Detail(plan, core.Key{Kind: core.KeyInteger, Value: hiddenKey}, tx)
				if err != nil || row != nil {
					t.Fatalf("Detail(%s) = %v, %v", hiddenKey, row, err)
				}
			}
			return struct{}{}, nil
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
	})

	t.Run("gateway sorts with a native key tie-breaker and reads UUID and string keys", func(t *testing.T) {
		_, err := database.Run(t.Context(), s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			plan := readPlan(t, []core.RuleFact{makeRule(readPerm, core.EffectAllow, "all", nil, nil)}, planOptions{revision: tx.Revision})
			for _, direction := range []gateway.SortDirection{gateway.SortAsc, gateway.SortDesc} {
				page, err := gw.List(plan, gateway.ListQuery{OrderBy: "amount", Direction: direction}, tx)
				if err != nil {
					t.Fatal(test.Redact(err))
				}
				keys := make([]string, len(page.Items))
				for i, item := range page.Items {
					keys[i], _ = item["key"].AsText()
				}
				want := []string{"5", "8", "7", "1", "2", "6", "9007199254740992"}
				if direction == gateway.SortDesc {
					slices.Reverse(want)
				}
				if !slices.Equal(keys, want) || page.Total != strconv.Itoa(len(want)) {
					t.Fatalf("direction %s: keys=%v total=%s, want %v", direction, keys, page.Total, want)
				}
			}
			for _, tc := range []struct {
				resource, template string
				key                core.Key
			}{
				{"site", "allSites", core.Key{Kind: core.KeyUUID, Value: "d97eecc9-8f23-4a76-a9aa-82b9d4ef33ac"}},
				{"tag", "allTags", core.Key{Kind: core.KeyString, Value: "plain"}},
			} {
				keyPlan := readPlan(t, []core.RuleFact{makeRule(tc.resource+".read", core.EffectAllow, tc.template, nil, nil)}, planOptions{resource: tc.resource, revision: tx.Revision})
				row, err := gw.Detail(keyPlan, tc.key, tx)
				if err != nil || row == nil {
					t.Fatalf("Detail(%s) returned nil=%v, error=%v", tc.resource, row == nil, test.Redact(err))
				}
				if got, _ := row["key"].AsText(); got != tc.key.Value {
					t.Fatalf("Detail(%s) key=%q, want %q", tc.resource, got, tc.key.Value)
				}
			}
			return struct{}{}, nil
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
	})
}
