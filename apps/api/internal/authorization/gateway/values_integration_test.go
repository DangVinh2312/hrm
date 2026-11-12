//go:build integration

package gateway_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/gateway"
	"hrm/api/internal/authorization/values"
	"hrm/api/internal/database"
	"hrm/api/test"
)

const (
	eventCutoff     = "2026-10-14T12:00:00.123456Z"
	eventDenyBefore = "2026-10-14T12:00:00.000002Z"
	eventUserID     = core.IdentityID("f0000000-0000-4000-8000-000000000001")
)

type eventFixtureRow struct {
	key        string
	objectID   string
	occurredAt string
	edge       string
}

func eventRows() []eventFixtureRow {
	raw := []struct{ key, occurredAt, edge string }{
		{"1", "2026-10-14T12:00:00.000001Z", "live"},
		{"2", "2026-10-14T12:00:00.000002Z", "live"},
		{"3", "2026-10-14T12:00:00.123456Z", "live"},
		{"4", "2026-10-14T12:00:00.123457Z", "live"},
		{"5", "2024-02-29T23:59:59.999999Z", "live"},
		{"6", "2026-10-14T12:00:00.1Z", "expired"},
		{"7", "2026-10-14T12:00:00.05Z", "live"},
	}
	out := make([]eventFixtureRow, len(raw))
	for i, r := range raw {
		out[i] = eventFixtureRow{
			key:        r.key,
			objectID:   fmt.Sprintf("f1000000-0000-4000-8000-%012d", i+1),
			occurredAt: r.occurredAt,
			edge:       r.edge,
		}
	}
	return out
}

func eventDeclarationsSource(policyLiteral string) core.SystemDeclarations {
	windowRef := core.RelationRef{Key: "window", Version: 1}
	cutoffScope := core.CompareExpr{
		Op:    core.OpLt,
		Field: "occurredAt",
		Value: core.ValueRef{From: core.SourceLiteral, Literal: core.TextValue(eventCutoff)},
	}
	return core.SystemDeclarations{
		Resources: []core.ResourceDeclaration{
			{
				Key:     "event",
				KeyKind: core.KeyInteger,
				Fields: map[string]core.FieldType{
					"occurredAt": {Kind: core.FieldTimestamp},
					"status":     {Kind: core.FieldString},
				},
				Actions: map[string]core.ActionDeclaration{
					"read":   {Policy: windowRef, Boundary: core.BoundaryRequired},
					"update": {Policy: windowRef, Boundary: core.BoundaryRequired},
				},
			},
		},
		Relations: []core.RelationDeclaration{
			{
				Key:        "event.assignee",
				Version:    1,
				SourceType: "event",
				Target:     core.RelationTarget{Kind: core.RelationTargetIdentity},
				Binding:    core.RelationBinding{Kind: core.BindingEdgeStore},
			},
		},
		Policies: []core.PermissionPolicy{
			{
				Key:                 "window",
				Version:             1,
				ContextRequirements: []core.ContextRequirement{},
				Obligations:         []core.Obligation{},
				RequiredScope: core.CompareExpr{
					Op:    core.OpLte,
					Field: "occurredAt",
					Value: core.ValueRef{From: core.SourceLiteral, Literal: core.TextValue(policyLiteral)},
				},
			},
		},
		Templates: []core.ScopeTemplate{
			{
				Key:        "assigned",
				Version:    1,
				Resource:   "event",
				Parameters: map[string]core.FieldKind{},
				Expression: core.ExistsExpr{
					Relation: "event.assignee@1",
					Where: core.CompareExpr{
						Op:    core.OpEq,
						Field: "identityId",
						Value: core.ValueRef{From: core.SourcePrincipal, Name: "id"},
					},
				},
			},
			{
				Key:        "before",
				Version:    1,
				Resource:   "event",
				Parameters: map[string]core.FieldKind{"at": core.FieldTimestamp},
				Expression: core.CompareExpr{
					Op:    core.OpLt,
					Field: "occurredAt",
					Value: core.ValueRef{From: core.SourceParameter, Name: "at"},
				},
			},
		},
		Boundaries: []core.PermissionBoundary{
			{
				Key:     "cutoff",
				Version: 1,
				Entries: []core.BoundaryEntry{
					{Permission: "event.read", ContextRequirements: []core.ContextRequirement{}, RequiredScope: cutoffScope},
					{Permission: "event.update", ContextRequirements: []core.ContextRequirement{}, RequiredScope: cutoffScope},
				},
			},
		},
		Capabilities: core.Capabilities{Validators: []string{}, ObligationHandlers: []string{}},
	}
}

