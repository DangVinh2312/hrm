package audit

import (
	"encoding/json/v2"
	"slices"
	"strings"
	"testing"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

func TestTypedManifestAuditChecksPublishedRevision(t *testing.T) {
	tx := &database.Tx{Mode: database.ModeSync, Revision: "7"}
	good := Event{Kind: KindManifestSync, Actor: OfflineActor, Detail: ManifestSync{Sequence: "6", Hash: "5eda10c91670ac19fc707e0f505ed11c0014468b58f86ee7bee1a9532bbe6112", PublishedRevision: "8"}}
	if _, err := describe(tx, good); err != nil {
		t.Fatal(err)
	}
	for _, detail := range []Detail{nil, ManifestSync{Sequence: "6", Hash: "wrong", PublishedRevision: "8"}, ManifestSync{Sequence: "6", Hash: "5eda10c91670ac19fc707e0f505ed11c0014468b58f86ee7bee1a9532bbe6112", PublishedRevision: "7"}, Access{Permission: "employee.read"}} {
		bad := good
		bad.Detail = detail
		if _, err := describe(tx, bad); err == nil {
			t.Fatal("invalid manifest detail accepted")
		}
	}
}

func TestAccessMetadataKeepsRootMarkerAndOmitsStringKeys(t *testing.T) {
	tx := &database.Tx{Mode: database.ModeRead, Revision: "7"}
	event := Event{Kind: "access.document.read", Actor: OfflineActor, Detail: Access{Permission: "document.read", Root: &RootOutcome{Outcome: "absent"}, Target: &RequestedKey{Resource: "document", KeyKind: core.KeyString, Key: "private-reference"}}}
	m, err := describe(tx, event)
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "private-reference") || strings.Contains(string(b), "resultingRevision") || m.PrincipalKind != "root" || m.Outcome != "absent" {
		t.Fatal("unsafe access metadata")
	}
}

func TestWrongKindDetailAndUnsafePermissionMetadataAreRejected(t *testing.T) {
	tx := &database.Tx{Mode: database.ModeAdmin, Revision: "7"}
	target := RequestedKey{Resource: "role", KeyKind: core.KeyUUID, Key: OfflineActor, ObjectID: OfflineActor}
	tooMany := 301
	for _, event := range []Event{
		{Kind: KindLogout, Actor: OfflineActor, Detail: ManifestSync{}},
		{Kind: "permission.role-create", Actor: OfflineActor, Detail: ModuleChange{Permission: "role.create", Target: target}},
		{Kind: "permission.role-create", Actor: OfflineActor, Detail: PermissionChange{Permission: "role.create", Target: target, RoleKey: "private@example.test"}},
		{Kind: "permission.role-create", Actor: OfflineActor, Detail: PermissionChange{Permission: "role.create", Target: target, GrantCount: &tooMany}},
		{Kind: "permission.boundary-assign", Actor: OfflineActor, Detail: PermissionChange{Permission: "account.bindBoundary", Target: target, RoleKey: "custom.fixture"}},
		{Kind: "hr.team.update", Actor: OfflineActor, Detail: ModuleChange{Permission: "team.update", Target: target, Root: &RootOutcome{Outcome: "absent"}}},
	} {
		if _, err := describe(tx, event); err == nil {
			t.Fatal("unsafe audit event accepted")
		}
	}
}

func TestEveryPermissionKindRecordsOnlyTypedDetailAsStrings(t *testing.T) {
	tx := &database.Tx{Mode: database.ModeAdmin, Revision: "7"}
	target := RequestedKey{Resource: "role", KeyKind: core.KeyUUID, Key: OfflineActor, ObjectID: OfflineActor}
	count, version := 0, 1
	digest := strings.Repeat("a", 64)
	for _, kind := range []Kind{KindPermissionRoleCreate, KindPermissionRoleUpdate, KindPermissionRoleDelete, KindPermissionRoleAssign, KindPermissionRoleRevoke, KindPermissionBoundaryAssign, KindPermissionBoundaryRevoke} {
		detail := PermissionChange{Permission: "role.update", Target: target}
		if slices.Contains([]Kind{KindPermissionRoleCreate, KindPermissionRoleUpdate, KindPermissionRoleDelete}, kind) {
			detail.RoleKey = "custom.fixture"
			detail.GrantCount = &count
			detail.GrantsDigest = digest
		} else if slices.Contains([]Kind{KindPermissionRoleAssign, KindPermissionRoleRevoke}, kind) {
			detail.RoleKey = "custom.fixture"
			detail.TargetUserID = OfflineActor
		} else {
			detail.BoundaryKey = "accountAdministration"
			detail.BoundaryVersion = &version
			detail.TargetUserID = OfflineActor
		}
		m, err := describe(tx, Event{Kind: kind, Actor: OfflineActor, Detail: detail})
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if m.ResultingRevision != "8" || m.RoleKey != detail.RoleKey || m.TargetUserID != detail.TargetUserID || m.BoundaryKey != detail.BoundaryKey || m.GrantsDigest != detail.GrantsDigest {
			t.Fatalf("%s: metadata mismatch", kind)
		}
		if detail.GrantCount != nil && m.GrantCount != "0" || detail.BoundaryVersion != nil && m.BoundaryVersion != "1" {
			t.Fatalf("%s: numeric metadata was not stringified", kind)
		}
	}
}

func TestAccountAndOfflineDetailsKeepDistinctTargetAndResultingRevision(t *testing.T) {
	tx := &database.Tx{Mode: database.ModeBootstrap, Revision: "7"}
	target := "00000000-0000-4000-8000-000000000002"
	for _, event := range []Event{
		{Kind: KindAccountSuspend, Actor: OfflineActor, Detail: AccountChange{Permission: "account.suspend", TargetUserID: target}},
		{Kind: KindAccountProvision, Actor: OfflineActor, Detail: AccountChange{Permission: "account.provision", TargetUserID: target, Root: &RootOutcome{Outcome: "ok"}}},
		{Kind: KindIdentityInvite, Actor: OfflineActor, Detail: Enrollment{TargetUserID: target, Method: "oidc"}},
		{Kind: KindRootBootstrap, Actor: OfflineActor, Detail: RootBootstrap{TargetUserID: target, OperationID: OfflineActor, Method: "oidc"}},
		{Kind: KindRootReissue, Actor: OfflineActor, Detail: RootReissue{TargetUserID: target, Method: "oidc"}},
		{Kind: KindRootSetEmail, Actor: OfflineActor, Detail: RootSetEmail{TargetUserID: target, OperationID: OfflineActor}},
		{Kind: KindRootRevoke, Actor: OfflineActor, Detail: OfflineRevoke{TargetUserID: target, OperationID: OfflineActor, Approval: "fixture-approval", Reason: "fixture reason"}},
		{Kind: KindIdentityMfaReset, Actor: OfflineActor, Detail: OfflineRevoke{TargetUserID: target, OperationID: OfflineActor, Approval: "fixture-approval", Reason: "fixture reason"}},
	} {
		m, err := describe(tx, event)
		if err != nil {
			t.Fatalf("%s: %v", event.Kind, err)
		}
		if m.TargetUserID != target || m.ResultingRevision != "8" {
			t.Fatalf("%s: wrong target or revision", event.Kind)
		}
	}
}
