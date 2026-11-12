package authentication

import (
	"context"
	"crypto/rand"
	"errors"
	"slices"
	"strconv"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/config"
	"hrm/api/internal/database"
)

// ErrKeyCoverage is a stored second factor whose key id the configured ring lacks; boot fails closed.
var ErrKeyCoverage = errors.New("MFA key ring does not cover the stored second factors")

// MfaService is the TOTP second factor and recovery codes of the session's own account. Every change runs
// in one transaction that first locks the account row. Decryption, hashing and sealing run before that
// transaction on a snapshot of the factor; the transaction checks that the locked row is that snapshot.
type MfaService struct {
	service *Service
	keys    config.MfaKeyRing
}

func NewMfaService(service *Service, keys config.MfaKeyRing) *MfaService {
	return &MfaService{service: service, keys: keys}
}

// MfaSetup is shown once: the authenticator URI and the same secret as base32 for manual entry.
type MfaSetup struct{ URI, Secret string }

// MfaConfirmation is the continued session and the ten recovery codes, shown once.
type MfaConfirmation struct {
	Session       Session
	RecoveryCodes []string
}

// MfaProof is a TOTP code, or a recovery code when Recovery is set; the HTTP layer checked the shape.
type MfaProof struct {
	Code     string
	Recovery bool
}

// mfaCaller is what runs before the fenced transaction: the session digest, the account, its factor as
// read then, and the new session.
type mfaCaller struct {
	digest []byte
	userID string
	factor *factorRow
	next   SessionCredential
}

// codeMatch is a TOTP code checked against the snapshot for the step of the snapshot and the next one, so
// the transaction only compares. open is the failure to decrypt, raised where the code is checked.
type codeMatch struct {
	at       uint64
	steps    [2]uint64
	ok       [2]bool
	resealed credential.SealedTOTPSecret
	open     error
}

// VerifyKeyCoverage is the boot check: every stored key id must be in the ring.
func (m *MfaService) VerifyKeyCoverage(ctx context.Context) error {
	ids, err := database.Run(ctx, m.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) ([]string, error) {
		rows, err := tx.Query(storedKeyIDs)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowTo[string])
	}, database.RunOptions{})
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !slices.Contains(m.keys.IDs(), id) {
			return ErrKeyCoverage
		}
	}
	return nil
}

// prepare authenticates, reads the factor and counts the attempt (purpose mfa) before any fenced work.
func (m *MfaService) prepare(ctx context.Context, secret, clientKey string) (mfaCaller, error) {
	digest, err := credential.SessionDigest(secret)
	if err != nil {
		return mfaCaller{}, err
	}
	caller, err := database.Run(ctx, m.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (mfaCaller, error) {
		identity, err := Authenticate(tx, digest)
		if err != nil {
			return mfaCaller{}, err
		}
		factor, err := snapshotFactor(tx, identity.UserID)
		return mfaCaller{digest: digest, userID: identity.UserID, factor: factor}, err
	}, database.RunOptions{})
	if err != nil {
		return mfaCaller{}, err
	}
	if err := m.service.RateLimit(ctx, clientKey, caller.userID, "mfa"); err != nil {
		return mfaCaller{}, err
	}
	caller.next, err = NewSessionCredential()
	return caller, err
}

// authenticateAgain resolves the session in the fenced transaction and locks the account, which must be the
// one prepared for.
func authenticateAgain(tx *database.Tx, caller mfaCaller) (SessionIdentity, *string, error) {
	identity, err := Authenticate(tx, caller.digest)
	if err != nil {
		return SessionIdentity{}, nil, err
	}
	if identity.UserID != caller.userID {
		return SessionIdentity{}, nil, apperror.ErrAuthenticationFailed
	}
	email, err := lockAccountRow(tx, identity.UserID)
	return identity, email, err
}

func (m *MfaService) matchCode(caller mfaCaller, code string) codeMatch {
	if caller.factor == nil {
		return codeMatch{}
	}
	step, err := strconv.ParseUint(caller.factor.Step, 10, 64)
	if err != nil {
		return codeMatch{open: err}
	}
	raw, err := credential.DecryptTOTPSecret(m.keys, caller.userID, caller.factor.Sealed)
	if err != nil {
		return codeMatch{open: err}
	}
	defer clear(raw)
	match := codeMatch{at: step, resealed: caller.factor.Sealed}
	for i := range match.steps {
		match.steps[i], match.ok[i] = credential.MatchTOTP(raw, code, step+uint64(i))
	}
	if caller.factor.Sealed.KeyID != m.keys.Current() {
		match.resealed, match.open = credential.EncryptTOTPSecret(m.keys, caller.userID, raw)
	}
	return match
}

// matched is the step the code matched at the locked row's step. A row other than the snapshot is a
// conflict, and a step the snapshot did not cover is unavailable; neither counts as a wrong code.
func (c codeMatch) matched(snapshot *factorRow, row factorRow) (uint64, bool, error) {
	if snapshot == nil || !row.sameSecret(*snapshot) {
		return 0, false, apperror.ErrMfaConflict
	}
	if c.open != nil {
		return 0, false, c.open
	}
	step, err := strconv.ParseUint(row.Step, 10, 64)
	if err != nil {
		return 0, false, err
	}
	switch step {
	case c.at:
		return c.steps[0], c.ok[0], nil
	case c.at + 1:
		return c.steps[1], c.ok[1], nil
	}
	return 0, false, apperror.ErrUnavailable
}

func newRecoveryCodes(userID string) ([]string, [][]byte) {
	codes := make([]string, recoveryCodeCount)
	hashes := make([][]byte, recoveryCodeCount)
	for i := range codes {
		code := credential.NewRecoveryCode()
		hashes[i] = credential.RecoveryCodeHash(userID, code)
		codes[i] = credential.FormatRecoveryCode(code)
	}
	return codes, hashes
}

// Setup writes a new unconfirmed secret, replacing an earlier setup; a confirmed factor is a conflict.
func (m *MfaService) Setup(ctx context.Context, secret, clientKey string) (MfaSetup, error) {
	caller, err := m.prepare(ctx, secret, clientKey)
	if err != nil {
		return MfaSetup{}, err
	}
	raw := make([]byte, credential.TOTPSecretBytes)
	_, _ = rand.Read(raw)
	defer clear(raw)
	sealed, err := credential.EncryptTOTPSecret(m.keys, caller.userID, raw)
	if err != nil {
		return MfaSetup{}, err
	}
	email, err := database.Run(ctx, m.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (*string, error) {
		_, email, err := authenticateAgain(tx, caller)
		if err != nil {
			return nil, err
		}
		rows, err := tx.Query(setupConfirmed, caller.userID)
		if err != nil {
			return nil, err
		}
		existing, err := pgx.CollectRows(rows, pgx.RowTo[bool])
		switch {
		case err != nil:
			return nil, err
		case len(existing) == 1 && existing[0]:
			return nil, apperror.ErrMfaConflict
		case len(existing) == 1:
			_, err = tx.Exec(replaceSetup, caller.userID, sealed.Ciphertext, sealed.Nonce, sealed.KeyID)
		default:
			_, err = tx.Exec(insertSetup, caller.userID, sealed.Ciphertext, sealed.Nonce, sealed.KeyID)
		}
		if err != nil {
			return nil, err
		}
		return email, audit.Append(tx, audit.Event{Kind: audit.KindMFASetup, Actor: caller.userID})
	}, database.RunOptions{})
	if err != nil {
		return MfaSetup{}, err
	}
	return MfaSetup{URI: credential.TOTPURI(raw, email), Secret: credential.Base32Encode(raw)}, nil
}
