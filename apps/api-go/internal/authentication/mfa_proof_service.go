package authentication

import (
	"context"
	"strconv"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
)

type verifyOutcome struct {
	session  Session
	accepted bool
}

// Confirm activates the setup with a code: the trigger ends every session, ten recovery codes are shown
// once and the caller's session continues as a fresh copy. A wrong code here is not counted, since the
// setup's secret came from this session.
func (m *MfaService) Confirm(ctx context.Context, secret, code, clientKey string) (MfaConfirmation, error) {
	caller, err := m.prepare(ctx, secret, clientKey)
	if err != nil {
		return MfaConfirmation{}, err
	}
	return m.confirmMatch(ctx, caller, m.matchCode(caller, code))
}

// confirmMatch is the fenced part of Confirm; match may be stale by now, which the locked row tells.
func (m *MfaService) confirmMatch(ctx context.Context, caller mfaCaller, match codeMatch) (MfaConfirmation, error) {
	codes, hashes := newRecoveryCodes(caller.userID)
	session, err := database.Run(ctx, m.service.runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (Session, error) {
		if _, _, err := authenticateAgain(tx, caller); err != nil {
			return Session{}, err
		}
		row, err := lockFactor(tx, caller.userID)
		if err != nil {
			return Session{}, err
		}
		if row == nil || row.Confirmed || !row.Live {
			return Session{}, apperror.ErrMfaConflict
		}
		step, ok, err := match.matched(caller.factor, *row)
		if err != nil {
			return Session{}, err
		}
		if !ok {
			return Session{}, apperror.ErrAuthenticationFailed
		}
		changed, err := changedOne(tx, confirmFactor, caller.userID, strconv.FormatUint(step, 10), row.SecretVersion,
			match.resealed.Ciphertext, match.resealed.Nonce, match.resealed.KeyID)
		if err != nil {
			return Session{}, err
		}
		if !changed {
			return Session{}, apperror.ErrMfaConflict
		}
		if err := replaceRecoveryCodes(tx, caller.userID, hashes); err != nil {
			return Session{}, err
		}
		session, err := continueSession(tx, caller.digest, caller.next, true, true)
		if err != nil {
			return Session{}, err
		}
		return session, audit.Append(tx, audit.Event{Kind: audit.KindMFAEnroll, Actor: caller.userID})
	}, database.RunOptions{})
	if err != nil {
		return MfaConfirmation{}, err
	}
	return MfaConfirmation{Session: session, RecoveryCodes: codes}, nil
}

// Verify is a step-up by TOTP or one recovery code; the session continues as a fresh copy. A wrong proof is
// counted and audited in one commit, and from the tenth in a row on the trigger ends the sessions, before
// the generic authentication failure.
func (m *MfaService) Verify(ctx context.Context, secret string, proof MfaProof, clientKey string) (Session, error) {
	caller, err := m.prepare(ctx, secret, clientKey)
	if err != nil {
		return Session{}, err
	}
	var match codeMatch
	var recoveryHash []byte
	if !proof.Recovery {
		match = m.matchCode(caller, proof.Code)
	} else if normalized, ok := credential.NormalizeRecoveryCode(proof.Code); ok {
		recoveryHash = credential.RecoveryCodeHash(caller.userID, normalized)
	}
	return m.verifyMatch(ctx, caller, proof, match, recoveryHash)
}

