// Package authentication resolves sessions under the fence, ends them, counts sign-in attempts and reads
// the caller's own account. Only internal/app imports it.
package authentication

import (
	"context"
	"encoding/json/v2"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authentication/credential"
	"hrm/api/internal/database"
)

const (
	resolveSession = `SELECT s.user_id,s.kind,s.auth_epoch::text AS auth_epoch,s.method,s.assurance,` + credential.FreshAuthSQL + ` AS fresh FROM public.resolve_session($1) s`
	touchSession   = `UPDATE application_session SET last_seen_at=statement_timestamp() WHERE token_hash=$1`
	revokeAll      = `UPDATE application_session SET revoked_at=statement_timestamp() WHERE user_id=$1 AND revoked_at IS NULL`
	revokeOne      = `UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1`
	confirmedMFA   = `SELECT 1 FROM mfa_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL`
	ownAccount     = `SELECT u.email_canonical AS email,
         COALESCE((SELECT json_agg(json_build_object('issuer',i.issuer,'reference',i.binding_ref) ORDER BY i.issuer,i.binding_ref)
           FROM (SELECT e.issuer,e.binding_ref FROM external_identity e JOIN oidc_provider p ON p.issuer=e.issuer
             WHERE e.user_id=u.id AND e.enabled AND p.enabled ORDER BY e.issuer,e.binding_ref LIMIT 16) i),'[]') AS identities
       FROM app_user u WHERE u.id=$1`
	mfaStatus = `SELECT (SELECT confirmed_at IS NOT NULL FROM mfa_totp WHERE user_id=$1) confirmed,
           (SELECT count(*)::int FROM mfa_recovery_code WHERE user_id=$1 AND used_at IS NULL) remaining`
	insertSession = `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
      VALUES($1,$2,$3,'oidc',$4,$5,$6,$7,$9,COALESCE(to_timestamp($8::bigint),statement_timestamp()),NULL,statement_timestamp()+interval '12 hours')
      RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
        GREATEST(0,floor(extract(epoch FROM expires_at-statement_timestamp())))::int AS max_age`
	consumeTokens = `UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE user_id=$1 AND consumed_at IS NULL`
)

// Session is a new session: the cookie secret, its absolute expiry as UTC text and the seconds left, both
// by the clock of the statement that wrote it.
type Session struct {
	Secret    string
	ExpiresAt string
	MaxAge    int
}

// SessionCredential is the secret of a session still to be written, with its digest, so no hash runs in
// the transaction.
type SessionCredential struct {
	secret string
	digest []byte
}

func NewSessionCredential() (SessionCredential, error) {
	secret := credential.NewSessionSecret()
	digest, err := credential.SessionDigest(secret)
	return SessionCredential{secret: secret, digest: digest}, err
}

// SessionInput is a verified binding; AuthTime is the validated IdP auth_time in seconds, nil when the
// token has none.
type SessionInput struct {
	UserID, AuthEpoch, Assurance, Issuer, Subject, BindingVersion, ProviderVersion string
	AuthTime                                                                       *int64
}

// MfaStatus counts recovery codes of an enabled factor only.
type MfaStatus struct {
	Status                 string
	RecoveryCodesRemaining int
}

// Service holds the transaction runner; it keeps no state between requests.
type Service struct{ runner *database.Runner }

func NewService(runner *database.Runner) *Service { return &Service{runner: runner} }

// SessionIdentity is what resolve_session verified. Kind is the stored account kind, so a Root is known
// only from a live session, never from a request.
type SessionIdentity struct {
	UserID    string
	Kind      string
	AuthEpoch string
	Method    string
	Assurance string
	// Fresh is FreshAuthSQL of the session by the clock of the resolving statement.
	Fresh bool
}

// Identity is an enabled binding at an enabled provider, named by reference, never by subject.
type Identity struct {
	Issuer    string `json:"issuer"`
	Reference string `json:"reference"`
}

// OwnAccount is the caller's own email (nil when none is stored), at most 16 bindings and the second
// factor.
type OwnAccount struct {
	Email      *string
	Identities []Identity
	Mfa        MfaStatus
}

// Authenticate resolves the session of digest in tx. In identity and revoke mode it records the activity;
// that never extends the absolute expiry.
func Authenticate(tx *database.Tx, digest []byte) (SessionIdentity, error) {
	rows, err := tx.Query(resolveSession, digest)
	if err != nil {
		return SessionIdentity{}, err
	}
	identity, err := pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (SessionIdentity, error) {
		var s SessionIdentity
		err := row.Scan(&s.UserID, &s.Kind, &s.AuthEpoch, &s.Method, &s.Assurance, &s.Fresh)
		return s, err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionIdentity{}, apperror.ErrAuthenticationFailed
	}
	if err != nil {
		return SessionIdentity{}, err
	}
	if tx.Mode == database.ModeIdentity || tx.Mode == database.ModeRevoke {
		if _, err := tx.Exec(touchSession, digest); err != nil {
			return SessionIdentity{}, err
		}
	}
	return identity, nil
}