func setupEventFixture(t *testing.T, s *test.Stack, c *core.Core) (*compiler.Registry, *gateway.Gateway, *core.ValidatedDeclarations, []eventFixtureRow) {
	t.Helper()
	ctx := t.Context()
	d, err := c.Validate(eventDeclarationsSource(eventCutoff))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pools[database.PurposeIdentity].Exec(
		ctx,
		`INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true) ON CONFLICT DO NOTHING`,
		string(eventUserID),
	); err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := s.Pools[database.PurposeSync].Exec(
		ctx,
		`INSERT INTO resource_type(type_key,key_kind,binding_key) VALUES($1,'integer',$1) ON CONFLICT DO NOTHING`,
		[]byte("event"),
	); err != nil {
		t.Fatal(test.Redact(err))
	}
	rows := eventRows()
	_, err = database.Run(ctx, s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		for _, row := range rows {
			if _, err := tx.Exec(
				`INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$2,'integer',$3)`,
				row.objectID, []byte("event"), []byte(row.key),
			); err != nil {
				return struct{}{}, err
			}
			edgeSQL := `INSERT INTO user_relation(relation_key,relation_version,object_id,user_id,starts_at,expires_at) VALUES($1,1,$2,$3,statement_timestamp()-interval '1 minute',statement_timestamp()+interval '1 hour')`
			if row.edge != "live" {
				edgeSQL = `INSERT INTO user_relation(relation_key,relation_version,object_id,user_id,starts_at,expires_at) VALUES($1,1,$2,$3,statement_timestamp()-interval '1 hour',statement_timestamp()-interval '1 second')`
			}
			if _, err := tx.Exec(edgeSQL, []byte("event.assignee"), row.objectID, string(eventUserID)); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	superConn, err := s.Cluster.ConnectSuperuser(ctx, s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	for _, stmt := range []string{
		`CREATE TABLE product_event(id bigint PRIMARY KEY,object_id uuid UNIQUE NOT NULL REFERENCES object_ref(object_id),occurred_at timestamptz(6) NOT NULL,status text NOT NULL)`,
		`GRANT SELECT,UPDATE ON product_event TO product_data`,
	} {
		if _, err := superConn.Exec(ctx, stmt); err != nil {
			if closeErr := superConn.Close(ctx); closeErr != nil {
				t.Error(test.Redact(closeErr))
			}
			t.Fatal(test.Redact(err))
		}
	}
	for _, row := range rows {
		if _, err := superConn.Exec(ctx, `INSERT INTO product_event VALUES($1,$2,$3::timestamptz,$4)`, row.key, row.objectID, row.occurredAt, "open"); err != nil {
			if closeErr := superConn.Close(ctx); closeErr != nil {
				t.Error(test.Redact(closeErr))
			}
			t.Fatal(test.Redact(err))
		}
	}
	if err := superConn.Close(ctx); err != nil {
		t.Fatal(test.Redact(err))
	}

	reg, err := compiler.NewRegistry(c, d, compiler.StorageBindings{
		Resources: []compiler.ResourceBinding{
			{
				Resource: "event", Table: "product_event", ObjectIDColumn: "object_id", KeyColumn: "id",
				Columns:    map[string]string{"occurredAt": "occurred_at", "status": "status"},
				Projection: []string{"occurredAt", "status"},
			},
		},
		Domains: map[string]compiler.DomainRelationBinding{},
	})
	if err != nil {
		t.Fatal(err)
	}
	gw, err := gateway.New(reg)
	if err != nil {
		t.Fatal(err)
	}
	return reg, gw, d, rows
}

func planEventRead(t *testing.T, c *core.Core, d *core.ValidatedDeclarations, tx *database.Tx) (*core.AuthorizedPlan, string) {
	t.Helper()
	const utcFmt = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`
	qRows, err := tx.Query(
		`SELECT to_char((statement_timestamp()) AT TIME ZONE 'UTC', ` + utcFmt + `), to_char((statement_timestamp()+interval '2 seconds') AT TIME ZONE 'UTC', ` + utcFmt + `)`,
	)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	type clockPair struct{ now, until string }
	clocks, err := pgx.CollectRows(qRows, func(r pgx.CollectableRow) (clockPair, error) {
		var cp clockPair
		err := r.Scan(&cp.now, &cp.until)
		return cp, err
	})
	if err != nil || len(clocks) == 0 {
		t.Fatal(test.Redact(err))
	}
	userSubj := core.RuleSubject{Kind: core.SubjectIdentity, Identity: eventUserID}
	snap := core.AuthoritySnapshot{
		Revision:     tx.Revision,
		Declarations: d,
		User:         &core.AuthorityUser{ID: eventUserID, State: core.UserActive},
		Roles:        []string{},
		Permissions: []core.PermissionFact{
			{
				Key:       "event.read",
				Resource:  "event",
				Action:    "read",
				Policy:    core.RelationRef{Key: "window", Version: 1},
				Boundary:  core.BoundaryRequired,
				Lifecycle: core.LifecycleActive,
			},
		},
		Rules: []core.RuleFact{
			{
				ID: "allow-assigned", Permission: "event.read", Subject: userSubj,
				Effect: core.EffectAllow, Template: core.RelationRef{Key: "assigned", Version: 1},
				Parameters: map[string]core.Scalar{},
			},
			{
				ID: "deny-before", Permission: "event.read", Subject: userSubj,
				Effect: core.EffectDeny, Template: core.RelationRef{Key: "before", Version: 1},
				Parameters: map[string]core.Scalar{"at": core.Text(eventDenyBefore)},
			},
		},
		Boundaries: []core.BoundaryBindingFact{
			{
				Identity:   eventUserID,
				Permission: "event.read",
				Boundary:   core.RelationRef{Key: "cutoff", Version: 1},
				Lifecycle:  core.LifecycleActive,
			},
		},
		Registry: core.Registry{Validators: map[string]core.ContextValidator{}, ObligationHandlers: []string{}},
	}
	decision := c.Plan(core.TrustedInput{
		Principal:  core.TrustedPrincipal{ID: eventUserID, Assurance: 1},
		Resource:   "event",
		Action:     "read",
		Context:    map[string]core.Scalar{},
		Now:        clocks[0].now,
		ValidUntil: clocks[0].until,
	}, snap)
	if !decision.Allowed() {
		t.Fatalf("event.read plan denied: %s", decision.Reason())
	}
	return decision.Plan(), clocks[0].now
}

func TestValuesParityAndInvalidTimestampsOnPostgreSQL(t *testing.T) {
	s := test.NewDatabase(t)
	_, gw, d, seededRows := setupEventFixture(t, s, integrationCore)

	t.Run("timestamp literal, parameter deny, boundary and expiry: SQL equals Evaluate on DB facts", func(t *testing.T) {
		_, err := database.Run(t.Context(), s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			plan, nowTS := planEventRead(t, integrationCore, d, tx)
			const utcFmt = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`
			sRows, err := tx.Query(
				`SELECT id::text, object_id::text, to_char((occurred_at) AT TIME ZONE 'UTC', ` + utcFmt + `) FROM product_event ORDER BY id`,
			)
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			type storedRow struct{ key, objectID, at string }
			stored, err := pgx.CollectRows(sRows, func(r pgx.CollectableRow) (storedRow, error) {
				var sr storedRow
				err := r.Scan(&sr.key, &sr.objectID, &sr.at)
				return sr, err
			})
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			for i, sr := range stored {
				want, err := integrationCore.CanonicalTimestamp(seededRows[i].occurredAt)
				if err != nil || sr.at != want {
					t.Fatalf("row %s: stored %q != canonical %q (%v)", sr.key, sr.at, want, err)
				}
			}

			eRows, err := tx.Query(
				`SELECT object_id::text, to_char((starts_at) AT TIME ZONE 'UTC', `+utcFmt+`), to_char((expires_at) AT TIME ZONE 'UTC', `+utcFmt+`) FROM user_relation WHERE relation_key=$1 AND user_id=$2`,
				[]byte("event.assignee"), string(eventUserID),
			)
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			edges, err := pgx.CollectRows(eRows, func(r pgx.CollectableRow) (core.EdgeFact, error) {
				var objID, starts string
				var expires *string
				err := r.Scan(&objID, &starts, &expires)
				return core.EdgeFact{
					Relation:  core.RelationRef{Key: "event.assignee", Version: 1},
					Source:    objID,
					Target:    core.EdgeTarget{Kind: core.EdgeTargetIdentity, Identity: eventUserID},
					StartsAt:  starts,
					ExpiresAt: expires,
				}, err
			})
			if err != nil {
				t.Fatal(test.Redact(err))
			}

			var expected []string
			for _, sr := range stored {
				parsedKey, err := integrationCore.ParseKey(core.KeyInteger, sr.key)
				if err != nil {
					t.Fatal(err)
				}
				rec := core.FactObject{
					Type:     "event",
					Key:      parsedKey,
					ObjectID: sr.objectID,
					Fields: map[string]core.FieldValue{
						"occurredAt": core.TextValue(sr.at),
						"status":     core.TextValue("open"),
					},
				}
				facts := core.CompleteFacts{
					Now:     nowTS,
					Record:  rec,
					Objects: []core.FactObject{rec},
					Edges:   edges,
				}
				if integrationCore.Evaluate(plan, facts).Allowed() {
					expected = append(expected, sr.key)
				}
			}
			if !slices.Equal(expected, []string{"2", "7"}) {
				t.Fatalf("expected [2 7], got %v", expected)
			}

			page, err := gw.List(plan, gateway.ListQuery{}, tx)
			if err != nil {
				t.Fatal(err)
			}
			gotKeys := make([]string, len(page.Items))
			for i, item := range page.Items {
				gotKeys[i], _ = item["key"].AsText()
			}
			if !slices.Equal(gotKeys, expected) {
				t.Fatalf("gateway.List keys %v != expected %v", gotKeys, expected)
			}
			cnt, err := gw.Count(plan, gateway.CountQuery{}, tx)
			if err != nil || cnt != strconv.Itoa(len(expected)) {
				t.Fatalf("gateway.Count = %q, %v", cnt, err)
			}

			atPage, err := gw.List(plan, gateway.ListQuery{
				Filter: gateway.CompareFilter{
					Op:    core.OpLte,
					Field: "occurredAt",
					Value: core.TextValue("2026-10-14T12:00:00.000002Z"),
				},
			}, tx)
			if err != nil {
				t.Fatal(err)
			}
			if len(atPage.Items) != 1 {
				t.Fatalf("expected 1 row from microsecond filter, got %#v", atPage.Items)
			}
			if k, _ := atPage.Items[0]["key"].AsText(); k != "2" {
				t.Fatalf("expected key 2, got %q", k)
			}

			// Detail for key '01': rejected by ParseKey (leading zero on integer key) before SQL.
			if _, err := gw.Detail(plan, core.Key{Kind: core.KeyInteger, Value: "01"}, tx); !errors.Is(err, apperror.ErrInvalidRequest) {
				t.Fatalf("expected ErrInvalidRequest for non-canonical integer key '01', got %v", err)
			}
			detail2, err := gw.Detail(plan, core.Key{Kind: core.KeyInteger, Value: "2"}, tx)
			if err != nil || detail2 == nil {
				t.Fatalf("Detail(2) = %v, %v", detail2, err)
			}
			if occ, _ := detail2["occurredAt"].AsText(); occ != "2026-10-14T12:00:00.000002Z" {
				t.Fatalf("Detail(2) occurredAt = %q", occ)
			}
			return struct{}{}, nil
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
	})

	t.Run("invalid timestamps are refused before any SQL is sent", func(t *testing.T) {
		proxy, err := test.StartWireProxy(s.Cluster.Address())
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		defer func() {
			if err := proxy.Close(); err != nil {
				t.Error(test.Redact(err))
			}
		}()
		loginURL := strings.Replace(s.LoginURL("data"), s.Cluster.Address(), proxy.Address(), 1)
		pools, err := database.OpenPools(t.Context(), map[database.Purpose]string{database.PurposeData: loginURL}, database.TLSDisabled)
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		defer pools.Close()
		runner, err := database.NewRunner(pools, database.RunnerOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		invalid := []string{
			"2026-02-30T00:00:00Z",
			"2026-10-14T24:00:00Z",
			"2026-06-30T23:59:60Z",
			"2026-10-14T12:00:00+07:00",
			"2026-10-14T12:00:00.1234567Z",
			"2026-10-14 12:00:00Z",
			"2026-10-14T12:00:00",
		}
		_, err = database.Run(t.Context(), runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			plan, _ := planEventRead(t, integrationCore, d, tx)
			proxy.Reset()
			for _, bad := range invalid {
				_, err := gw.List(plan, gateway.ListQuery{
					Filter: gateway.CompareFilter{
						Op:    core.OpLt,
						Field: "occurredAt",
						Value: core.TextValue(bad),
					},
				}, tx)
				if !errors.Is(err, apperror.ErrInvalidRequest) {
					t.Fatalf("value %q: expected ErrInvalidRequest, got %v", bad, err)
				}
			}
			if statements := len(proxy.Statements()); statements != 0 {
				t.Fatalf("expected 0 SQL statements for invalid timestamps, got %d", statements)
			}
			if _, err := gw.List(plan, gateway.ListQuery{}, tx); err != nil {
				t.Fatal(test.Redact(err))
			}
			if statements := len(proxy.Statements()); statements != 1 {
				t.Fatalf("expected 1 SQL statement for valid List, got %d", statements)
			}
			return struct{}{}, nil
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}

		for _, bad := range invalid {
			if _, err := integrationCore.Validate(eventDeclarationsSource(bad)); err == nil {
				t.Fatalf("Validate accepted invalid policy timestamp literal %q", bad)
			}
		}
	})

	t.Run("custom Core codecs route through planner, evaluator, compiler and gateway", func(t *testing.T) {
		var calls []string
		base := values.Codecs()
		customCore, err := core.New(core.ValueCodecs{
			Integer:   spyCodec{kind: "integer", inner: base.Integer, calls: &calls},
			Decimal:   spyCodec{kind: "decimal", inner: base.Decimal, calls: &calls},
			String:    spyCodec{kind: "string", inner: base.String, calls: &calls},
			UUID:      spyCodec{kind: "uuid", inner: base.UUID, calls: &calls},
			Boolean:   spyCodec{kind: "boolean", inner: base.Boolean, calls: &calls},
			Timestamp: spyCodec{kind: "timestamp", inner: base.Timestamp, calls: &calls},
		})
		if err != nil {
			t.Fatal(err)
		}
		customDecls, err := customCore.Validate(eventDeclarationsSource(eventCutoff))
		if err != nil {
			t.Fatal(err)
		}
		customReg, err := compiler.NewRegistry(customCore, customDecls, compiler.StorageBindings{
			Resources: []compiler.ResourceBinding{
				{
					Resource: "event", Table: "product_event", ObjectIDColumn: "object_id", KeyColumn: "id",
					Columns:    map[string]string{"occurredAt": "occurred_at", "status": "status"},
					Projection: []string{"occurredAt", "status"},
				},
			},
			Domains: map[string]compiler.DomainRelationBinding{},
		})
		if err != nil {
			t.Fatal(err)
		}
		customGW, err := gateway.New(customReg)
		if err != nil {
			t.Fatal(err)
		}
		_, err = database.Run(t.Context(), s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (struct{}, error) {
			calls = nil
			plan, _ := planEventRead(t, customCore, customDecls, tx)
			page, err := customGW.List(plan, gateway.ListQuery{
				Filter: gateway.CompareFilter{
					Op:    core.OpEq,
					Field: "status",
					Value: core.TextValue("open"),
				},
			}, tx)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Items) != 2 || !slices.Contains(calls, "timestamp") || !slices.Contains(calls, "string") {
				t.Fatalf("expected 2 items and spy codec calls, got items=%d calls=%v", len(page.Items), calls)
			}
			return struct{}{}, nil
		}, database.RunOptions{})
		if err != nil {
			t.Fatal(test.Redact(err))
		}
		upperUUID := strings.ToUpper(string(eventUserID))
		normUUID, err := customCore.NormalizeValue(core.FieldUUID, core.TextValue(upperUUID))
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := normUUID.AsText(); got != string(eventUserID) {
			t.Fatalf("normalized UUID = %q, want %q", got, eventUserID)
		}
	})
}
