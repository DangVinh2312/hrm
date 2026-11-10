package administration

import (
	"context"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/grant"
	"hrm/api-go/internal/database"
)

type emailChange struct{ UserID, Email, Issuer string }

func (e emailChange) targetID() string { return e.UserID }

type bindingReset struct{ UserID, Issuer string }

func (b bindingReset) targetID() string { return b.UserID }

// identityCommand is the work of one identity command: lock the target's row, the target's grants within the
// actor's (Root skips) before the function can reveal anything of the account, then the SECURITY DEFINER
// function under its savepoint. The functions refuse a non-IAM account and advance the target's auth_epoch.
func identityCommand[I accountTarget](m commands, kind audit.Kind, call func(tx *database.Tx, actor string, input I) error) func(authority.AdminContext, I) (*audit.Event, error) {
	return func(c authority.AdminContext, input I) (*audit.Event, error) {
		target := input.targetID()
		if err := lockAccount(c.Tx, target); err != nil {
			return nil, err
		}
		within, _, err := grant.WithinActor(c.Tx, m.core, grant.Actor(c.Actor), target)
		if err != nil || !within {
			return nil, err
		}
		done, err := identityOperation(c.Tx, func() error { return call(c.Tx, c.Actor.ID, input) })
		if err != nil || !done {
			return nil, err
		}
		event := accountEvent(kind, c, target, "ok")
		return &event, nil
	}
}

func identityAbsent[I accountTarget](kind audit.Kind) func(authority.AdminContext, I) audit.Event {
	return func(c authority.AdminContext, input I) audit.Event {
		return accountEvent(kind, c, input.targetID(), "absent")
	}
}

// ChangeEmail is account.changeEmail: issuer is the deployment's provider, never a request value, and the email
// is lowered here. The same email or one another account holds is 409.
func (s *Service) ChangeEmail(ctx context.Context, secret, userID, email string) error {
	if s.issuer == "" {
		return apperror.ErrUnavailable
	}
	if !s.operations.core.IsCanonicalUUID(userID) {
		return apperror.ErrAccessDenied
	}
	canonical, err := credential.CanonicalLoginEmail(email)
	if err != nil {
		return apperror.ErrInvalidRequest
	}
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.changeEmail, emailChange{UserID: userID, Email: canonical, Issuer: s.issuer}))
}

// ResetMfa is account.resetMfa; an account without a second factor is 409.
func (s *Service) ResetMfa(ctx context.Context, secret, userID string) error {
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.resetMfa, accountID(userID)))
}

// ResetGoogleBinding is account.resetGoogleBinding at the deployment's provider; an account without an email
// to invite is 409.
func (s *Service) ResetGoogleBinding(ctx context.Context, secret, userID string) error {
	if s.issuer == "" {
		return apperror.ErrUnavailable
	}
	return found(onAccount(ctx, s.authorization, s.operations.core, secret, s.operations.resetGoogleBinding, bindingReset{UserID: userID, Issuer: s.issuer}))
}
