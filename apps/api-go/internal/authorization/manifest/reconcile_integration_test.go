//go:build integration

package manifest_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/authorization/values"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
	"hrm/api-go/test/fixture"
)

type preparedRelease struct {
	release manifest.Release
	core    *core.Core
}

func productRelease(t *testing.T, source manifest.Source) preparedRelease {
	t.Helper()
	c, err := core.New(values.Codecs())
	if err != nil {
		t.Fatal(err)
	}
	r, err := manifest.Prepare(source, c)
	if err != nil {
		t.Fatal(err)
	}
	return preparedRelease{r, c}
}

func reconcile(ctx context.Context, runner *database.Runner, prepared preparedRelease) (manifest.Result, error) {
	r, err := manifest.NewReconciler(runner, prepared.core, declarations.RuntimeCapabilities())
	if err != nil {
		return manifest.Result{}, err
	}
	return manifest.Reconcile(ctx, r, prepared.release)
}

func TestReconcileSameReleaseIsNoOpAndDriftFailsClosed(t *testing.T) {
	s := test.NewDatabase(t)
	r := productRelease(t, declarations.Source())
	first, err := reconcile(t.Context(), s.Runner, r)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if first.Changed {
		t.Fatal("same release changed")
	}
	second, err := reconcile(t.Context(), s.Runner, r)
	if err != nil || second != first {
		t.Fatalf("no-op changed: %v", test.Redact(err))
	}
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := conn.Exec(t.Context(), `SET session_replication_role=replica; UPDATE role_definition SET label='Drift' WHERE role_key=convert_to('reviewer','UTF8'); SET session_replication_role=origin`); err != nil {
		t.Fatal(test.Redact(err))
	}
	_, err = reconcile(t.Context(), s.Runner, r)
	var rejection *manifest.Rejection
	if !errors.As(err, &rejection) || rejection.Reason != "not_ready" {
		t.Fatalf("drift was not rejected: %s", test.Redact(err))
	}
}

func TestReconcileRejectsConflictDowngradeAndWrongPredecessor(t *testing.T) {
	s := test.NewDatabase(t)
	for _, tc := range []struct {
		name, sequence, predecessor, reason string
		change                              bool
	}{
		{"conflict", "6", "5", "conflicting_release", true}, {"downgrade", "5", "4", "downgrade", false}, {"wrong predecessor", "8", "7", "predecessor_mismatch", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := declarations.Source()
			source.Sequence, source.Predecessor = tc.sequence, tc.predecessor
			if tc.change {
				source.Roles[0].Label = "Changed"
			}
			_, err := reconcile(t.Context(), s.Runner, productRelease(t, source))
			var rejection *manifest.Rejection
			if !errors.As(err, &rejection) || rejection.Reason != tc.reason {
				t.Fatalf("rejection: %s", test.Redact(err))
			}
		})
	}
}

func TestProtectedStateHashReadsJSONNumbersAndMatchesPublishedHash(t *testing.T) {
	s := test.NewDatabase(t)
	_, err := database.Run(t.Context(), s.Runner, database.ModeSync, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		hash, err := manifest.ProtectedStateHash(tx)
		if err != nil {
			return struct{}{}, err
		}
		rows, err := tx.Query("SELECT encode(materialized_hash,'hex') FROM authz_state WHERE singleton")
		if err != nil {
			return struct{}{}, err
		}
		published, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return struct{}{}, err
		}
		if len(published) != 1 || hash != published[0] {
			t.Fatal("materialized hash mismatch")
		}
		return struct{}{}, nil
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
}

func TestGoSyncedFixtureSupportsRootBootstrap(t *testing.T) {
	s := test.NewDatabase(t)
	root := fixture.Root(t, s)
	if root.ID == "" {
		t.Fatal("bootstrap returned no Root")
	}
	if _, err := reconcile(t.Context(), s.Runner, productRelease(t, declarations.Source())); err != nil {
		t.Fatal(test.Redact(err))
	}
}

