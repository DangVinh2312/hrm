package manifest_test

import (
	"errors"
	"strconv"
	"testing"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/internal/authorization/values"
	"hrm/api-go/internal/database"
)

func TestPrepareRejectsInvalidReleaseBeforeHash(t *testing.T) {
	c, err := core.New(values.Codecs())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manifest.Prepare(declarations.Source(), c); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*manifest.Source){
		"zero source":                 func(s *manifest.Source) { *s = manifest.Source{} },
		"invalid sequence":            func(s *manifest.Source) { s.Sequence = "invalid" },
		"predecessor equals sequence": func(s *manifest.Source) { s.Predecessor = s.Sequence },
		"reserved system role": func(s *manifest.Source) {
			s.Roles = append(s.Roles, manifest.Role{Key: "system.admin", Label: "Admin"})
		},
		"reserved runtime role": func(s *manifest.Source) {
			s.Roles = append(s.Roles, manifest.Role{Key: "custom.admin", Label: "Admin"})
		},
		"invalid utf8 label": func(s *manifest.Source) {
			s.Roles = append(s.Roles, manifest.Role{Key: "admin", Label: string([]byte{0xff})})
		},
		"nul label":      func(s *manifest.Source) { s.Roles[0].Label = "private\x00label" },
		"duplicate role": func(s *manifest.Source) { s.Roles = append(s.Roles, s.Roles[0]) },
		"blank label":    func(s *manifest.Source) { s.Roles[0].Label = "  " },
		"role limit": func(s *manifest.Source) {
			for i := range 201 {
				s.Roles = append(s.Roles, manifest.Role{Key: "extra" + strconv.Itoa(i), Label: "Extra"})
			}
		},
		"grant limit": func(s *manifest.Source) {
			g := s.DefaultGrants[0]
			for range 1001 {
				s.DefaultGrants = append(s.DefaultGrants, g)
			}
		},
		"unknown permission":        func(s *manifest.Source) { s.DefaultGrants[0].Permission = "document.missing" },
		"wrong resource template":   func(s *manifest.Source) { s.DefaultGrants[0].Template = core.RelationRef{Key: "company", Version: 1} },
		"unknown parameter":         func(s *manifest.Source) { s.DefaultGrants[0].Parameters["unexpected"] = core.Text("value") },
		"overlapping grant removal": func(s *manifest.Source) { s.RemoveDefaultGrants = []manifest.DefaultGrant{s.DefaultGrants[0]} },
		"duplicate grant removal": func(s *manifest.Source) {
			g := s.DefaultGrants[0]
			s.DefaultGrants = s.DefaultGrants[1:]
			s.RemoveDefaultGrants = []manifest.DefaultGrant{g, g}
		},
		"invalid boundary identity": func(s *manifest.Source) {
			s.BoundaryBindings = []manifest.BoundaryBinding{{Owner: "fixture", Identity: "invalid", Permission: "account.suspend", Boundary: core.RelationRef{Key: "accountAdministration", Version: 1}}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			source := declarations.Source()
			mutate(&source)
			if _, err := manifest.Prepare(source, c); err == nil {
				t.Fatal("invalid release accepted")
			}
		})
	}
}

func TestReconcileRefusesMissingCapabilityAndUnpreparedReleaseBeforeDatabase(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	source := declarations.Source()
	source.Declarations.Capabilities.Validators = append(source.Declarations.Capabilities.Validators, "future@1")
	release, err := manifest.Prepare(source, c)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := database.NewRunner(nil, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	reconciler, err := manifest.NewReconciler(runner, c, declarations.RuntimeCapabilities())
	if err != nil {
		t.Fatal(err)
	}
	otherCore, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	otherRelease, err := manifest.Prepare(declarations.Source(), otherCore)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		release manifest.Release
		reason  string
	}{{release, "missing_capability"}, {manifest.Release{}, "invalid_release"}, {otherRelease, "invalid_release"}} {
		_, err := manifest.Reconcile(t.Context(), reconciler, tc.release)
		var rejected *manifest.Rejection
		if !errors.As(err, &rejected) || rejected.Reason != tc.reason {
			t.Fatalf("wrong rejection: %v", err)
		}
	}
	available := declarations.RuntimeCapabilities()
	available.Validators = append(available.Validators, "unregistered@1")
	cloned, err := manifest.NewReconciler(runner, c, available)
	if err != nil {
		t.Fatal(err)
	}
	available.Validators[1] = "future@1"
	_, err = manifest.Reconcile(t.Context(), cloned, release)
	var rejected *manifest.Rejection
	if !errors.As(err, &rejected) || rejected.Reason != "missing_capability" {
		t.Fatalf("constructor kept mutable capabilities: %v", err)
	}
}

func TestPrepareRejectsInvalidTimestampLiteralsBeforeAnyDatabaseWork(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"2026-02-30T00:00:00Z", "2026-01-01T00:00:00", "2026-01-01T00:00:00.0000001Z", "not-a-date"} {
		source := declarations.Source()
		for i := range source.Declarations.Resources {
			if source.Declarations.Resources[i].Key == "document" {
				source.Declarations.Resources[i].Fields["occurredAt"] = core.FieldType{Kind: core.FieldTimestamp}
			}
		}
		for i := range source.Declarations.Policies {
			if source.Declarations.Policies[i].Key == "readable" {
				source.Declarations.Policies[i].RequiredScope = core.CompareExpr{Op: core.OpLte, Field: "occurredAt", Value: core.ValueRef{From: core.SourceLiteral, Literal: core.TextValue(value)}}
			}
		}
		if _, err := manifest.Prepare(source, c); err == nil {
			t.Fatalf("invalid timestamp literal accepted: %s", value)
		}
	}
}
