//go:build integration

package employee

import (
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"hrm/api-go/internal/database"
	testdb "hrm/api-go/test"
	"hrm/api-go/test/fixture"
	"testing"
)

func TestDataLoginCannotRegisterAnchorsOrWriteAccountLinks(t *testing.T) {
	s := testdb.NewDatabase(t)
	e := fixture.Employee(t, s, fixture.EmployeeSpec{})
	for _, kind := range []string{"hrCompany", "account"} {
		_, err := inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (struct{}, error) {
			_, err := tx.Exec("SELECT public.hr_register_object($1,CAST($2 AS uuid))", kind, newUUID())
			return struct{}{}, err
		})
		pg, ok := errors.AsType[*pgconn.PgError](err)
		if !ok || pg.Code != "22023" {
			t.Fatalf("anchor registration: %s", testdb.Redact(err))
		}
	}
	for _, sql := range []string{"UPDATE employee SET account_id=NULL WHERE id=$1", `INSERT INTO employee(id,object_id,code,full_name,hired_on,account_id) VALUES($1,gen_random_uuid(),'Z','Z',DATE '2026-01-05',NULL)`} {
		_, err := inMode(t.Context(), s, database.ModeWrite, func(tx *database.Tx) (struct{}, error) { _, err := tx.Exec(sql, e.ID); return struct{}{}, err })
		pg, ok := errors.AsType[*pgconn.PgError](err)
		if !ok || pg.Code != "42501" {
			t.Fatalf("data login wrote account link: %s", testdb.Redact(err))
		}
	}
}
