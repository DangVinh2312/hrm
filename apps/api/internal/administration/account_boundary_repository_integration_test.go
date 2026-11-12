//go:build integration

package administration

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

const bindIdentityPackage = `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version,seed_owner)
  SELECT $1, permission_key, boundary_key, boundary_version, $2 FROM permission_boundary_entry
   WHERE boundary_key=convert_to('identityAdministration','UTF8') AND boundary_version=1`

func superuser(t *testing.T, s *test.Stack) *pgx.Conn {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	t.Cleanup(func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	})
	return conn
}

func exec(t *testing.T, conn *pgx.Conn, sql string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(test.Redact(err))
	}
}

// The boundary statements: an active package of required permissions is read whole, an unknown one is empty;
// the bindings count the actor's rows of the package and the target's rows of any of its permissions; the
// package is inserted whole once (the primary key refuses it again) and only runtime rows are ever deleted.
func TestTheBoundaryStatementsOfAnAccount(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	actor := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	target := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	seeded := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	exec(t, conn, bindIdentityPackage, actor, nil)
	exec(t, conn, `SET session_replication_role=replica`)
	exec(t, conn, bindIdentityPackage, seeded, []byte("release"))
	exec(t, conn, `SET session_replication_role=DEFAULT`)
	identity := BoundaryRef{Key: "identityAdministration", Version: 1}
	if err := admin(t, s, func(tx *database.Tx) error {
		members, err := boundaryPackage(tx, identity)
		if err != nil || len(members) != 3 || slices.Contains(members, false) {
			t.Errorf("identityAdministration@1: %v", members)
		}
		for _, ref := range []BoundaryRef{{Key: "identityAdministration", Version: 2}, {Key: "nope", Version: 1}} {
			if members, err := boundaryPackage(tx, ref); err != nil || len(members) != 0 {
				t.Errorf("%+v: %v", ref, members)
			}
		}
		held, bound, err := boundaryBindings(tx, actor, target, identity)
		if err != nil || held != 3 || bound != 0 {
			t.Errorf("before insert: held %d bound %d", held, bound)
		}
		if inserted, err := insertBoundary(tx, target, identity); err != nil || inserted != 3 {
			t.Errorf("insert: %d %v", inserted, err)
		}
		if held, bound, err = boundaryBindings(tx, seeded, target, identity); err != nil || held != 3 || bound != 3 {
			t.Errorf("after insert: held %d bound %d", held, bound)
		}
		if gone, err := deleteRuntimeBoundary(tx, target, identity); err != nil || gone != 3 {
			t.Errorf("delete: %d", gone)
		}
		if gone, err := deleteRuntimeBoundary(tx, seeded, identity); err != nil || gone != 0 {
			t.Errorf("delete of seeded rows: %d", gone)
		}
		return err
	}); err != nil {
		t.Fatal(test.Redact(err))
	}
	err := admin(t, s, func(tx *database.Tx) error {
		_, err := insertBoundary(tx, seeded, identity)
		return err
	})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("an insert over existing rows: %v", test.Redact(err))
	}
}

