package authentication

import (
	"context"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/database"
)

// loginStep is the shared fence's answer: a session for a bound subject, or the exclusive work still needed
// (verify marks a bound account whose unverified email the token proves).
type loginStep struct {
	session *Session
	verify  bool
}

// complete runs the purpose's transactions after the exchange. A bound (issuer, sub) decides alone; only an
// unbound subject whose verified email matches a live enrollment, or a bound account whose email the token
// verifies, takes the exclusive fence, so an unknown visitor never does.
func (s *OidcService) complete(ctx context.Context, provider *OidcProvider, consumed attempt, claims VerifiedClaims) (Session, error) {
	next, err := NewSessionCredential()
	if err != nil {
		return Session{}, err
	}
	switch consumed.purpose {
	case purposeLogin:
		return s.login(ctx, provider, claims, next)
	case purposeActivation:
		return s.activate(ctx, provider, consumed, claims, next)
	}
	return Session{}, apperror.ErrAuthenticationFailed
}

func (s *OidcService) login(ctx context.Context, provider *OidcProvider, claims VerifiedClaims, next SessionCredential) (Session, error) {
	issuer := provider.settings.Issuer
	step, err := database.Run(ctx, s.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (loginStep, error) {
		if err := providerCurrent(tx, provider); err != nil {
			return loginStep{}, err
		}
		bound, verifies, err := boundVerifies(tx, issuer, claims.Subject, claims.Email)
		if err != nil {
			return loginStep{}, err
		}
		if bound && verifies {
			return loginStep{verify: true}, nil
		}
		if bound {
			session, err := issueOidcSession(tx, oidcLogin{provider: provider, claims: claims}, next)
			return loginStep{session: &session}, err
		}
		if claims.Email == nil {
			return loginStep{}, apperror.ErrAuthenticationFailed
		}
		_, live, err := liveEnrollment(tx, issuer, *claims.Email, false)
		if err == nil && !live {
			err = apperror.ErrAuthenticationFailed
		}
		return loginStep{}, err
	}, database.RunOptions{})
	if err != nil {
		return Session{}, err
	}
	if step.session != nil {
		return *step.session, nil
	}
	return database.Run(ctx, s.service.runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (Session, error) {
		if err := providerCurrent(tx, provider); err != nil {
			return Session{}, err
		}
		if !step.verify {
			if claims.Email == nil {
				return Session{}, apperror.ErrAuthenticationFailed
			}
			if err := bindEnrollment(tx, issuer, claims.Subject, *claims.Email); err != nil {
				return Session{}, err
			}
		}
		return issueOidcSession(tx, oidcLogin{provider: provider, claims: claims, verifiesEmail: claims.Email}, next)
	}, database.RunOptions{})
}

// activate needs the token used at begin still live at commit and the IdP vouching for the enrollment's
// email. The invitations are hashed between the two transactions.
func (s *OidcService) activate(ctx context.Context, provider *OidcProvider, consumed attempt, claims VerifiedClaims, next SessionCredential) (Session, error) {
	issuer := provider.settings.Issuer
	if claims.Email == nil || consumed.linkingUserID == nil || consumed.enrollmentHash == nil {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	invitations, err := database.Run(ctx, s.service.runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) ([]credential.RootInvitation, error) {
		if err := providerCurrent(tx, provider); err != nil {
			return nil, err
		}
		return rootInvitations(tx, invitationByUser, issuer, *consumed.linkingUserID)
	}, database.RunOptions{})
	if err != nil {
		return Session{}, err
	}
	chosen, ok := chooseInvitation(invitations, issuer, consumed.enrollmentHash)
	if !ok || chosen.UserID != *consumed.linkingUserID {
		return Session{}, apperror.ErrAuthenticationFailed
	}
	return database.Run(ctx, s.service.runner, database.ModeRevoke, func(_ context.Context, tx *database.Tx) (Session, error) {
		if err := providerCurrent(tx, provider); err != nil {
			return Session{}, err
		}
		if err := activateRoot(tx, issuer, claims.Subject, claims.Email, chosen); err != nil {
			return Session{}, err
		}
		return issueOidcSession(tx, oidcLogin{provider: provider, claims: claims, verifiesEmail: claims.Email}, next)
	}, database.RunOptions{})
}
