//go:build integration

package administration

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
	"hrm/api/test"
	"hrm/api/test/fixture"
)

func admin(t *testing.T, s *test.Stack, work func(tx *database.Tx) error) error {
	t.Helper()
	_, err := database.Run(t.Context(), s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		return struct{}{}, work(tx)
	}, database.RunOptions{})
	return err
}

func accountFacts(t *testing.T, s *test.Stack, id string) string {
	t.Helper()
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	var facts string
	if err := conn.QueryRow(t.Context(), `SELECT state||':'||auth_epoch FROM app_user WHERE id=$1`, id).Scan(&facts); err != nil {
		t.Fatal(test.Redact(err))
	}
	return facts
}

// Suspend ends every session of the account (a new auth_epoch); reactivating an account that is not suspended
// is a conflict and changes nothing, a suspended one comes back with another new epoch.
func TestSuspendAndReactivateMoveTheEpochAndRefuseAnAccountNotSuspended(t *testing.T) {
	s := test.NewDatabase(t)
	target := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee"}}).ID
	start := accountFacts(t, s, target)
	epoch, err := strconv.Atoi(strings.TrimPrefix(start, "active:"))
	if err != nil {
		t.Fatalf("fixture account %s", start)
	}
	if err := admin(t, s, func(tx *database.Tx) error { return reactivateAccount(tx, target) }); !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("reactivate of an active account: %v", test.Redact(err))
	}
	if facts := accountFacts(t, s, target); facts != start {
		t.Errorf("a refused reactivate left %s", facts)
	}
	if err := admin(t, s, func(tx *database.Tx) error { return suspendAccount(tx, target) }); err != nil {
		t.Fatal(test.Redact(err))
	}
	if facts := accountFacts(t, s, target); facts != "suspended:"+strconv.Itoa(epoch+1) {
		t.Errorf("suspend left %s", facts)
	}
	if err := admin(t, s, func(tx *database.Tx) error { return reactivateAccount(tx, target) }); err != nil {
		t.Fatal(test.Redact(err))
	}
	if facts := accountFacts(t, s, target); facts != "active:"+strconv.Itoa(epoch+2) {
		t.Errorf("reactivate left %s", facts)
	}
}

// The role statements: an absent role is not found, a role's rules are grant facts of source role, and the
// holding of an account counts its roles and knows the one asked.
func TestTheRoleStatementsOfAnAccount(t *testing.T) {
	s := test.NewDatabase(t)
	target := fixture.Account(t, s, fixture.AccountSpec{Roles: []string{"hr.employee", "hr.admin"}}).ID
	if err := admin(t, s, func(tx *database.Tx) error {
		if err := lockAccount(tx, target); err != nil {
			return err
		}
		if _, _, found, err := roleRules(tx, "custom.absent"); err != nil || found {
			t.Errorf("rules of an absent role: found=%v", found)
		}
		if exists, err := roleExists(tx, "custom.absent"); err != nil || exists {
			t.Errorf("an absent role exists=%v", exists)
		}
		facts, truncated, found, err := roleRules(tx, "hr.employee")
		if err != nil || !found || truncated || len(facts) == 0 {
			t.Errorf("rules of hr.employee: %d facts, truncated=%v found=%v", len(facts), truncated, found)
		}
		for _, fact := range facts {
			if fact.Source != "role" || fact.Effect != "allow" || fact.Parameters == "" {
				t.Errorf("fact %+v", fact)
			}
		}
		count, held, err := holding(tx, target, "hr.admin")
		if err != nil || count != 2 || !held {
			t.Errorf("holding: %d %v", count, held)
		}
		if inserted, err := insertAccountRole(tx, target, "hr.admin"); err != nil || inserted {
			t.Errorf("a held role inserted again: %v", inserted)
		}
		if gone, err := deleteAccountRole(tx, target, "hr.admin"); err != nil || !gone {
			t.Errorf("delete of a held role: %v", gone)
		}
		count, held, err = holding(tx, target, "hr.admin")
		if err != nil || count != 1 || held {
			t.Errorf("holding after delete: %d %v", count, held)
		}
		return err
	}); err != nil {
		t.Fatal(test.Redact(err))
	}
}

// A taken email is a conflict of provisioning, not a fault.
func TestProvisioningATakenEmailIsAConflict(t *testing.T) {
	s := test.NewDatabase(t)
	actor := fixture.Account(t, s, fixture.AccountSpec{Email: "actor@example.test"}).ID
	fixture.Account(t, s, fixture.AccountSpec{Email: "taken@example.test"})
	err := admin(t, s, func(tx *database.Tx) error {
		return provisionAccount(tx, newUUID(), "taken@example.test", test.FixtureIssuer, actor)
	})
	if !errors.Is(err, apperror.ErrCommandRejected) {
		t.Errorf("a taken email: %v", test.Redact(err))
	}
}
