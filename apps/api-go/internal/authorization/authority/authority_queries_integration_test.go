//go:build integration

package authority_test

import (
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/test/fixture"
)

func queryArgs(params []compiler.Param) []any {
	args := make([]any, len(params))
	for i, param := range params {
		switch param.Kind() {
		case compiler.ParamText:
			args[i], _ = param.AsText()
		case compiler.ParamBool:
			args[i], _ = param.AsBool()
		case compiler.ParamInt:
			args[i], _ = param.AsInt()
		case compiler.ParamBytes:
			args[i], _ = param.AsBytes()
		}
	}
	return args
}

func TestRegisteredQueriesUseScopeAndRootAbsentAudit(t *testing.T) {
	f := newAuthorityFixture(t)
	query := authority.NewQuery("document", "read", func(key string) string { return key }, func(c authority.QueryContext, key string) (authority.QueryResult[string], error) {
		params := append(c.Scope.Parameters, compiler.TextParam(key))
		rows, err := c.Tx.Query(fmt.Sprintf("SELECT r.title FROM document r WHERE %s AND r.id=CAST($%d AS uuid)", c.Scope.SQL, len(params)), queryArgs(params)...)
		if err != nil {
			return authority.QueryResult[string]{}, err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil || len(found) == 0 {
			return authority.QueryResult[string]{}, err
		}
		return authority.QueryResult[string]{Found: true, Value: found[0]}, nil
	})
	a := f.authority(t, authority.DefaultCapabilities(), query)
	result, err := authority.Read(t.Context(), a, f.secret, query, docOwn)
	requireDB(t, err)
	if !result.Found || result.Value != "Own" {
		t.Fatal("registered query failed")
	}
	for _, key := range []string{docOther, absentDoc} {
		result, err = authority.Read(t.Context(), a, f.secret, query, key)
		requireDB(t, err)
		if result.Found || result.Value != "" {
			t.Fatal("query exposed hidden row")
		}
	}
	root := fixture.Root(t, f.s)
	secret := fixture.Session(t, f.s, root.ID, fixture.SessionSpec{})
	result, err = authority.Read(t.Context(), a, secret, query, absentDoc)
	requireDB(t, err)
	if result.Found {
		t.Fatal("absent query found target")
	}
	var marked bool
	requireDB(t, f.conn.QueryRow(t.Context(), `SELECT safe_metadata->>'principalKind'='root' AND safe_metadata->>'outcome'='absent' AND safe_metadata->>'key'=$2 FROM audit_outbox WHERE actor_id=$1 AND event_kind=convert_to('access.document.read','UTF8')`, root.ID, absentDoc).Scan(&marked))
	if !marked {
		t.Fatal("query omitted Root absent marker")
	}
}

func TestRegisteredQueryPlanExpiresAtSessionDeadline(t *testing.T) {
	f := newAuthorityFixture(t)
	f.exec(t, `UPDATE application_session SET created_at=statement_timestamp()-interval '1 hour',expires_at=statement_timestamp()+interval '200 milliseconds' WHERE user_id=$1`, f.owner.ID)
	query := authority.NewQuery("document", "read", nil, func(c authority.QueryContext, _ string) (authority.QueryResult[string], error) {
		if _, err := c.Tx.Exec("SELECT pg_sleep(0.3)"); err != nil {
			return authority.QueryResult[string]{}, err
		}
		rows, err := c.Tx.Query("SELECT count(*)::text FROM document r WHERE "+c.Scope.SQL, queryArgs(c.Scope.Parameters)...)
		if err != nil {
			return authority.QueryResult[string]{}, err
		}
		count, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
		return authority.QueryResult[string]{Found: true, Value: count}, err
	})
	a := f.authority(t, authority.DefaultCapabilities(), query)
	result, err := authority.Read(t.Context(), a, f.secret, query, "")
	requireDB(t, err)
	if result.Value != "0" {
		t.Fatal("plan outlived session expiry")
	}
}