// verifyMatch is the fenced part of Verify; match may be stale by now, which the locked row tells.
func (m *MfaService) verifyMatch(ctx context.Context, caller mfaCaller, proof MfaProof, match codeMatch, recoveryHash []byte) (Session, error) {
	outcome, err := database.Run(ctx, m.service.runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (verifyOutcome, error) {
		if _, _, err := authenticateAgain(tx, caller); err != nil {
			return verifyOutcome{}, err
		}
		row, err := lockFactor(tx, caller.userID)
		if err != nil {
			return verifyOutcome{}, err
		}
		if row == nil || !row.Confirmed {
			return verifyOutcome{}, apperror.ErrMfaConflict
		}
		accepted, err := m.accept(tx, caller, proof, match, recoveryHash, *row)
		if err != nil {
			return verifyOutcome{}, err
		}
		if !accepted {
			return verifyOutcome{}, countWrongProof(tx, caller.userID)
		}
		session, err := continueSession(tx, caller.digest, caller.next, true, false)
		if err != nil {
			return verifyOutcome{}, err
		}
		kind := audit.KindMFAVerify
		if proof.Recovery {
			kind = audit.KindMFARecovery
		}
		return verifyOutcome{session: session, accepted: true}, audit.Append(tx, audit.Event{Kind: kind, Actor: caller.userID})
	}, database.RunOptions{})
	if err != nil {
		return Session{}, err
	}
	if !outcome.accepted {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	return outcome.session, nil
}

// accept uses the proof: a code only at a step after the last used one, a recovery code once. Every update
// of a confirmed factor other than a failure resets the counter.
func (m *MfaService) accept(tx *database.Tx, caller mfaCaller, proof MfaProof, match codeMatch, recoveryHash []byte, row factorRow) (bool, error) {
	if proof.Recovery {
		if recoveryHash == nil {
			return false, nil
		}
		used, err := changedOne(tx, useRecoveryCode, caller.userID, recoveryHash)
		if err != nil || !used {
			return false, err
		}
		_, err = tx.Exec(resetFailures, caller.userID)
		return err == nil, err
	}
	step, ok, err := match.matched(caller.factor, row)
	if err != nil || !ok {
		return false, err
	}
	if row.LastUsedStep != nil {
		last, err := strconv.ParseUint(*row.LastUsedStep, 10, 64)
		if err != nil || step <= last {
			return false, err
		}
	}
	return changedOne(tx, acceptCode, caller.userID, strconv.FormatUint(step, 10),
		match.resealed.Ciphertext, match.resealed.Nonce, match.resealed.KeyID)
}

// countWrongProof commits the counter and its event; no proof is recorded. The trigger advanced the epoch at
// the lockout, and the rows are revoked too, as on other epoch changes.
func countWrongProof(tx *database.Tx, userID string) error {
	failed, err := countFailedProof(tx, userID)
	if err != nil {
		return err
	}
	if err := audit.Append(tx, audit.Event{Kind: audit.KindMFAVerifyFailed, Actor: userID}); err != nil {
		return err
	}
	if failed < lockoutAttempts {
		return nil
	}
	if err := Invalidate(tx, userID); err != nil {
		return err
	}
	return audit.Append(tx, audit.Event{Kind: audit.KindMFALockout, Actor: userID})
}

// RegenerateRecoveryCodes replaces the set with ten new codes; it needs a step-up.
func (m *MfaService) RegenerateRecoveryCodes(ctx context.Context, secret, clientKey string) ([]string, error) {
	caller, err := m.prepare(ctx, secret, clientKey)
	if err != nil {
		return nil, err
	}
	codes, hashes := newRecoveryCodes(caller.userID)
	_, err = database.Run(ctx, m.service.runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		if err := freshCaller(tx, caller); err != nil {
			return struct{}{}, err
		}
		confirmed, err := HasConfirmedSecondFactor(tx, caller.userID)
		if err != nil {
			return struct{}{}, err
		}
		if !confirmed {
			return struct{}{}, apperror.ErrMfaConflict
		}
		if err := replaceRecoveryCodes(tx, caller.userID, hashes); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, audit.Append(tx, audit.Event{Kind: audit.KindMFARecoveryRegenerate, Actor: caller.userID})
	}, database.RunOptions{})
	if err != nil {
		return nil, err
	}
	return codes, nil
}

// Remove deletes the factor and the codes (the trigger ends every session); it needs a step-up and the
// caller continues, not fresh.
func (m *MfaService) Remove(ctx context.Context, secret, clientKey string) (Session, error) {
	caller, err := m.prepare(ctx, secret, clientKey)
	if err != nil {
		return Session{}, err
	}
	return database.Run(ctx, m.service.runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (Session, error) {
		if err := freshCaller(tx, caller); err != nil {
			return Session{}, err
		}
		if _, err := tx.Exec(deleteCodes, caller.userID); err != nil {
			return Session{}, err
		}
		removed, err := changedOne(tx, removeFactor, caller.userID)
		if err != nil {
			return Session{}, err
		}
		if !removed {
			return Session{}, apperror.ErrMfaConflict
		}
		session, err := continueSession(tx, caller.digest, caller.next, false, true)
		if err != nil {
			return Session{}, err
		}
		return session, audit.Append(tx, audit.Event{Kind: audit.KindMFARemove, Actor: caller.userID})
	}, database.RunOptions{})
}

// freshCaller is the step-up check of the session as resolved, before the account lock.
func freshCaller(tx *database.Tx, caller mfaCaller) error {
	identity, err := Authenticate(tx, caller.digest)
	if err != nil {
		return err
	}
	if identity.UserID != caller.userID {
		return apperror.ErrAuthenticationFailed
	}
	if !identity.Fresh {
		return apperror.ErrStepUpRequired
	}
	_, err = lockAccountRow(tx, caller.userID)
	return err
}
