//go:build integration

package authority

import (
	"context"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/gateway"
	"hrm/api-go/internal/database"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

func TestWorkRequestAndLeaveScopesMatchTheEvaluatorOnEveryRow(t *testing.T) {
	s := testdb.NewDatabase(t)
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	parityDB(t, err)
	t.Cleanup(func() { parityDB(t, conn.Close(context.WithoutCancel(t.Context()))) })
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := conn.Exec(t.Context(), sql, args...)
		parityDB(t, err)
	}
	one := func(sql string, args ...any) string {
		t.Helper()
		var value string
		parityDB(t, conn.QueryRow(t.Context(), sql, args...).Scan(&value))
		return value
	}
	team := one(`INSERT INTO team(id,object_id,name) SELECT g,public.hr_register_object('team',g),'Parity' FROM gen_random_uuid() g RETURNING id::text`)
	var accounts, employees, secrets []string
	for _, roles := range [][]string{{"hr.employee"}, {"hr.employee"}, {"hr.employee", "hr.coo"}, {"hr.employee", "hr.admin"}, {"hr.employee"}, {}} {
		account := fixture.Account(t, s, fixture.AccountSpec{Roles: roles}).ID
		employee := fixture.Employee(t, s, fixture.EmployeeSpec{AccountID: account}).ID
		accounts, employees, secrets = append(accounts, account), append(employees, employee), append(secrets, fixture.Session(t, s, account, fixture.SessionSpec{Fresh: true}))
	}
	for _, employee := range employees[:3] {
		exec(`INSERT INTO team_membership(id,team_id,employee_id,is_primary,starts_at) VALUES(gen_random_uuid(),$1,$2,true,statement_timestamp()-interval '1 hour')`, team, employee)
	}
	exec(`INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES(gen_random_uuid(),$1,$2,statement_timestamp()-interval '1 hour')`, team, employees[0])
	for i, state := range []string{"pending_lead", "pending_final", "rejected", "approved", "cancelled"} {
		request := one(`INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
          SELECT g,public.hr_register_object('workRequest',g),$1,$2,$3,'annual-leave',$4,'Parity' FROM gen_random_uuid() g RETURNING id::text`, employees[i], accounts[i], team, state)
		if state == "rejected" || state == "approved" {
			exec(`INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,reason) VALUES(gen_random_uuid(),$1,'lead','reject','user',$2,'Parity')`, request, accounts[0])
		}
	}
	c, err := declarations.NewCore()
	parityDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	parityDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	parityDB(t, err)
	a, err := New(s.Runner, bindings, DefaultCapabilities(), nil)
	parityDB(t, err)
	partial := 0
	for _, secret := range secrets {
		for _, pair := range []Probe{{"workRequest", "read"}, {"employee", "readLeaveBalance"}} {
			_, err := database.Run(t.Context(), s.Runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (struct{}, error) {
				session, facts, err := a.readSession(tx, secret, []Probe{pair})
				parityDB(t, err)
				decision, err := a.decide(tx, session, facts, pair)
				parityDB(t, err)
				if !decision.Allowed() {
					t.Fatalf("plan denied %+v: %s", pair, decision.Reason())
				}
				objects, edges := parityFacts(t, tx, pair.Resource)
				want := []string{}
				for _, object := range objects {
					if c.Evaluate(decision.Plan(), core.CompleteFacts{Now: session.now, Record: object, Objects: objects, Edges: edges}).Allowed() {
						want = append(want, object.Key.Value)
					}
				}
				page, err := a.gateway.List(decision.Plan(), gateway.ListQuery{Limit: gateway.Limit(100)}, tx)
				parityDB(t, err)
				got := []string{}
				for _, row := range page.Items {
					value, _ := row["key"].AsText()
					got = append(got, value)
				}
				slices.Sort(got)
				slices.Sort(want)
				if !slices.Equal(got, want) {
					t.Errorf("%s %+v SQL=%v evaluator=%v", session.userID, pair, got, want)
				}
				if len(want) > 0 && len(want) < len(objects) {
					partial++
				}
				return struct{}{}, nil
			}, database.RunOptions{})
			parityDB(t, err)
		}
	}
	if partial < 5 {
		t.Errorf("only %d partial scopes", partial)
	}
}

func parityDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}

func parityFacts(t *testing.T, tx *database.Tx, resource string) ([]core.FactObject, []core.EdgeFact) {
	t.Helper()
	sql := `SELECT id::text,object_id::text,kind,state,version::text FROM work_request ORDER BY id`
	if resource == "employee" {
		sql = `SELECT id::text,object_id::text,code,full_name,coalesce(account_id::text,'') FROM employee ORDER BY id`
	}
	rows, err := tx.Query(sql)
	parityDB(t, err)
	objects, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (core.FactObject, error) {
		var id, objectID, first, second, third string
		err := row.Scan(&id, &objectID, &first, &second, &third)
		fields := map[string]core.FieldValue{"kind": core.TextValue(first), "state": core.TextValue(second), "version": core.TextValue(third)}
		if resource == "employee" {
			fields = map[string]core.FieldValue{"code": core.TextValue(first), "fullName": core.TextValue(second), "accountId": core.TextValue(third)}
		}
		return core.FactObject{Type: resource, Key: core.Key{Kind: core.KeyUUID, Value: id}, ObjectID: objectID, Fields: fields}, err
	})
	parityDB(t, err)
	queries := map[string]string{
		"employee.lead":                     `SELECT r.object_id::text,e.lead_account_id::text FROM employee r JOIN hr_employee_lead e ON e.employee_id=r.id`,
		"workRequest.owner":                 `SELECT r.object_id::text,e.account_id::text FROM work_request r JOIN hr_request_owner e ON e.request_id=r.id`,
		"workRequest.lead":                  `SELECT r.object_id::text,e.lead_account_id::text FROM work_request r JOIN hr_request_lead e ON e.request_id=r.id`,
		"workRequest.decider":               `SELECT r.object_id::text,e.actor_account_id::text FROM work_request r JOIN hr_request_decider e ON e.request_id=r.id`,
		"workRequest.leadRejectedLeadOwned": `SELECT r.object_id::text,e.owner_account_id::text FROM work_request r JOIN hr_request_lead_rejected e ON e.request_id=r.id`,
	}
	var edges []core.EdgeFact
	for relation, sql := range queries {
		rows, err := tx.Query(sql)
		parityDB(t, err)
		found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (core.EdgeFact, error) {
			var source string
			var target core.IdentityID
			err := row.Scan(&source, &target)
			return core.EdgeFact{Relation: core.RelationRef{Key: relation, Version: 1}, Source: source, Target: core.EdgeTarget{Kind: core.EdgeTargetIdentity, Identity: target}, StartsAt: "2000-01-01T00:00:00Z"}, err
		})
		parityDB(t, err)
		edges = append(edges, found...)
	}
	return objects, edges
}
