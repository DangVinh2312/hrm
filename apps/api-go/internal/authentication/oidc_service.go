package authentication

import (
	"context"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
)

const (
	purposeLogin      = "login"
	purposeActivation = "activation"

	deleteExpiredAttempts = `DELETE FROM oidc_login_attempt WHERE expires_at<=statement_timestamp()`
	insertAttempt         = `INSERT INTO oidc_login_attempt(state_hash,nonce,verifier,provider_issuer,provider_version,redirect_uri,expires_at,browser_hash,purpose,linking_user_id,enrollment_hash) VALUES($1,$2,$3,$4,$5,$6,statement_timestamp()+interval '5 minutes',$7,$8,$9,$10)`
	attemptIssuer         = `SELECT provider_issuer FROM oidc_login_attempt WHERE state_hash=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at>statement_timestamp()`
	consumeAttempt        = `WITH changed AS (UPDATE oidc_login_attempt SET consumed_at=statement_timestamp() WHERE state_hash=$1 AND browser_hash=$2 AND provider_issuer=$3 AND provider_version=$4 AND expires_at>statement_timestamp() AND consumed_at IS NULL RETURNING nonce,verifier,provider_issuer,provider_version::text,redirect_uri,linking_user_id,enrollment_hash,purpose) SELECT * FROM changed`
)

// OidcService runs the sign-in and the Root activation at the configured providers. Network calls
// (discovery, token endpoint, keys) run outside every transaction.
type OidcService struct {
	service   *Service
	providers map[string]*OidcProvider
}

func NewOidcService(service *Service, providers []*OidcProvider) (*OidcService, error) {
	byIssuer := make(map[string]*OidcProvider, len(providers))
	for _, provider := range providers {
		if _, taken := byIssuer[provider.settings.Issuer]; taken {
			return nil, ErrOidcConfiguration
		}
		byIssuer[provider.settings.Issuer] = provider
	}
	return &OidcService{service: service, providers: byIssuer}, nil
}

type attempt struct {
	nonce, verifier, issuer, version, redirectURI, purpose string
	linkingUserID                                          *string
	enrollmentHash                                         []byte
}

func (s *OidcService) provider(issuer string) (*OidcProvider, error) {
	provider, ok := s.providers[issuer]
	if !ok {
		return nil, apperror.ErrAuthenticationFailed
	}
	return provider, nil
}

// Begin starts a sign-in bound to the browser secret for five minutes; it answers the authorization URL.
func (s *OidcService) Begin(ctx context.Context, issuer, browserSecret, clientKey string) (string, error) {
	return s.begin(ctx, issuer, browserSecret, nil, clientKey)
}

// Activate starts a Root activation with the offline one-time token; the attempt is bound to that exact
// token, so a reissue voids it.
func (s *OidcService) Activate(ctx context.Context, issuer, browserSecret, token, clientKey string) (string, error) {
	if token == "" {
		return "", apperror.ErrAuthenticationFailed
	}
	return s.begin(ctx, issuer, browserSecret, &token, clientKey)
}

func (s *OidcService) begin(ctx context.Context, issuer, browserSecret string, token *string, clientKey string) (string, error) {
	provider, err := s.provider(issuer)
	if err != nil {
		return "", err
	}
	browserHash, err := credential.SessionDigest(browserSecret)
	if err != nil {
		return "", err
	}
	if err := s.service.RateLimit(ctx, clientKey, credential.RateLimitClient(clientKey), "oidc"); err != nil {
		return "", err
	}
	state := credential.NewSessionSecret()
	stateHash, err := credential.SessionDigest(state)
	if err != nil {
		return "", err
	}
	nonce, verifier := oauth2.GenerateVerifier(), oauth2.GenerateVerifier()
	purpose, linking, enrollmentHash := purposeLogin, (*string)(nil), []byte(nil)
	var tokenHash []byte
	var invitation credential.RootInvitation
	if token != nil {
		if tokenHash, err = credential.SessionDigest(*token); err != nil {
			return "", err
		}
		if invitation, err = s.invitationByToken(ctx, provider, tokenHash); err != nil {
			return "", err
		}
		if enrollmentHash, err = credential.RootEnrollmentHash(invitation, issuer); err != nil {
			return "", err
		}
		purpose, linking = purposeActivation, &invitation.UserID
	}
	_, err = database.Run(ctx, s.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		if err := providerCurrent(tx, provider); err != nil {
			return struct{}{}, err
		}
		if token != nil {
			current, err := rootInvitations(tx, invitationByToken, issuer, tokenHash)
			if err != nil {
				return struct{}{}, err
			}
			if !sameInvitation(current[0], invitation) {
				return struct{}{}, apperror.ErrAuthenticationFailed
			}
		}
		if _, err := tx.Exec(deleteExpiredAttempts); err != nil {
			return struct{}{}, err
		}
		_, err := tx.Exec(insertAttempt, stateHash, nonce, verifier, issuer, provider.settings.Version,
			provider.settings.RedirectURI, browserHash, purpose, linking, enrollmentHash)
		return struct{}{}, err
	}, database.RunOptions{})
	if err != nil {
		return "", err
	}
	return provider.authorizationURL(state, nonce, verifier), nil
}

