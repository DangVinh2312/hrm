//go:build integration

package audit_test

import (
	"context"
	"errors"
	"testing"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

func TestTypedAccessPreservesRootOutcomeWithoutStringKeyPII(t *testing.T) {
	s := test.NewDatabase(t)
	event := audit.Event{Kind: "access.document.read", Actor: audit.OfflineActor, Detail: audit.Access{Permission: "document.read", Root: &audit.RootOutcome{Outcome: "absent"}, Target: &audit.RequestedKey{Resource: "document", KeyKind: core.KeyString, Key: "sensitive-fixture-reference"}}}
	if _, err := appendIn(t, s, database.ModeRead, event, nil); err != nil {
		t.Fatal(test.Redact(err))
	}
	connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	var matches bool
	if err := connection.QueryRow(t.Context(), `SELECT object_id IS NULL AND permission_key=convert_to('document.read','UTF8') AND safe_metadata='{"principalKind":"root","outcome":"absent","resource":"document","keyKind":"string"}'::jsonb FROM audit_outbox WHERE event_kind=convert_to('access.document.read','UTF8')`).Scan(&matches); err != nil {
		t.Fatal(test.Redact(err))
	}
	if !matches {
		t.Fatal("root access metadata mismatch")
	}
}

func TestTypedModuleEffectAndAuditRollBackTogether(t *testing.T) {
	s := test.NewDatabase(t)
	actor := fixture.Account(t, s, fixture.AccountSpec{Email: "full-audit@example.test"})
	employee := fixture.Employee(t, s, fixture.EmployeeSpec{AccountID: actor.ID})
	boom := errors.New("rollback fixture")
	_, err := database.Run(t.Context(), s.Runner, database.ModeWrite, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		if _, err := tx.Exec("UPDATE employee SET full_name='Changed fixture' WHERE id=$1", employee.ID); err != nil {
			return struct{}{}, err
		}
		err := audit.Append(tx, audit.Event{Kind: "hr.employee.update", Actor: actor.ID, Detail: audit.ModuleChange{Permission: "employee.update", Target: audit.RequestedKey{Resource: "employee", KeyKind: core.KeyUUID, Key: employee.ID, ObjectID: employee.ObjectID}}})
		if err != nil {
			return struct{}{}, err
		}
		return struct{}{}, boom
	}, database.RunOptions{})
	if !errors.Is(err, boom) {
		t.Fatal(test.Redact(err))
	}
	connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	var unchanged bool
	if err := connection.QueryRow(t.Context(), "SELECT full_name=$2 AND NOT EXISTS(SELECT 1 FROM audit_outbox WHERE event_kind=convert_to('hr.employee.update','UTF8')) FROM employee WHERE id=$1", employee.ID, employee.FullName).Scan(&unchanged); err != nil {
		t.Fatal(test.Redact(err))
	}
	if !unchanged {
		t.Fatal("effect or audit survived rollback")
	}
}
