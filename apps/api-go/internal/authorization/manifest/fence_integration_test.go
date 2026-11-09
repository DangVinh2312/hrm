//go:build integration

package manifest_test

import (
	"context"
	"errors"
	"testing"

	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/database"
	"hrm/api-go/test"
)

func TestConcurrentReconcilePublishesExactlyOnce(t *testing.T) {
	s := test.NewDatabase(t)
	pools, err := database.OpenPools(t.Context(), map[database.Purpose]string{database.PurposeSync: s.LoginURL("sync")}, database.TLSDisabled)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer pools.Close()
	second, err := database.NewRunner(pools, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	source := declarations.Source()
	source.Sequence, source.Predecessor = "7", "6"
	source.Roles[0].Label = "Concurrent fixture"
	prepared := productRelease(t, source)
	type outcome struct {
		result manifest.Result
		err    error
	}
	results := make(chan outcome, 2)
	for _, runner := range []*database.Runner{s.Runner, second} {
		go func() { result, err := reconcile(t.Context(), runner, prepared); results <- outcome{result, err} }()
	}
	a, b := <-results, <-results
	if a.err != nil || b.err != nil {
		t.Fatalf("concurrent reconcile: %s / %s", test.Redact(a.err), test.Redact(b.err))
	}
	if a.result.Changed == b.result.Changed || a.result.Revision != b.result.Revision {
		t.Fatal("concurrent release was not published exactly once")
	}
}

func TestNonemptyCatalogIsNotGenesisAndGrantDriftCannotBecomeANewBaseline(t *testing.T) {
	for _, tc := range []struct {
		name, sql, reason string
		advance           bool
	}{
		{"nonempty genesis", "UPDATE authz_state SET release_sequence=0 WHERE singleton", "predecessor_mismatch", false},
		{"rewritten grant id", "UPDATE policy_rule SET rule_id='00000000-0000-4000-8000-000000000888' WHERE rule_id=(SELECT rule_id FROM policy_rule WHERE managed_by='code' LIMIT 1)", "not_ready", false},
		{"omitted drifted grant", "UPDATE policy_rule SET rule_id='00000000-0000-4000-8000-000000000888' WHERE rule_id=(SELECT rule_id FROM policy_rule WHERE managed_by='code' LIMIT 1)", "not_ready", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := test.NewDatabase(t)
			conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
			if err != nil {
				t.Fatal(test.Redact(err))
			}
			defer func() {
				if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
					t.Error(test.Redact(err))
				}
			}()
			if _, err := conn.Exec(t.Context(), "SET session_replication_role=replica; "+tc.sql+"; SET session_replication_role=origin"); err != nil {
				t.Fatal(test.Redact(err))
			}
			source := declarations.Source()
			if tc.advance {
				source.Sequence, source.Predecessor = "7", "6"
				source.DefaultGrants = []manifest.DefaultGrant{}
			}
			_, err = reconcile(t.Context(), s.Runner, productRelease(t, source))
			var rejected *manifest.Rejection
			if !errors.As(err, &rejected) || rejected.Reason != tc.reason {
				t.Fatalf("wrong rejection: %s", test.Redact(err))
			}
		})
	}
}
