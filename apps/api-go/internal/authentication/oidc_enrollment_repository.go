package authentication

import (
	"bytes"
	"crypto/subtle"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
)

const (
	providerCurrentSQL = `SELECT version::text FROM oidc_provider WHERE issuer=$1 AND enabled`
	liveEnrollmentSQL  = `SELECT u.id AS user_id FROM oidc_email_enrollment n JOIN app_user u ON u.id=n.user_id
     WHERE n.issuer=$1 AND n.email_canonical=$2 AND n.expires_at>statement_timestamp()
       AND u.state='pending' AND u.kind='iam' AND u.email_canonical=$2
       AND NOT EXISTS(SELECT 1 FROM external_identity e WHERE e.user_id=u.id AND e.enabled)`
	boundSubject      = `SELECT 1 FROM external_identity WHERE issuer=$1 AND subject=$2`
	consumeEnrollment = `WITH consumed AS (DELETE FROM oidc_email_enrollment WHERE user_id=$1 AND issuer=$2 AND email_canonical=$3 RETURNING user_id) SELECT * FROM consumed`
	insertBinding     = `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`
	activateAccount   = `UPDATE app_user SET state='active',email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`
	rootInvitationSQL = `SELECT u.id AS user_id,n.email_canonical AS email,u.auth_epoch::text AS auth_epoch,t.token_hash
     FROM one_time_token t JOIN app_user u ON u.id=t.user_id
       JOIN oidc_email_enrollment n ON n.user_id=u.id AND n.issuer=$1
         AND n.email_canonical=u.email_canonical AND n.expires_at>statement_timestamp()
     WHERE `
	rootInvitationTail = ` AND t.purpose='oidc-activation'
       AND t.consumed_at IS NULL AND t.expires_at>statement_timestamp()
       AND u.state='pending' AND u.kind='root'
     FOR UPDATE OF u,t`
	invitationByToken = rootInvitationSQL + `t.token_hash=$2` + rootInvitationTail
	invitationByUser  = rootInvitationSQL + `t.user_id=$2` + rootInvitationTail
)

func providerCurrent(tx *database.Tx, provider *OidcProvider) error {
	rows, err := tx.Query(providerCurrentSQL, provider.settings.Issuer)
	if err != nil {
		return err
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(versions) != 1 || versions[0] != provider.settings.Version {
		return apperror.ErrAuthenticationFailed
	}
	return nil
}

// liveEnrollment is the unexpired email enrollment at issuer of a pending IAM account with that email and no
// enabled binding. lock takes the account row, so concurrent first logins serialize; a Root never matches.
func liveEnrollment(tx *database.Tx, issuer, email string, lock bool) (string, bool, error) {
	sql := liveEnrollmentSQL
	if lock {
		sql += ` FOR UPDATE OF u`
	}
	rows, err := tx.Query(sql, issuer, email)
	if err != nil {
		return "", false, err
	}
	users, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(users) != 1 {
		return "", false, err
	}
	return users[0], true, nil
}

// bindNew consumes the enrollment, binds (issuer, subject), activates the account with a verified email and a
// new epoch and ends what the old epoch issued, in the caller's exclusive transaction.
func bindNew(tx *database.Tx, userID, issuer, subject, email string) error {
	consumed, err := tx.Query(consumeEnrollment, userID, issuer, email)
	if err != nil {
		return err
	}
	users, err := pgx.CollectRows(consumed, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(users) != 1 {
		return apperror.ErrAuthenticationFailed
	}
	if _, err := tx.Exec(insertBinding, issuer, subject, userID); err != nil {
		var driver *pgconn.PgError
		if errors.As(err, &driver) && driver.Code == "23505" {
			return apperror.ErrAuthenticationFailed
		}
		return err
	}
	if _, err := tx.Exec(activateAccount, userID); err != nil {
		return err
	}
	if err := Invalidate(tx, userID); err != nil {
		return err
	}
	return audit.Append(tx, audit.Event{Kind: audit.KindOIDCActivation, Actor: userID})
}

// bindEnrollment is the first verified login of an email-enrolled account.
func bindEnrollment(tx *database.Tx, issuer, subject, email string) error {
	userID, ok, err := liveEnrollment(tx, issuer, email, true)
	if err != nil {
		return err
	}
	if !ok {
		return apperror.ErrAuthenticationFailed
	}
	rows, err := tx.Query(boundSubject, issuer, subject)
	if err != nil {
		return err
	}
	bound, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		return err
	}
	if len(bound) > 0 {
		return apperror.ErrAuthenticationFailed
	}
	return bindNew(tx, userID, issuer, subject, email)
}

// rootInvitations are the live Root activations by token digest or by user, locking account and token.
// Several live tokens of one Root are fine; none, or several users, is not.
func rootInvitations(tx *database.Tx, sql string, args ...any) ([]credential.RootInvitation, error) {
	rows, err := tx.Query(sql, args...)
	if err != nil {
		return nil, err
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (credential.RootInvitation, error) {
		var r credential.RootInvitation
		err := row.Scan(&r.UserID, &r.Email, &r.AuthEpoch, &r.TokenHash)
		return r, err
	})
	if err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return nil, apperror.ErrAuthenticationFailed
	}
	for _, r := range found {
		if r.UserID != found[0].UserID {
			return nil, apperror.ErrAuthenticationFailed
		}
	}
	return found, nil
}

func sameInvitation(a, b credential.RootInvitation) bool {
	return a.UserID == b.UserID && a.Email == b.Email && a.AuthEpoch == b.AuthEpoch && bytes.Equal(a.TokenHash, b.TokenHash)
}

// chooseInvitation is the invitation whose enrollment hash is the attempt's, hashed outside any transaction.
func chooseInvitation(invitations []credential.RootInvitation, issuer string, attemptHash []byte) (credential.RootInvitation, bool) {
	for _, invitation := range invitations {
		hash, err := credential.RootEnrollmentHash(invitation, issuer)
		if err == nil && len(hash) == len(attemptHash) && subtle.ConstantTimeCompare(hash, attemptHash) == 1 {
			return invitation, true
		}
	}
	return credential.RootInvitation{}, false
}

// activateRoot completes a Root activation in the caller's revoke transaction: the invitation chosen before
// must still be live and unchanged, and the ID token's verified email must be the enrollment's.
func activateRoot(tx *database.Tx, issuer, subject string, email *string, chosen credential.RootInvitation) error {
	if email == nil {
		return apperror.ErrAuthenticationFailed
	}
	invitations, err := rootInvitations(tx, invitationByUser, issuer, chosen.UserID)
	if err != nil {
		return err
	}
	for _, invitation := range invitations {
		if sameInvitation(invitation, chosen) && invitation.Email == *email {
			return bindNew(tx, chosen.UserID, issuer, subject, *email)
		}
	}
	return apperror.ErrAuthenticationFailed
}
