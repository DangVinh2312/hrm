package authentication

import (
	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/database"
)

const (
	bindingOf      = `SELECT e.user_id,e.binding_version::text,e.enabled,u.state,u.auth_epoch::text FROM external_identity e JOIN app_user u ON u.id=e.user_id WHERE e.issuer=$1 AND e.subject=$2`
	verifyOwnEmail = `WITH changed AS (UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch+1
           WHERE id=$1 AND email_canonical=$2 AND NOT email_verified RETURNING auth_epoch::text)
         SELECT * FROM changed`
	boundAccount = `SELECT u.email_canonical=$3 AND NOT u.email_verified AS verifies
           FROM external_identity e JOIN app_user u ON u.id=e.user_id WHERE e.issuer=$1 AND e.subject=$2`
)

type binding struct {
	userID, bindingVersion, state, authEpoch string
	enabled                                  bool
}

// oidcLogin is a verified ID token at one provider. VerifiesEmail is set in a revoke transaction only: there
// the token's verified email may verify the account's own.
type oidcLogin struct {
	provider      *OidcProvider
	claims        VerifiedClaims
	verifiesEmail *string
}

// issueOidcSession is the session of the enabled (issuer, sub) binding of an active account. It is never
// fresh: an IdP login is not a step-up.
func issueOidcSession(tx *database.Tx, login oidcLogin, next SessionCredential) (Session, error) {
	issuer := login.provider.settings.Issuer
	rows, err := tx.Query(bindingOf, issuer, login.claims.Subject)
	if err != nil {
		return Session{}, err
	}
	bindings, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (binding, error) {
		var b binding
		err := row.Scan(&b.userID, &b.bindingVersion, &b.enabled, &b.state, &b.authEpoch)
		return b, err
	})
	if err != nil {
		return Session{}, err
	}
	if len(bindings) == 0 || !bindings[0].enabled || bindings[0].state != "active" {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	bound := bindings[0]
	if login.verifiesEmail != nil {
		if bound.authEpoch, err = verifyEmail(tx, bound, *login.verifiesEmail); err != nil {
			return Session{}, err
		}
	}
	session, err := CreateSession(tx, SessionInput{
		UserID: bound.userID, AuthEpoch: bound.authEpoch, Assurance: login.claims.Assurance, Issuer: issuer,
		Subject: login.claims.Subject, BindingVersion: bound.bindingVersion,
		ProviderVersion: login.provider.settings.Version, AuthTime: login.claims.AuthTime,
	}, next)
	if err != nil {
		return Session{}, err
	}
	return session, audit.Append(tx, audit.Event{Kind: audit.KindOIDCLogin, Actor: bound.userID})
}

// verifyEmail marks the account's own email verified once; the new epoch ends the sessions issued while it
// was not.
func verifyEmail(tx *database.Tx, bound binding, email string) (string, error) {
	rows, err := tx.Query(verifyOwnEmail, bound.userID, email)
	if err != nil {
		return "", err
	}
	epochs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(epochs) == 0 {
		return bound.authEpoch, err
	}
	if err := Invalidate(tx, bound.userID); err != nil {
		return "", err
	}
	return epochs[0], audit.Append(tx, audit.Event{Kind: audit.KindEmailVerify, Actor: bound.userID})
}

// boundVerifies tells whether (issuer, sub) is bound and, if so, whether the token proves the account's
// unverified email.
func boundVerifies(tx *database.Tx, issuer, subject string, email *string) (bound, verifies bool, err error) {
	rows, err := tx.Query(boundAccount, issuer, subject, email)
	if err != nil {
		return false, false, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[*bool])
	if err != nil || len(found) == 0 {
		return false, false, err
	}
	return true, found[0] != nil && *found[0], nil
}
