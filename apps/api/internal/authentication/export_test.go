package authentication

import (
	"context"
	"time"
)

const (
	MaxProviderBody = maxProviderBody
	ProviderTimeout = providerTimeout
)

var LiveEnrollment = liveEnrollment

func RequiresIssuerParameter(p *OidcProvider) bool { return p.requiresIssuerParameter }

// PrepareMfa is the step before the fence.
func PrepareMfa(ctx context.Context, m *MfaService, secret, clientKey string) error {
	_, err := m.prepare(ctx, secret, clientKey)
	return err
}

// ConfirmAfter is Confirm with between run after the code was matched against the snapshot.
func ConfirmAfter(ctx context.Context, m *MfaService, secret, code, clientKey string, between func()) (MfaConfirmation, error) {
	caller, err := m.prepare(ctx, secret, clientKey)
	if err != nil {
		return MfaConfirmation{}, err
	}
	match := m.matchCode(caller, code)
	between()
	return m.confirmMatch(ctx, caller, match)
}

// VerifyCodeAfter is Verify of a TOTP code with between run after it was matched against the snapshot.
func VerifyCodeAfter(ctx context.Context, m *MfaService, secret, code, clientKey string, between func()) (Session, error) {
	caller, err := m.prepare(ctx, secret, clientKey)
	if err != nil {
		return Session{}, err
	}
	match := m.matchCode(caller, code)
	between()
	return m.verifyMatch(ctx, caller, MfaProof{Code: code}, match, nil)
}

func VerifyIDToken(ctx context.Context, p *OidcProvider, raw, nonce string, now time.Time) (VerifiedClaims, error) {
	return p.verify(ctx, raw, nonce, now)
}

func ExchangeCode(ctx context.Context, p *OidcProvider, code, verifier, nonce string, now time.Time) (VerifiedClaims, error) {
	return p.exchange(ctx, code, verifier, nonce, now)
}

func AuthorizationURL(p *OidcProvider, state, nonce, verifier string) string {
	return p.authorizationURL(state, nonce, verifier)
}
