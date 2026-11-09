//go:build integration

package team

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/database"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

type teamFixture struct {
	s                      *testdb.Stack
	conn                   *pgx.Conn
	service                *Service
	auth                   *authority.Authorization
	root, hr, member       string
	rootID, hrID, memberID string
	employees              *authority.Query[ListQuery, []string]
}

func mustDB(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(testdb.Redact(err))
	}
}
func newTeamFixture(t *testing.T) *teamFixture {
	t.Helper()
	f := &teamFixture{s: testdb.NewDatabase(t)}
	var err error
	f.conn, err = f.s.Cluster.ConnectSuperuser(t.Context(), f.s.Database)
	mustDB(t, err)
	t.Cleanup(func() { mustDB(t, f.conn.Close(context.WithoutCancel(t.Context()))) })
	root := fixture.Root(t, f.s)
	f.rootID = root.ID
	hr := fixture.Account(t, f.s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.admin"}})
	f.hrID = hr.ID
	member := fixture.Account(t, f.s, fixture.AccountSpec{Roles: []string{"hr.employee"}})
	f.memberID = member.ID
	f.root = fixture.Session(t, f.s, root.ID, fixture.SessionSpec{Fresh: true})
	f.hr = fixture.Session(t, f.s, hr.ID, fixture.SessionSpec{Fresh: true})
	f.member = fixture.Session(t, f.s, member.ID, fixture.SessionSpec{Fresh: true})
	c, err := declarations.NewCore()
	mustDB(t, err)
	validated, err := c.Validate(declarations.Source().Declarations)
	mustDB(t, err)
	bindings, err := compiler.NewRegistry(c, validated, declarations.Bindings())
	mustDB(t, err)
	ops := NewOperations()
	f.employees = authority.NewQuery("employee", "read", nil, func(c authority.QueryContext, _ ListQuery) (authority.QueryResult[[]string], error) {
		args, _, err := c.Scope.Args()
		if err != nil {
			return authority.QueryResult[[]string]{}, err
		}
		rows, err := c.Tx.Query("SELECT r.id::text FROM employee r WHERE "+c.Scope.SQL+" ORDER BY r.id", args...)
		if err != nil {
			return authority.QueryResult[[]string]{}, err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		return authority.QueryResult[[]string]{Found: true, Value: ids}, err
	})
	f.auth, err = authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), nil, append(ops.All(), f.employees)...)
	mustDB(t, err)
	f.service = ops.Bind(f.auth)
	return f
}
func (f *teamFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.conn.Exec(t.Context(), sql, args...)
	mustDB(t, err)
}
func (f *teamFixture) scalar(t *testing.T, sql string, args ...any) string {
	t.Helper()
	var value string
	mustDB(t, f.conn.QueryRow(t.Context(), sql, args...).Scan(&value))
	return value
}
func (f *teamFixture) create(t *testing.T, name string) string {
	t.Helper()
	value, err := f.service.Create(t.Context(), f.root, CreateInput{Name: name})
	mustDB(t, err)
	return value.ID
}
func (f *teamFixture) add(t *testing.T, team, employee string, primary bool) {
	t.Helper()
	_, err := f.service.AddMember(t.Context(), f.root, MemberInput{TeamID: team, EmployeeID: employee, Primary: primary})
	mustDB(t, err)
}
func (f *teamFixture) lead(t *testing.T, team string, employee *string) {
	t.Helper()
	_, err := f.service.AssignLead(t.Context(), f.root, LeadInput{TeamID: team, EmployeeID: employee})
	mustDB(t, err)
}
func (f *teamFixture) detail(t *testing.T, id string) View {
	t.Helper()
	view, err := f.service.Detail(t.Context(), f.hr, id)
	mustDB(t, err)
	return view
}
func (f *teamFixture) revision(t *testing.T) string {
	t.Helper()
	return f.scalar(t, "SELECT revision::text FROM authz_state WHERE singleton")
}
func (f *teamFixture) mutate(t *testing.T, work func(*database.Tx) error) {
	t.Helper()
	_, err := database.Run(t.Context(), f.s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) { return struct{}{}, work(tx) }, database.RunOptions{})
	mustDB(t, err)
}
