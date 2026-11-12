package audit

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
)

var auditIdentifier = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,95}$`)
var auditUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var auditHash = regexp.MustCompile(`^[0-9a-f]{64}$`)
var auditInteger = regexp.MustCompile(`^(0|[1-9][0-9]*|-[1-9][0-9]*)$`)

func describeFull(tx *database.Tx, event Event) (metadata, error) {
	m := metadata{}
	if !auditUUID.MatchString(event.Actor) || event.Purge != nil {
		return m, ErrInvalidEvent
	}
	if d, ok := event.Detail.(ManifestSync); ok {
		revision, err := strconv.ParseInt(tx.Revision, 10, 64)
		sequence, seqErr := strconv.ParseInt(d.Sequence, 10, 64)
		if event.Kind != KindManifestSync || tx.Mode != database.ModeSync || err != nil || seqErr != nil || sequence < 1 || revision < 0 || revision == math.MaxInt64 || d.PublishedRevision != strconv.FormatInt(revision+1, 10) || !auditHash.MatchString(d.Hash) {
			return m, ErrInvalidEvent
		}
		m.ResultingRevision, m.Sequence, m.Hash = d.PublishedRevision, d.Sequence, d.Hash
		return m, nil
	}
	if _, ok := event.Detail.(Access); !ok {
		revision, err := resultingRevision(tx)
		if err != nil {
			return m, err
		}
		m.ResultingRevision = revision
	} else if tx.Mode != database.ModeRead && tx.Mode != database.ModeWrite && tx.Mode != database.ModeAdmin && tx.Mode != database.ModeIdentity && tx.Mode != database.ModeRevoke {
		return m, ErrInvalidEvent
	}
	valid := false
	switch d := event.Detail.(type) {
	case Access:
		valid = strings.HasPrefix(string(event.Kind), "access.") && auditIdentifier.MatchString(strings.TrimPrefix(string(event.Kind), "access.")) && permissionValid(d.Permission) && rootMetadata(&m, d.Root, false)
		if d.Target != nil {
			valid = valid && d.Root != nil && requestedMetadata(&m, *d.Target, false) && d.Target.ObjectID == ""
		}
	case DataUpdate:
		valid = event.Kind == "data.update" && permissionValid(d.Permission) && rootMetadata(&m, d.Root, false) && requestedMetadata(&m, d.Target, d.Root == nil || d.Root.Outcome == "ok")
		if d.Root != nil && d.Root.Outcome == "absent" {
			valid = valid && d.Target.ObjectID == ""
		}
	case AccountChange:
		valid = accountKind(event.Kind) && permissionValid(d.Permission) && auditUUID.MatchString(d.TargetUserID) && rootMetadata(&m, d.Root, event.Kind == "account.provision")
		m.TargetUserID = d.TargetUserID
	case ModuleChange:
		valid = moduleKind(event.Kind) && permissionValid(d.Permission) && requestedMetadata(&m, d.Target, true) && rootMetadata(&m, d.Root, true)
	case PermissionChange:
		valid = permissionKind(event.Kind) && permissionValid(d.Permission) && requestedMetadata(&m, d.Target, true) && rootMetadata(&m, d.Root, true) && permissionMetadata(&m, event.Kind, d)
	case Enrollment:
		valid = (event.Kind == "identity.enroll" || event.Kind == "identity.invite") && userMethod(&m, d.TargetUserID, d.Method)
	case RootBootstrap:
		valid = event.Kind == "root.bootstrap" && userMethod(&m, d.TargetUserID, d.Method) && auditUUID.MatchString(d.OperationID)
		m.OperationID = d.OperationID
	case RootReissue:
		valid = event.Kind == "root.reissue" && userMethod(&m, d.TargetUserID, d.Method)
	case RootSetEmail:
		valid = event.Kind == "root.set-email" && auditUUID.MatchString(d.TargetUserID) && auditUUID.MatchString(d.OperationID)
		m.TargetUserID, m.OperationID = d.TargetUserID, d.OperationID
	case OfflineRevoke:
		valid = (event.Kind == "root.revoke" || event.Kind == "identity.mfa-reset") && auditUUID.MatchString(d.TargetUserID) && auditUUID.MatchString(d.OperationID) && d.Approval != "" && len(d.Approval) <= 256 && utf8.ValidString(d.Approval) && !strings.ContainsRune(d.Approval, 0) && strings.TrimSpace(d.Reason) != "" && len(d.Reason) <= 2048 && utf8.ValidString(d.Reason) && !strings.ContainsRune(d.Reason, 0)
		m.TargetUserID, m.OperationID, m.Approval = d.TargetUserID, d.OperationID, d.Approval
	}
	if !valid {
		return metadata{}, ErrInvalidEvent
	}
	return m, nil
}

func permissionValid(permission string) bool {
	return strings.Contains(permission, ".") && auditIdentifier.MatchString(permission)
}

func rootMetadata(m *metadata, root *RootOutcome, onlyOK bool) bool {
	if root == nil {
		return true
	}
	if root.Outcome != "ok" && (onlyOK || root.Outcome != "absent") {
		return false
	}
	m.PrincipalKind, m.Outcome = "root", root.Outcome
	return true
}

func requestedMetadata(m *metadata, target RequestedKey, objectRequired bool) bool {
	if !auditIdentifier.MatchString(target.Resource) || (objectRequired && !auditUUID.MatchString(target.ObjectID)) || (target.ObjectID != "" && !auditUUID.MatchString(target.ObjectID)) {
		return false
	}
	m.Resource, m.KeyKind = target.Resource, string(target.KeyKind)
	switch target.KeyKind {
	case core.KeyUUID:
		if !auditUUID.MatchString(target.Key) {
			return false
		}
		m.Key = target.Key
	case core.KeyInteger:
		if !auditInteger.MatchString(target.Key) {
			return false
		}
		if _, err := strconv.ParseInt(target.Key, 10, 64); err != nil {
			return false
		}
		m.Key = target.Key
	case core.KeyString:
		if target.Key == "" || len(target.Key) > core.MaxKeyBytes || !utf8.ValidString(target.Key) || strings.ContainsRune(target.Key, 0) {
			return false
		}
	default:
		return false
	}
	return true
}

func permissionMetadata(m *metadata, kind Kind, d PermissionChange) bool {
	if slices.Contains([]Kind{KindPermissionBoundaryAssign, KindPermissionBoundaryRevoke}, kind) {
		if d.RoleKey != "" || d.GrantCount != nil || d.GrantsDigest != "" {
			return false
		}
	} else if slices.Contains([]Kind{KindPermissionRoleAssign, KindPermissionRoleRevoke}, kind) {
		if d.BoundaryKey != "" || d.BoundaryVersion != nil || d.GrantCount != nil || d.GrantsDigest != "" {
			return false
		}
	} else {
		if d.BoundaryKey != "" || d.BoundaryVersion != nil || d.TargetUserID != "" {
			return false
		}
	}
	if d.RoleKey != "" && !auditIdentifier.MatchString(d.RoleKey) || d.BoundaryKey != "" && !auditIdentifier.MatchString(d.BoundaryKey) || d.GrantsDigest != "" && !auditHash.MatchString(d.GrantsDigest) || d.TargetUserID != "" && !auditUUID.MatchString(d.TargetUserID) {
		return false
	}
	m.RoleKey, m.BoundaryKey, m.GrantsDigest, m.TargetUserID = d.RoleKey, d.BoundaryKey, d.GrantsDigest, d.TargetUserID
	if d.GrantCount != nil {
		if *d.GrantCount < 0 || *d.GrantCount > keys.MaxRoleGrants {
			return false
		}
		m.GrantCount = strconv.Itoa(*d.GrantCount)
	}
	if d.BoundaryVersion != nil {
		if *d.BoundaryVersion < 1 || *d.BoundaryVersion > math.MaxInt32 {
			return false
		}
		m.BoundaryVersion = strconv.Itoa(*d.BoundaryVersion)
	}
	return true
}

func userMethod(m *metadata, user, method string) bool {
	if !auditUUID.MatchString(user) || method != "local" && method != "oidc" {
		return false
	}
	m.TargetUserID, m.Method = user, method
	return true
}

func accountKind(kind Kind) bool {
	return slices.Contains([]Kind{KindAccountSuspend, KindAccountReactivate, KindAccountProvision, KindIdentityEmailChange, KindIdentityMfaResetByPermission, KindIdentityBindingReset}, kind)
}

func permissionKind(kind Kind) bool {
	return slices.Contains([]Kind{KindPermissionRoleCreate, KindPermissionRoleUpdate, KindPermissionRoleDelete, KindPermissionRoleAssign, KindPermissionRoleRevoke, KindPermissionBoundaryAssign, KindPermissionBoundaryRevoke}, kind)
}

func moduleKind(kind Kind) bool {
	return slices.Contains([]Kind{KindHRRequestSubmit, KindHRRequestDecideLead, KindHRRequestDecideFinal, KindHRRequestCancel, KindHRRequestCancelApproved, KindHRRequestSelfApprove, KindHRLeaveAdjust, KindHRAttendanceAdjust, KindHREmployeeCreate, KindHREmployeeUpdate, KindHREmployeeStatus, KindHREmployeeLinkAccount, KindHREmployeeIdentityUpdate, KindHRLeaveRateAdjust, KindHRTeamCreate, KindHRTeamUpdate, KindHRTeamAssign, KindHRWorkCalendarUpdate, KindHRWorkScheduleUpdate, KindHREmployeeScheduleUpdate, KindHRAttendancePeriodClose, KindHRAttendancePeriodReopen, KindSettingUpdate}, kind)
}
