package offline

import (
	"context"
	"errors"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

const (
	maxApprovalUnits = 200
	maxReasonUnits   = 1000

	lockTargetKind      = `SELECT kind FROM app_user WHERE id=$1 FOR NO KEY UPDATE`
	deleteRecoveryCodes = `DELETE FROM mfa_recovery_code WHERE user_id=$1`
	deleteSecondFactor  = `WITH removed AS (DELETE FROM mfa_totp WHERE user_id=$1 RETURNING 1) SELECT * FROM removed`
)

var (
	// ErrInvalidMFAReset is a reset input that is not a canonical id pair, an offline actor target, or an
	// approval or reason that is blank, too long or holds a control character.
	ErrInvalidMFAReset = errors.New("invalid second factor reset input")
	// ErrNotIAMAccount: the identity login resets IAM accounts only; nothing is deleted.
	ErrNotIAMAccount = errors.New("IAM second factors only: reset the Root with reset-root-mfa")
	// ErrNotRootAccount: the bootstrap login resets the Root only; nothing is deleted.
	ErrNotRootAccount = errors.New("second factors of the Root only: reset IAM accounts with reset-mfa")
)

// MFAReset is a validated reset request; only NewMFAReset makes a usable one.
type MFAReset struct{ userID, operationID, approval, reason string }

// NewMFAReset counts lengths in UTF-16 units and trims as String.prototype.trim does, as the TypeScript CLI
// did.
func NewMFAReset(c *core.Core, userID, operationID, approval, reason string) (MFAReset, error) {
	if !c.IsCanonicalUUID(userID) || !c.IsCanonicalUUID(operationID) || userID == audit.OfflineActor ||
		!printable(approval, maxApprovalUnits) || !printable(reason, maxReasonUnits) {
		return MFAReset{}, ErrInvalidMFAReset
	}
	return MFAReset{userID: userID, operationID: operationID, approval: approval, reason: reason}, nil
}

func printable(value string, limit int) bool {
	if !utf8.ValidString(value) || strings.TrimFunc(value, func(r rune) bool { return unicode.IsSpace(r) || r == 0xfeff }) == "" {
		return false
	}
	units := 0
	for _, r := range value {
		if unicode.Is(unicode.Cc, r) {
			return false
		}
		units += utf16.RuneLen(r)
	}
	return units <= limit
}

// ResetMFA removes the second factor and the recovery codes of one account with its audit. ModeRevoke
// (identity login) resets IAM accounts only: the identity login could write any row, so this check is the
// guard. ModeBootstrap resets the Root only, which the protect_mfa_* triggers also enforce. Without a
// factor nothing is audited, but the transaction still commits its revision.
func ResetMFA(ctx context.Context, runner *database.Runner, reset MFAReset, mode database.Mode) (bool, error) {
	kind, refusal := "iam", ErrNotIAMAccount
	switch {
	case reset.userID == "":
		return false, ErrInvalidMFAReset
	case mode == database.ModeBootstrap:
		kind, refusal = "root", ErrNotRootAccount
	case mode != database.ModeRevoke:
		return false, ErrInvalidMFAReset
	}
	return database.Run(ctx, runner, mode, func(_ context.Context, tx *database.Tx) (bool, error) {
		rows, err := tx.Query(lockTargetKind, reset.userID)
		if err != nil {
			return false, err
		}
		kinds, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return false, err
		}
		if len(kinds) != 1 || kinds[0] != kind {
			return false, refusal
		}
		if _, err := tx.Exec(deleteRecoveryCodes, reset.userID); err != nil {
			return false, err
		}
		rows, err = tx.Query(deleteSecondFactor, reset.userID)
		if err != nil {
			return false, err
		}
		removed, err := pgx.CollectRows(rows, pgx.RowTo[int32])
		if err != nil || len(removed) == 0 {
			return false, err
		}
		return true, audit.Append(tx, audit.Event{Kind: audit.KindIdentityMfaReset, Actor: audit.OfflineActor,
			Detail: audit.OfflineRevoke{TargetUserID: reset.userID, OperationID: reset.operationID, Approval: reset.approval, Reason: reset.reason}})
	}, database.RunOptions{})
}