// invitationByToken reads the live invitation of the token so its hash is computed outside the transaction
// that writes the attempt; that transaction reads it again and requires the same row.
func (s *OidcService) invitationByToken(ctx context.Context, provider *OidcProvider, tokenHash []byte) (credential.RootInvitation, error) {
	return database.Run(ctx, s.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (credential.RootInvitation, error) {
		if err := providerCurrent(tx, provider); err != nil {
			return credential.RootInvitation{}, err
		}
		found, err := rootInvitations(tx, invitationByToken, provider.settings.Issuer, tokenHash)
		if err != nil {
			return credential.RootInvitation{}, err
		}
		return found[0], nil
	}, database.RunOptions{})
}

// Callback ends the attempt of the browser. An iss parameter must name the attempt's provider exactly; an IdP
// that publishes RFC 9207 support must send one. The query is parsed strictly, since url.URL.Query drops a
// malformed pair, and a repeated iss hidden that way would go unseen. The attempt is consumed before the code
// exchange, so a failed exchange needs a new attempt.
func (s *OidcService) Callback(ctx context.Context, current *url.URL, browserSecret string) (Session, error) {
	browserHash, err := credential.SessionDigest(browserSecret)
	if err != nil {
		return Session{}, err
	}
	query, err := url.ParseQuery(current.RawQuery)
	if err != nil || len(query["state"]) != 1 || len(query["iss"]) > 1 {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	stateHash, err := credential.SessionDigest(query.Get("state"))
	if err != nil {
		return Session{}, err
	}
	issuer, stated := query.Get("iss"), len(query["iss"]) == 1
	if !stated {
		if issuer, err = s.attemptIssuer(ctx, stateHash, browserHash); err != nil {
			return Session{}, err
		}
	}
	provider, err := s.provider(issuer)
	if err != nil {
		return Session{}, err
	}
	callback, err := url.Parse(provider.settings.RedirectURI)
	codes, failures := len(query["code"]), len(query["error"])
	if err != nil || (!stated && provider.requiresIssuerParameter) || current.Scheme != callback.Scheme || current.Host != callback.Host ||
		current.EscapedPath() != callback.EscapedPath() || current.Fragment != "" || codes+failures != 1 {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	consumed, err := database.Run(ctx, s.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (attempt, error) {
		if err := providerCurrent(tx, provider); err != nil {
			return attempt{}, err
		}
		rows, err := tx.Query(consumeAttempt, stateHash, browserHash, issuer, provider.settings.Version)
		if err != nil {
			return attempt{}, err
		}
		found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (attempt, error) {
			var a attempt
			err := row.Scan(&a.nonce, &a.verifier, &a.issuer, &a.version, &a.redirectURI, &a.linkingUserID, &a.enrollmentHash, &a.purpose)
			return a, err
		})
		if err != nil {
			return attempt{}, err
		}
		if len(found) != 1 {
			return attempt{}, apperror.ErrAuthenticationFailed
		}
		return found[0], nil
	}, database.RunOptions{})
	if err != nil {
		return Session{}, err
	}
	if failures == 1 || query.Get("code") == "" {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	claims, err := provider.exchange(ctx, query.Get("code"), consumed.verifier, consumed.nonce, time.Now())
	if err != nil {
		return Session{}, err
	}
	return s.complete(ctx, provider, consumed, claims)
}

func (s *OidcService) attemptIssuer(ctx context.Context, stateHash, browserHash []byte) (string, error) {
	return database.Run(ctx, s.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (string, error) {
		rows, err := tx.Query(attemptIssuer, stateHash, browserHash)
		if err != nil {
			return "", err
		}
		found, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return "", err
		}
		if len(found) == 0 {
			return "", apperror.ErrAuthenticationFailed
		}
		return found[0], nil
	}, database.RunOptions{})
}
