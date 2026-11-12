package audit

import "hrm/api/internal/authorization/core"

const KindManifestSync Kind = "manifest.sync"

type Detail interface{ auditDetail() }

type RootOutcome struct{ Outcome string }
type RequestedKey struct {
	Resource string
	KeyKind  core.KeyKind
	Key      string
	ObjectID string
}
type Access struct {
	Permission string
	Root       *RootOutcome
	Target     *RequestedKey
}
type DataUpdate struct {
	Permission string
	Root       *RootOutcome
	Target     RequestedKey
}
type AccountChange struct {
	Permission   string
	TargetUserID string
	Root         *RootOutcome
}
type ModuleChange struct {
	Permission string
	Target     RequestedKey
	Root       *RootOutcome
}
type PermissionChange struct {
	Permission      string
	Target          RequestedKey
	Root            *RootOutcome
	RoleKey         string
	GrantCount      *int
	GrantsDigest    string
	BoundaryKey     string
	BoundaryVersion *int
	TargetUserID    string
}
type ManifestSync struct {
	Sequence          string
	Hash              string
	PublishedRevision string
}
type Enrollment struct{ TargetUserID, Method string }
type RootBootstrap struct{ TargetUserID, OperationID, Method string }
type RootReissue struct{ TargetUserID, Method string }
type RootSetEmail struct{ TargetUserID, OperationID string }
type OfflineRevoke struct{ TargetUserID, OperationID, Approval, Reason string }

func (Access) auditDetail()           {}
func (DataUpdate) auditDetail()       {}
func (AccountChange) auditDetail()    {}
func (ModuleChange) auditDetail()     {}
func (PermissionChange) auditDetail() {}
func (ManifestSync) auditDetail()     {}
func (Enrollment) auditDetail()       {}
func (RootBootstrap) auditDetail()    {}
func (RootReissue) auditDetail()      {}
func (RootSetEmail) auditDetail()     {}
func (OfflineRevoke) auditDetail()    {}

func eventColumns(detail Detail) ([]byte, *string, *string) {
	var permission string
	var objectID string
	var reason *string
	switch d := detail.(type) {
	case Access:
		permission = d.Permission
	case DataUpdate:
		permission = d.Permission
		objectID = d.Target.ObjectID
	case AccountChange:
		permission = d.Permission
	case ModuleChange:
		permission = d.Permission
		objectID = d.Target.ObjectID
	case PermissionChange:
		permission = d.Permission
		objectID = d.Target.ObjectID
	case OfflineRevoke:
		reason = &d.Reason
	}
	var object *string
	if objectID != "" {
		object = &objectID
	}
	var encoded []byte
	if permission != "" {
		encoded = []byte(permission)
	}
	return encoded, object, reason
}
