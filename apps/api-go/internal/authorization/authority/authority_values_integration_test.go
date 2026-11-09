//go:build integration

package authority_test

import (
	"errors"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/gateway"
	"hrm/api-go/internal/authorization/manifest"
	"hrm/api-go/test/fixture"
)

func TestAuthorityKeepsIntegerKeysAndTimestampMicroseconds(t *testing.T) {
	f := newAuthorityFixture(t)
	root := fixture.Root(t, f.s)
	secret := fixture.Session(t, f.s, root.ID, fixture.SessionSpec{})
	source := declarations.Source()
	source.Sequence = "7"
	source.Predecessor = "6"
	source.Declarations.Resources = append(source.Declarations.Resources, core.ResourceDeclaration{Key: "event", KeyKind: core.KeyInteger, Fields: map[string]core.FieldType{"occurredAt": {Kind: core.FieldTimestamp}}, Actions: map[string]core.ActionDeclaration{"read": {Policy: core.RelationRef{Key: "readable", Version: 1}, Boundary: core.BoundaryOptional}, "update": {Policy: core.RelationRef{Key: "hrWrite", Version: 1}, Boundary: core.BoundaryOptional}}})
	c, err := declarations.NewCore()
	requireDB(t, err)
	release, err := manifest.Prepare(source, c)
	requireDB(t, err)
	reconciler, err := manifest.NewReconciler(f.s.Runner, c, declarations.RuntimeCapabilities())
	requireDB(t, err)
	_, err = manifest.Reconcile(t.Context(), reconciler, release)
	requireDB(t, err)
	f.exec(t, `CREATE TABLE authority_event(id bigint PRIMARY KEY,object_id uuid NOT NULL,occurred_at timestamptz NOT NULL);GRANT SELECT,UPDATE(occurred_at) ON authority_event TO product_data`)
	f.exec(t, `INSERT INTO authority_event VALUES(9007199254740993,'b2000000-0000-4000-8000-000000000001','2026-10-14T12:00:00.000001Z')`)
	storage := declarations.Bindings()
	storage.Resources = append(storage.Resources, compiler.ResourceBinding{Resource: "event", Table: "authority_event", KeyColumn: "id", ObjectIDColumn: "object_id", Columns: map[string]string{"occurredAt": "occurred_at"}, Projection: []string{"occurredAt"}})
	bindings, err := compiler.NewRegistry(c, release.Declarations(), storage)
	requireDB(t, err)
	a, err := authority.New(f.s.Runner, bindings, authority.DefaultCapabilities(), []authority.ResourceWrite{{Resource: "event", Action: "update", Fields: []string{"occurredAt"}}})
	requireDB(t, err)
	for _, value := range []string{"2026-10-14T12:00:00.123456Z", "2026-10-14T12:00:00.1Z"} {
		updated, err := a.Update(t.Context(), secret, "event", "update", "9007199254740993", map[string]core.Scalar{"occurredAt": core.Text(value)})
		requireDB(t, err)
		if !updated {
			t.Fatal("large integer key was rounded")
		}
		page, err := a.List(t.Context(), secret, "event", "read", gateway.ListQuery{})
		requireDB(t, err)
		if len(page.Items) != 1 {
			t.Fatal("event absent")
		}
		key, _ := page.Items[0]["key"].AsText()
		stamp, _ := page.Items[0]["occurredAt"].AsText()
		want := value
		if value == "2026-10-14T12:00:00.1Z" {
			want = "2026-10-14T12:00:00.100000Z"
		}
		if key != "9007199254740993" || stamp != want {
			t.Fatalf("integer/timestamp precision lost: key=%s stamp=%s", key, stamp)
		}
	}
	for _, value := range []string{"2026-02-30T00:00:00Z", "2026-10-14T12:00:00.1234567Z", "invalid"} {
		_, err := a.Update(t.Context(), secret, "event", "update", "9007199254740993", map[string]core.Scalar{"occurredAt": core.Text(value)})
		if !errors.Is(err, apperror.ErrAccessDenied) {
			t.Fatal("malformed timestamp accepted")
		}
	}
}