// HasConfirmedSecondFactor is the only source of a step-up; any other source must refuse an account for
// which this holds.
func HasConfirmedSecondFactor(tx *database.Tx, userID string) (bool, error) {
	rows, err := tx.Query(confirmedMFA, userID)
	if err != nil {
		return false, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	return len(found) > 0, err
}

// Logout answers a dead session under the shared fence, so only a live one queues for the exclusive
// fence, where it is resolved again before it ends.
func (s *Service) Logout(ctx context.Context, secret string, all bool) error {
	digest, err := credential.SessionDigest(secret)
	if err != nil {
		return err
	}
	if _, err := database.Run(ctx, s.runner, database.ModeRead, func(_ context.Context, tx *database.Tx) (SessionIdentity, error) {
		return Authenticate(tx, digest)
	}, database.RunOptions{}); err != nil {
		return err
	}
	_, err = database.Run(ctx, s.runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		identity, err := Authenticate(tx, digest)
		if err != nil {
			return struct{}{}, err
		}
		kind := audit.KindLogout
		if all {
			kind = audit.KindLogoutAll
			_, err = tx.Exec(revokeAll, identity.UserID)
		} else {
			_, err = tx.Exec(revokeOne, digest)
		}
		if err != nil {
			return struct{}{}, err
		}
		return struct{}{}, audit.Append(tx, audit.Event{Kind: kind, Actor: identity.UserID})
	}, database.RunOptions{})
	return err
}

func (s *Service) CurrentSession(ctx context.Context, secret string) (SessionIdentity, error) {
	digest, err := credential.SessionDigest(secret)
	if err != nil {
		return SessionIdentity{}, err
	}
	return database.Run(ctx, s.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (SessionIdentity, error) {
		return Authenticate(tx, digest)
	}, database.RunOptions{})
}

// OwnAccount reads the account of the session only.
func (s *Service) OwnAccount(ctx context.Context, secret string) (OwnAccount, error) {
	digest, err := credential.SessionDigest(secret)
	if err != nil {
		return OwnAccount{}, err
	}
	return database.Run(ctx, s.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (OwnAccount, error) {
		identity, err := Authenticate(tx, digest)
		if err != nil {
			return OwnAccount{}, err
		}
		rows, err := tx.Query(ownAccount, identity.UserID)
		if err != nil {
			return OwnAccount{}, err
		}
		account, err := pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (OwnAccount, error) {
			var a OwnAccount
			var identities string
			if err := row.Scan(&a.Email, &identities); err != nil {
				return a, err
			}
			return a, json.Unmarshal([]byte(identities), &a.Identities)
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return OwnAccount{}, apperror.ErrAuthenticationFailed
		}
		if err != nil {
			return OwnAccount{}, err
		}
		account.Mfa, err = readMfaStatus(tx, identity.UserID)
		return account, err
	}, database.RunOptions{})
}

func readMfaStatus(tx *database.Tx, userID string) (MfaStatus, error) {
	rows, err := tx.Query(mfaStatus, userID)
	if err != nil {
		return MfaStatus{}, err
	}
	return pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (MfaStatus, error) {
		var confirmed *bool
		var remaining int32
		if err := row.Scan(&confirmed, &remaining); err != nil {
			return MfaStatus{}, err
		}
		switch {
		case confirmed == nil:
			return MfaStatus{Status: "none"}, nil
		case *confirmed:
			return MfaStatus{Status: "enabled", RecoveryCodesRemaining: int(remaining)}, nil
		default:
			return MfaStatus{Status: "pending"}, nil
		}
	})
}

// CreateSession writes the session of next; the expiry text and lifetime come from the inserting
// statement's clock, never the API's.
func CreateSession(tx *database.Tx, input SessionInput, next SessionCredential) (Session, error) {
	rows, err := tx.Query(insertSession, next.digest, input.UserID, input.AuthEpoch, input.Assurance, input.Issuer,
		input.Subject, input.BindingVersion, input.AuthTime, input.ProviderVersion)
	if err != nil {
		return Session{}, err
	}
	return collectSession(rows, next)
}

func collectSession(rows pgx.Rows, next SessionCredential) (Session, error) {
	session, err := pgx.CollectExactlyOneRow(rows, func(row pgx.CollectableRow) (Session, error) {
		var maxAge int32
		session := Session{Secret: next.secret}
		err := row.Scan(&session.ExpiresAt, &maxAge)
		session.MaxAge = int(maxAge)
		return session, err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	return session, err
}

// Invalidate consumes the account's one-time tokens and revokes its sessions, after an epoch change.
func Invalidate(tx *database.Tx, userID string) error {
	if _, err := tx.Exec(consumeTokens, userID); err != nil {
		return err
	}
	_, err := tx.Exec(revokeAll, userID)
	return err
}
