package authentication

import (
	"bytes"
	"errors"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
)

const (
	recoveryCodeCount = 10
	setupMinutes      = 15
	lockoutAttempts   = 10

	lockAccount = `SELECT email_canonical email FROM app_user WHERE id=$1 FOR NO KEY UPDATE`
	readFactor  = `SELECT secret_ciphertext,nonce,key_id,secret_version::text,confirmed_at IS NOT NULL confirmed,last_used_step::text,
         created_at>statement_timestamp()-make_interval(mins=>$2) live,
         floor(extract(epoch FROM statement_timestamp())/30)::bigint::text step
       FROM mfa_totp WHERE user_id=$1`
	lockedFactor   = readFactor + ` FOR UPDATE`
	setupConfirmed = `SELECT confirmed_at IS NOT NULL confirmed FROM mfa_totp WHERE user_id=$1`
	replaceSetup   = `UPDATE mfa_totp SET secret_ciphertext=$2,nonce=$3,key_id=$4,secret_version=secret_version+1,created_at=statement_timestamp(),failed_attempts=0 WHERE user_id=$1`
	insertSetup    = `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,$2,$3,$4)`
	confirmFactor  = `WITH changed AS (UPDATE mfa_totp SET confirmed_at=statement_timestamp(),last_used_step=$2,failed_attempts=0,
             secret_ciphertext=$4,nonce=$5,key_id=$6
           WHERE user_id=$1 AND confirmed_at IS NULL AND secret_version=$3 RETURNING 1) SELECT * FROM changed`
	acceptCode = `WITH changed AS (UPDATE mfa_totp SET last_used_step=$2,failed_attempts=0,secret_ciphertext=$3,nonce=$4,key_id=$5
               WHERE user_id=$1 AND confirmed_at IS NOT NULL AND (last_used_step IS NULL OR last_used_step<$2) RETURNING 1) SELECT * FROM changed`
	useRecoveryCode = `WITH used AS (UPDATE mfa_recovery_code SET used_at=statement_timestamp()
               WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING 1) SELECT * FROM used`
	resetFailures = `UPDATE mfa_totp SET failed_attempts=0 WHERE user_id=$1`
	countFailure  = `WITH counted AS (UPDATE mfa_totp SET failed_attempts=LEAST(failed_attempts+1,1000) WHERE user_id=$1 RETURNING failed_attempts) SELECT failed_attempts failed FROM counted`
	deleteCodes   = `DELETE FROM mfa_recovery_code WHERE user_id=$1`
	insertCodes   = `INSERT INTO mfa_recovery_code(user_id,code_hash) SELECT $1,unnest($2::bytea[])`
	removeFactor  = `WITH removed AS (DELETE FROM mfa_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL RETURNING 1) SELECT * FROM removed`
	liveSession   = `SELECT user_id FROM application_session WHERE token_hash=$1 AND revoked_at IS NULL`
	copySession   = `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
       SELECT $2,s.user_id,u.auth_epoch,s.method,s.assurance,s.external_issuer,s.external_subject,s.binding_version,s.provider_version,s.authenticated_at,
         CASE WHEN $3 THEN statement_timestamp() END,s.expires_at
       FROM application_session s JOIN app_user u ON u.id=s.user_id WHERE s.token_hash=$1
       RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
         GREATEST(0,floor(extract(epoch FROM expires_at-statement_timestamp())))::int AS max_age`
	storedKeyIDs = `SELECT DISTINCT key_id FROM mfa_totp`
)

// factorRow is the second factor of one account; Step is the current TOTP step by the statement's clock.
type factorRow struct {
	Sealed        credential.SealedTOTPSecret
	SecretVersion string
	Confirmed     bool
	LastUsedStep  *string
	Live          bool
	Step          string
}

func (f factorRow) sameSecret(other factorRow) bool {
	return bytes.Equal(f.Sealed.Ciphertext, other.Sealed.Ciphertext) && bytes.Equal(f.Sealed.Nonce, other.Sealed.Nonce) &&
		f.Sealed.KeyID == other.Sealed.KeyID && f.SecretVersion == other.SecretVersion
}

// lockAccountRow serializes every second factor change of the account; it returns the stored email.
func lockAccountRow(tx *database.Tx, userID string) (*string, error) {
	rows, err := tx.Query(lockAccount, userID)
	if err != nil {
		return nil, err
	}
	email, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[*string])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.ErrAuthenticationFailed
	}
	return email, err
}

// lockFactor runs after lockAccountRow, the one lock order of a second factor change.
func lockFactor(tx *database.Tx, userID string) (*factorRow, error) {
	return factorOf(tx, lockedFactor, userID)
}

// snapshotFactor takes no lock: nothing locks the account row before it.
func snapshotFactor(tx *database.Tx, userID string) (*factorRow, error) {
	return factorOf(tx, readFactor, userID)
}

func factorOf(tx *database.Tx, sql, userID string) (*factorRow, error) {
	rows, err := tx.Query(sql, userID, setupMinutes)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (factorRow, error) {
		var f factorRow
		err := row.Scan(&f.Sealed.Ciphertext, &f.Sealed.Nonce, &f.Sealed.KeyID, &f.SecretVersion, &f.Confirmed,
			&f.LastUsedStep, &f.Live, &f.Step)
		return f, err
	})
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return &found[0], nil
}

// changedOne runs a statement that returns one row per changed row and tells whether exactly one changed.
func changedOne(tx *database.Tx, sql string, args ...any) (bool, error) {
	rows, err := tx.Query(sql, args...)
	if err != nil {
		return false, err
	}
	changed, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	return len(changed) == 1, err
}

func countFailedProof(tx *database.Tx, userID string) (int32, error) {
	rows, err := tx.Query(countFailure, userID)
	if err != nil {
		return 0, err
	}
	counted, err := pgx.CollectRows(rows, pgx.RowTo[int16])
	if err != nil || len(counted) == 0 {
		return 0, err
	}
	return int32(counted[0]), nil
}

func replaceRecoveryCodes(tx *database.Tx, userID string, hashes [][]byte) error {
	if _, err := tx.Exec(deleteCodes, userID); err != nil {
		return err
	}
	_, err := tx.Exec(insertCodes, userID, hashes)
	return err
}

// continueSession copies the caller's session into a new row: same method, binding and provider versions,
// assurance, authentication time and absolute deadline, with the account's current epoch and, when fresh,
// a new reauthenticated_at. everyone revokes every session of the account (after an epoch change), else
// only the current one.
func continueSession(tx *database.Tx, digest []byte, next SessionCredential, fresh, everyone bool) (Session, error) {
	rows, err := tx.Query(liveSession, digest)
	if err != nil {
		return Session{}, err
	}
	current, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	if err != nil {
		return Session{}, err
	}
	if everyone {
		err = Invalidate(tx, current)
	} else {
		_, err = tx.Exec(revokeOne, digest)
	}
	if err != nil {
		return Session{}, err
	}
	rows, err = tx.Query(copySession, digest, next.digest, fresh)
	if err != nil {
		return Session{}, err
	}
	return collectSession(rows, next)
}
