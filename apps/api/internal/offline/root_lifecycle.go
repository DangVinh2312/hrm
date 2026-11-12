package offline

import (
	"context"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/audit"
	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/database"
)

const (
	lockRootForEmail = `SELECT u.email_canonical email,u.kind='root' AND u.state='active' eligible
       FROM app_user u WHERE u.id=$1 FOR NO KEY UPDATE`
	setRootEmail = `UPDATE app_user SET email_canonical=$2,email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`
	suspendRoot  = `WITH revoked AS (UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1 AND kind='root' AND state<>'suspended' RETURNING 1) SELECT * FROM revoked`
)

// RootEmail is a validated email change of the Root; only NewRootEmail makes a usable one.
type RootEmail struct{ userID, operationID, email string }

// NewRootEmail canonicalizes the email; it is PII, so it is never logged or audited.
func NewRootEmail(c *core.Core, userID, operationID, email string) (RootEmail, error) {
	canonical, err := credential.CanonicalLoginEmail(email)
	if err != nil || !c.IsCanonicalUUID(userID) || !c.IsCanonicalUUID(operationID) || userID == audit.OfflineActor {
		return RootEmail{}, rejection("invalid_release")
	}
	return RootEmail{userID: userID, operationID: operationID, email: canonical}, nil
}

// SetRootEmail gives the active Root a new email, unverified until a verified IdP claim of it at login;
// auth_epoch advances in the same row update, which ends every session. Any other account is a collision.
func SetRootEmail(ctx context.Context, runner *database.Runner, input RootEmail) (bool, error) {
	if input.userID == "" {
		return false, rejection("invalid_release")
	}
	return database.Run(ctx, runner, database.ModeBootstrap, func(_ context.Context, tx *database.Tx) (bool, error) {
		type target struct {
			Email    *string `db:"email"`
			Eligible bool    `db:"eligible"`
		}
		rows, err := tx.Query(lockRootForEmail, input.userID)
		if err != nil {
			return false, err
		}
		targets, err := pgx.CollectRows(rows, pgx.RowToStructByName[target])
		if err != nil {
			return false, err
		}
		if len(targets) != 1 || !targets[0].Eligible {
			return false, rejection("collision")
		}
		if targets[0].Email != nil && *targets[0].Email == input.email {
			return false, nil
		}
		if _, err := tx.Exec(setRootEmail, input.userID, input.email); err != nil {
			if database.IsUniqueViolation(err) {
				return false, rejection("collision")
			}
			return false, err
		}
		return true, audit.Append(tx, audit.Event{Kind: audit.KindRootSetEmail, Actor: audit.OfflineActor,
			Detail: audit.RootSetEmail{TargetUserID: input.userID, OperationID: input.operationID}})
	}, database.RunOptions{})
}

// RootRevocation is a validated revocation; only NewRootRevocation makes a usable one. The approval is the
// reference of an independent approval record, never a secret.
type RootRevocation struct{ userID, operationID, approval, reason string }

func NewRootRevocation(c *core.Core, userID, operationID, approval, reason string) (RootRevocation, error) {
	if !c.IsCanonicalUUID(userID) || !c.IsCanonicalUUID(operationID) ||
		!printable(approval, maxApprovalUnits) || !printable(reason, maxReasonUnits) {
		return RootRevocation{}, rejection("invalid_release")
	}
	return RootRevocation{userID: userID, operationID: operationID, approval: approval, reason: reason}, nil
}

// RevokeRoot suspends the Root and ends its sessions; the marker stays, so no new Root can follow.
func RevokeRoot(ctx context.Context, runner *database.Runner, input RootRevocation) (bool, error) {
	if input.userID == "" {
		return false, rejection("invalid_release")
	}
	return database.Run(ctx, runner, database.ModeBootstrap, func(_ context.Context, tx *database.Tx) (bool, error) {
		rows, err := tx.Query(suspendRoot, input.userID)
		if err != nil {
			return false, err
		}
		revoked, err := pgx.CollectRows(rows, pgx.RowTo[int32])
		if err != nil || len(revoked) == 0 {
			return false, err
		}
		return true, audit.Append(tx, audit.Event{Kind: audit.KindRootRevoke, Actor: audit.OfflineActor,
			Detail: audit.OfflineRevoke{TargetUserID: input.userID, OperationID: input.operationID, Approval: input.approval, Reason: input.reason}})
	}, database.RunOptions{})
}