func TestUpgradeClonesSourceAndAuditFailureRollsBack(t *testing.T) {
	s := test.NewDatabase(t)
	source := declarations.Source()
	source.Sequence, source.Predecessor = "7", "6"
	source.Roles[0].Label = "Reviewed"
	r := productRelease(t, source)
	source.Roles[0].Label = "Unexpected"
	connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), `CREATE FUNCTION fail_manifest_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture failure'; END$$; CREATE TRIGGER fail_manifest_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION fail_manifest_audit()`); err != nil {
		t.Fatal(test.Redact(err))
	}
	if _, err := reconcile(t.Context(), s.Runner, r); err == nil {
		t.Fatal("audit failure committed")
	}
	var sequence, label string
	if err := connection.QueryRow(t.Context(), "SELECT release_sequence::text,(SELECT label FROM role_definition WHERE role_key=convert_to('reviewer','UTF8')) FROM authz_state WHERE singleton").Scan(&sequence, &label); err != nil {
		t.Fatal(test.Redact(err))
	}
	if sequence != "6" || label != "Reviewer" {
		t.Fatal("audit failure did not roll back")
	}
	if _, err := connection.Exec(t.Context(), "DROP TRIGGER fail_manifest_audit ON audit_outbox; DROP FUNCTION fail_manifest_audit()"); err != nil {
		t.Fatal(test.Redact(err))
	}
	result, err := reconcile(t.Context(), s.Runner, r)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if !result.Changed {
		t.Fatal("upgrade did not change state")
	}
	if err := connection.QueryRow(t.Context(), "SELECT label FROM role_definition WHERE role_key=convert_to('reviewer','UTF8')").Scan(&label); err != nil {
		t.Fatal(test.Redact(err))
	}
	if label != "Reviewed" {
		t.Fatal("caller mutation changed prepared release")
	}
}

func TestUpgradeDoesNotOverwriteRuntimeBoundaryBinding(t *testing.T) {
	s := test.NewDatabase(t)
	account := fixture.Account(t, s, fixture.AccountSpec{Email: "manifest@example.test"})
	connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if _, err := connection.Exec(t.Context(), "INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('account.suspend','UTF8'),convert_to('accountAdministration','UTF8'),1)", account.ID); err != nil {
		t.Fatal(test.Redact(err))
	}
	source := declarations.Source()
	source.Sequence, source.Predecessor = "7", "6"
	source.BoundaryBindings = []manifest.BoundaryBinding{{Owner: "fixture", Identity: account.ID, Permission: "account.suspend", Boundary: core.RelationRef{Key: "accountAdministration", Version: 1}}}
	_, err = reconcile(t.Context(), s.Runner, productRelease(t, source))
	var rejection *manifest.Rejection
	if !errors.As(err, &rejection) || rejection.Reason != "collision" {
		t.Fatalf("runtime collision not rejected: %s", test.Redact(err))
	}
	var stillRuntime bool
	if err := connection.QueryRow(t.Context(), "SELECT seed_owner IS NULL FROM user_boundary WHERE user_id=$1", account.ID).Scan(&stillRuntime); err != nil {
		t.Fatal(test.Redact(err))
	}
	if !stillRuntime {
		t.Fatal("runtime binding was overwritten")
	}
	inUse := declarations.Source()
	inUse.Sequence, inUse.Predecessor = "7", "6"
	kept := inUse.Declarations.Boundaries[:0]
	for _, boundary := range inUse.Declarations.Boundaries {
		if boundary.Key != "accountAdministration" {
			kept = append(kept, boundary)
		}
	}
	inUse.Declarations.Boundaries = kept
	_, err = reconcile(t.Context(), s.Runner, productRelease(t, inUse))
	if !errors.As(err, &rejection) || rejection.Reason != "definition_in_use" {
		t.Fatalf("bound boundary omission was not rejected: %s", test.Redact(err))
	}
}
