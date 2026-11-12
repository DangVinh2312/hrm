//go:build integration

package gateway_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/gateway"
	"hrm/api/internal/database"
	"hrm/api/test"
)

func TestIdentityEdgesCannotGrantThroughBusinessRowPointingAtAnotherRegisteredResourceType(t *testing.T) {
	s := test.NewDatabase(t)
	ctx := t.Context()

	if _, err := s.Pools[database.PurposeIdentity].Exec(
		ctx,
		`INSERT INTO app_user(id,state) VALUES($1,'active') ON CONFLICT DO NOTHING`,
		string(alice),
	); err != nil {
		t.Fatal(test.Redact(err))
	}
	for _, pair := range [][2]string{
		{"submission", "integer"},
		{"site", "uuid"},
	} {
		if _, err := s.Pools[database.PurposeSync].Exec(
			ctx,
			`INSERT INTO resource_type(type_key,key_kind,binding_key) VALUES($1,$2,$1) ON CONFLICT DO NOTHING`,
			[]byte(pair[0]), pair[1],
		); err != nil {
			t.Fatal(test.Redact(err))
		}
	}

	const (
		wrongObject = "e0000000-0000-4000-8000-000000000001"
		rightObject = "e0000000-0000-4000-8000-000000000002"
		siteKeyUUID = "e0000000-0000-4000-8000-000000000099"
	)

	_, err := database.Run(ctx, s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		if _, err := tx.Exec(
			`INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$2,'uuid',$3),($4,$5,'integer',$6)`,
			wrongObject, []byte("site"), []byte(siteKeyUUID),
			rightObject, []byte("submission"), []byte("2"),
		); err != nil {
			return struct{}{}, err
		}
		for _, obj := range []string{wrongObject, rightObject} {
			if _, err := tx.Exec(
				`INSERT INTO user_relation(relation_key,relation_version,object_id,user_id,starts_at) VALUES($1,1,$2,$3,statement_timestamp()-interval '1 minute')`,
				[]byte("submission.assignee"), obj, string(alice),
			); err != nil {
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
		`CREATE TABLE submission(id bigint PRIMARY KEY,object_id uuid UNIQUE NOT NULL REFERENCES object_ref(object_id),status text,amount numeric,title text,priority bigint)`,
		`GRANT SELECT ON submission TO product_data`,
	} {
		if _, err := superConn.Exec(ctx, stmt); err != nil {
			if closeErr := superConn.Close(ctx); closeErr != nil {
				t.Error(test.Redact(closeErr))
			}
			t.Fatal(test.Redact(err))
		}
	}
	if _, err := superConn.Exec(
		ctx,
		`INSERT INTO submission VALUES(1,$1,'pending',10,'wrong type',NULL),(2,$2,'pending',10,'right type',NULL)`,
		wrongObject, rightObject,
	); err != nil {
		if closeErr := superConn.Close(ctx); closeErr != nil {
			t.Error(test.Redact(closeErr))
		}
		t.Fatal(test.Redact(err))
	}
	if err := superConn.Close(ctx); err != nil {
		t.Fatal(test.Redact(err))
	}

	d := fixtureDeclarations(t)
	b := fullStorageBindings()
	b.Resources[0].Columns = map[string]string{
		"status": "status", "amount": "amount", "title": "title",
		"priority": "priority", "submittedAt": "status", "archived": "status",
	}
	b.Resources[0].Projection = []string{"title"}
	reg, err := compiler.NewRegistry(integrationCore, d, b)
	if err != nil {
		t.Fatal(err)
	}
	gw, err := gateway.New(reg)
	if err != nil {
		t.Fatal(err)
	}

	_, err = database.Run(ctx, s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		nowTime := time.Now().UTC()
		in := core.TrustedInput{
			Principal:  core.TrustedPrincipal{ID: alice, Assurance: 2},
			Resource:   "submission",
			Action:     "read",
			Context:    map[string]core.Scalar{},
			Now:        nowTime.Format("2006-01-02T15:04:05.000000Z"),
			ValidUntil: nowTime.Add(1500 * time.Millisecond).Format("2006-01-02T15:04:05.000000Z"),
		}
		snap := core.AuthoritySnapshot{
			Revision:     tx.Revision,
			Declarations: d,
			User:         &core.AuthorityUser{ID: alice, State: core.UserActive},
			Roles:        []string{"reviewer"},
			Permissions: []core.PermissionFact{
				{
					Key:       "submission.read",
					Resource:  "submission",
					Action:    "read",
					Policy:    core.RelationRef{Key: "baseline", Version: 1},
					Boundary:  core.BoundaryOptional,
					Lifecycle: core.LifecycleActive,
				},
			},
			Rules: []core.RuleFact{
				{
					ID:         "r1",
					Permission: "submission.read",
					Subject:    core.RuleSubject{Kind: core.SubjectIdentity, Identity: alice},
					Effect:     core.EffectAllow,
					Template:   core.RelationRef{Key: "assignedToMe", Version: 1},
					Parameters: map[string]core.Scalar{},
				},
			},
			Boundaries: []core.BoundaryBindingFact{},
			Registry: core.Registry{
				Validators:         map[string]core.ContextValidator{},
				ObligationHandlers: []string{},
			},
		}
		decision := integrationCore.Plan(in, snap)
		if !decision.Allowed() {
			t.Fatalf("plan denied: %s", decision.Reason())
		}
		page, err := gw.List(decision.Plan(), gateway.ListQuery{}, tx)
		if err != nil {
			t.Fatal(err)
		}
		got := make([]string, len(page.Items))
		for i, row := range page.Items {
			got[i], _ = row["key"].AsText()
		}
		if !slices.Equal(got, []string{"2"}) {
			t.Fatalf("expected [2], got %v", got)
		}
		return struct{}{}, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
}
