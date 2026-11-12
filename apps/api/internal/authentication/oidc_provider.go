package authentication

import (
	"context"
	"encoding/json/v2"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"hrm/api/internal/apperror"
	"hrm/api/internal/config"
)

const (
	providerTimeout = 5 * time.Second
	maxClientID     = 256
	// maxProviderBody bounds an IdP answer: go-oidc reads discovery and keys with io.ReadAll.
	maxProviderBody = 1 << 20
)

var (
	providerVersion = regexp.MustCompile(`^[1-9][0-9]{0,17}$`)
	// ErrOidcConfiguration is a provider that cannot be trusted as configured; it names no value.
	ErrOidcConfiguration = errors.New("invalid OIDC configuration")
	loopbackHosts        = []string{"localhost", "127.0.0.1", "::1"}
)

// OidcProvider is one discovered IdP: RS256 only, every network call bounded by providerTimeout and never
// following a redirect.
type OidcProvider struct {
	settings config.ProductOidcProviderConfig
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	client   *http.Client
	// requiresIssuerParameter is the IdP publishing RFC 9207 support: a callback without iss is refused.
	requiresIssuerParameter bool
}

func trustedURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil &&
		parsed.Fragment == "" && parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Opaque == ""
}

// trustedRedirectURL also takes HTTP on a loopback host, for local development (RFC 8252 section 7.3).
func trustedRedirectURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if parsed.Scheme == "http" && slices.Contains(loopbackHosts, parsed.Hostname()) && parsed.User == nil &&
		parsed.Fragment == "" && parsed.RawQuery == "" && !parsed.ForceQuery && parsed.Opaque == "" {
		return true
	}
	return trustedURL(raw)
}

func endpointURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Fragment == ""
}

func validSettings(settings config.ProductOidcProviderConfig) bool {
	if !trustedURL(settings.Issuer) || !trustedRedirectURL(settings.RedirectURI) || settings.ClientID == "" ||
		utf8.RuneCountInString(settings.ClientID) > maxClientID || !providerVersion.MatchString(settings.Version) {
		return false
	}
	for _, mapping := range settings.AssuranceMappings {
		if mapping.Acr == "" || len(mapping.Amr) == 0 || mapping.Assurance != "mfa" {
			return false
		}
		for _, method := range mapping.Amr {
			if method == "" {
				return false
			}
		}
	}
	return true
}

// NewOidcProvider checks the settings and runs discovery; the discovered issuer must be the configured one.
// client carries the trust roots; the provider copies it with its own timeout and redirect rule.
func NewOidcProvider(ctx context.Context, settings config.ProductOidcProviderConfig, client *http.Client) (*OidcProvider, error) {
	if !validSettings(settings) || client == nil {
		return nil, ErrOidcConfiguration
	}
	bounded := *client
	bounded.Timeout = providerTimeout
	bounded.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	bounded.Transport = boundedBodies{base: client.Transport}
	if client.Transport == nil {
		bounded.Transport = boundedBodies{base: http.DefaultTransport}
	}
	discovered, err := oidc.NewProvider(oidc.ClientContext(ctx, &bounded), settings.Issuer)
	if err != nil {
		return nil, ErrOidcConfiguration
	}
	var document []byte
	var metadata struct {
		Issuer                  string `json:"issuer"`
		AuthorizationURL        string `json:"authorization_endpoint"`
		TokenURL                string `json:"token_endpoint"`
		JWKS                    string `json:"jwks_uri"`
		RequiresIssuerParameter bool   `json:"authorization_response_iss_parameter_supported"`
	}
	if discovered.Claims((*rawPayload)(&document)) != nil || json.Unmarshal(document, &metadata) != nil || metadata.Issuer != settings.Issuer ||
		!endpointURL(metadata.AuthorizationURL) || !endpointURL(metadata.TokenURL) || !endpointURL(metadata.JWKS) {
		return nil, ErrOidcConfiguration
	}
	endpoint := oauth2.Endpoint{AuthURL: metadata.AuthorizationURL, TokenURL: metadata.TokenURL, AuthStyle: oauth2.AuthStyleInParams}
	keys := oidc.NewRemoteKeySet(oidc.ClientContext(context.WithoutCancel(ctx), &bounded), metadata.JWKS)
	return &OidcProvider{
		settings: settings,
		oauth: oauth2.Config{
			ClientID: settings.ClientID, ClientSecret: settings.ClientSecret, Endpoint: endpoint,
			RedirectURL: settings.RedirectURI, Scopes: []string{oidc.ScopeOpenID, oidc.ScopeEmail, oidc.ScopeProfile},
		},
		verifier: oidc.NewVerifier(settings.Issuer, keys, &oidc.Config{
			ClientID: settings.ClientID, SupportedSigningAlgs: []string{oidc.RS256}, SkipExpiryCheck: true,
		}),
		client:                  &bounded,
		requiresIssuerParameter: metadata.RequiresIssuerParameter,
	}, nil
}

// boundedBodies fails a read past maxProviderBody.
type boundedBodies struct{ base http.RoundTripper }

func (b boundedBodies) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := b.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	response.Body = http.MaxBytesReader(nil, response.Body, maxProviderBody)
	return response, nil
}

// authorizationURL asks for a code with PKCE S256 and the nonce.
func (p *OidcProvider) authorizationURL(state, nonce, verifier string) string {
	return p.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oidc.Nonce(nonce))
}

// exchange redeems the code and checks the ID token; now is the clock for exp and nbf. Every failure is
// the generic authentication failure, so no IdP answer reaches a caller or a log.
func (p *OidcProvider) exchange(ctx context.Context, code, verifier, nonce string, now time.Time) (VerifiedClaims, error) {
	ctx, cancel := context.WithTimeout(context.WithValue(ctx, oauth2.HTTPClient, p.client), providerTimeout)
	defer cancel()
	token, err := p.oauth.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return VerifiedClaims{}, apperror.ErrAuthenticationFailed
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok || raw == "" {
		return VerifiedClaims{}, apperror.ErrAuthenticationFailed
	}
	return p.verify(ctx, raw, nonce, now)
}

func (p *OidcProvider) verify(ctx context.Context, raw, nonce string, now time.Time) (VerifiedClaims, error) {
	token, err := p.verifier.Verify(ctx, raw)
	if err != nil {
		return VerifiedClaims{}, apperror.ErrAuthenticationFailed
	}
	var payload []byte
	if err := token.Claims((*rawPayload)(&payload)); err != nil {
		return VerifiedClaims{}, apperror.ErrAuthenticationFailed
	}
	return checkIDTokenClaims(payload, claimRules{
		issuer: p.settings.Issuer, clientID: p.settings.ClientID, nonce: nonce, mappings: p.settings.AssuranceMappings,
	}, now.Unix())
}

// rawPayload takes a document from go-oidc as it is: Claims decodes with encoding/json v1, which matches
// names without case and keeps the last of a repeated name, so the document is read again here.
type rawPayload []byte

func (r *rawPayload) UnmarshalJSON(data []byte) error {
	*r = append((*r)[:0], data...)
	return nil
}
