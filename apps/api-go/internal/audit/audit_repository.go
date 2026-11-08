// Package audit appends typed events to audit_outbox in the caller's transaction, so an effect and its
// event commit or roll back together. There is no free-form metadata: only the fields of Event are written,
// never a token, a secret, an email or a subject.
package audit

import (
	"encoding/json/v2"
	"errors"
	"math"
	"strconv"

	"hrm/api-go/internal/database"
)

// Kind is the stored event_kind.
type Kind string

const (
	KindLogout                Kind = "identity.logout"
	KindLogoutAll             Kind = "identity.logout-all"
	KindOIDCActivation        Kind = "identity.oidc-activation"
	KindOIDCLogin             Kind = "identity.oidc-login"
	KindEmailVerify           Kind = "identity.email-verify"
	KindMFASetup              Kind = "identity.mfa-setup"
	KindMFAEnroll             Kind = "identity.mfa-enroll"
	KindMFAVerify             Kind = "identity.mfa-verify"
	KindMFARecovery           Kind = "identity.mfa-recovery"
	KindMFARecoveryRegenerate Kind = "identity.mfa-recovery-regenerate"
	KindMFARemove             Kind = "identity.mfa-remove"
	KindMFAVerifyFailed       Kind = "identity.mfa-verify-failed"
	KindMFALockout            Kind = "identity.mfa-lockout"
	// KindSessionPurge is offline maintenance; it records counts only.
	KindSessionPurge Kind = "identity.session-purge"
)

// OfflineActor is the actor_id of offline commands: no product user acts.
const OfflineActor = "00000000-0000-4000-8000-000000000001"

const maxRetentionDays = 3650

// ErrInvalidEvent is an event outside the contract or a transaction that cannot record one; nothing is
// written.
var ErrInvalidEvent = errors.New("audit: invalid event")

var ownAccountKinds = map[Kind]bool{
	KindLogout: true, KindLogoutAll: true, KindOIDCActivation: true, KindOIDCLogin: true,
	KindEmailVerify: true, KindMFASetup: true, KindMFAEnroll: true, KindMFAVerify: true,
	KindMFARecovery: true, KindMFARecoveryRegenerate: true, KindMFARemove: true,
	KindMFAVerifyFailed: true, KindMFALockout: true,
}

// SessionPurge is the detail of KindSessionPurge.
type SessionPurge struct{ Deleted, RetentionDays int }

// Event is one audit record. Actor is the account the own-account event is about; Purge is set for
// KindSessionPurge only.
type Event struct {
	Kind  Kind
	Actor string
	Purge *SessionPurge
}

type metadata struct {
	ResultingRevision string `json:"resultingRevision"`
	Deleted           string `json:"deleted,omitempty"`
	RetentionDays     string `json:"retentionDays,omitempty"`
}

const insertEvent = `INSERT INTO audit_outbox(event_id,actor_id,event_kind,permission_key,object_id,policy_revision,occurred_at,reason,safe_metadata) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,statement_timestamp(),$6,$7)`

// resultingRevision is the revision this transaction commits: the runner bumps revoke, admin and bootstrap
// by one.
func resultingRevision(tx *database.Tx) (string, error) {
	revision, err := strconv.ParseInt(tx.Revision, 10, 64)
	if err != nil {
		return "", ErrInvalidEvent
	}
	switch tx.Mode {
	case database.ModeWrite, database.ModeIdentity:
		return tx.Revision, nil
	case database.ModeRevoke, database.ModeAdmin, database.ModeBootstrap:
		if revision == math.MaxInt64 {
			return "", ErrInvalidEvent
		}
		return strconv.FormatInt(revision+1, 10), nil
	case database.ModeRead, database.ModeSync:
		return "", ErrInvalidEvent
	}
	return "", ErrInvalidEvent
}

func describe(tx *database.Tx, event Event) (metadata, error) {
	if event.Actor == "" {
		return metadata{}, ErrInvalidEvent
	}
	switch {
	case ownAccountKinds[event.Kind] && event.Purge == nil:
	case event.Kind == KindSessionPurge && event.Purge != nil && event.Purge.Deleted > 0 &&
		event.Purge.RetentionDays >= 0 && event.Purge.RetentionDays <= maxRetentionDays:
	default:
		return metadata{}, ErrInvalidEvent
	}
	resulting, err := resultingRevision(tx)
	if err != nil {
		return metadata{}, err
	}
	described := metadata{ResultingRevision: resulting}
	if event.Purge != nil {
		described.Deleted = strconv.Itoa(event.Purge.Deleted)
		described.RetentionDays = strconv.Itoa(event.Purge.RetentionDays)
	}
	return described, nil
}

// Append writes one event in tx. policy_revision is the revision the transaction evaluated under its fence.
func Append(tx *database.Tx, event Event) error {
	described, err := describe(tx, event)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(described)
	if err != nil {
		return err
	}
	_, err = tx.Exec(insertEvent, event.Actor, []byte(event.Kind), nil, nil, tx.Revision, nil, string(encoded))
	return err
}