func epochOf(t *testing.T, conn *pgx.Conn, id string) int {
	t.Helper()
	var epoch string
	if err := conn.QueryRow(t.Context(), `SELECT auth_epoch::text FROM app_user WHERE id=$1`, id).Scan(&epoch); err != nil {
		t.Fatal(test.Redact(err))
	}
	n, err := strconv.Atoi(epoch)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// The identity functions under the savepoint: an absent account (P0002) or Root (the function's own 42501) is
// not found and the transaction goes on; nothing to change and a taken email are conflicts; any other refusal
// (an issuer the function does not know, 22023) is a fault. A done reset moves the epoch.
func TestTheIdentityFunctionsUnderTheSavepoint(t *testing.T) {
	s := test.NewDatabase(t)
	conn := superuser(t, s)
	actor := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	target := fixture.Account(t, s, fixture.AccountSpec{Email: "target@example.test", Roles: []string{"hr.employee"}}).ID
	noEmail := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	fixture.Account(t, s, fixture.AccountSpec{Email: "taken@example.test"})
	root := fixture.Root(t, s).ID
	notFound := map[string]func(tx *database.Tx) error{
		"absent":   func(tx *database.Tx) error { return resetIAMMfa(tx, "00000000-0000-4000-8000-000000000000") },
		"Root mfa": func(tx *database.Tx) error { return resetIAMMfa(tx, root) },
		"Root email": func(tx *database.Tx) error {
			return changeIAMAccountEmail(tx, root, "r@example.test", test.FixtureIssuer, actor)
		},
		"Root binding": func(tx *database.Tx) error { return resetIAMGoogleBinding(tx, root, test.FixtureIssuer, actor) },
	}
	for name, call := range notFound {
		if err := admin(t, s, func(tx *database.Tx) error {
			done, err := identityOperation(tx, func() error { return call(tx) })
			if err != nil || done {
				t.Errorf("%s: %v %v", name, done, test.Redact(err))
			}
			_, err = tx.Exec(`SELECT 1`)
			return err
		}); err != nil {
			t.Errorf("%s: the transaction did not go on: %v", name, test.Redact(err))
		}
	}
	conflicts := map[string]func(tx *database.Tx) error{
		"no second factor": func(tx *database.Tx) error { return resetIAMMfa(tx, target) },
		"a taken email": func(tx *database.Tx) error {
			return changeIAMAccountEmail(tx, target, "taken@example.test", test.FixtureIssuer, actor)
		},
		"the same email": func(tx *database.Tx) error {
			return changeIAMAccountEmail(tx, target, "target@example.test", test.FixtureIssuer, actor)
		},
		"no email": func(tx *database.Tx) error { return resetIAMGoogleBinding(tx, noEmail, test.FixtureIssuer, actor) },
	}
	for name, call := range conflicts {
		err := admin(t, s, func(tx *database.Tx) error {
			_, err := identityOperation(tx, func() error { return call(tx) })
			return err
		})
		if !errors.Is(err, apperror.ErrCommandRejected) {
			t.Errorf("%s: %v", name, test.Redact(err))
		}
	}
	err := admin(t, s, func(tx *database.Tx) error {
		_, err := identityOperation(tx, func() error { return resetIAMGoogleBinding(tx, target, "https://unknown.example.test", actor) })
		return err
	})
	if err == nil || errors.Is(err, apperror.ErrCommandRejected) || errors.Is(err, apperror.ErrNotFound) {
		t.Errorf("an issuer the function refuses: %v", test.Redact(err))
	}
	exec(t, conn, `REVOKE EXECUTE ON FUNCTION public.reset_iam_mfa(uuid) FROM product_authority`)
	err = admin(t, s, func(tx *database.Tx) error {
		_, err := identityOperation(tx, func() error { return resetIAMMfa(tx, root) })
		return err
	})
	exec(t, conn, `GRANT EXECUTE ON FUNCTION public.reset_iam_mfa(uuid) TO product_authority`)
	if sqlState(err) != "42501" {
		t.Errorf("a revoked EXECUTE is not a fault: %v", test.Redact(err))
	}
	exec(t, conn, `INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,sha256(convert_to(gen_random_uuid()::text,'UTF8')))`, target)
	before := epochOf(t, conn, target)
	if err := admin(t, s, func(tx *database.Tx) error {
		done, err := identityOperation(tx, func() error { return resetIAMMfa(tx, target) })
		if !done && err == nil {
			t.Errorf("a reset of a recovery code was not done")
		}
		return err
	}); err != nil {
		t.Fatal(test.Redact(err))
	}
	if after := epochOf(t, conn, target); after != before+1 {
		t.Errorf("reset mfa moved the epoch from %d to %d", before, after)
	}
}
