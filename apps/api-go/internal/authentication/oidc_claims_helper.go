package authentication

import (
	"bytes"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"math"
	"slices"
	"unicode/utf8"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/config"
)

const (
	// clockTolerance is the seconds of skew allowed on exp and nbf.
	clockTolerance = 30
	maxSubject     = 512
	// maxAuthTime is 9999-12-31T23:59:59Z, far inside the range of PostgreSQL.
	maxAuthTime = 253402300799
)

// VerifiedClaims is what a checked ID token proves. AuthTime is nil when the token has none; Email is the
// canonical address only when the IdP marked it verified with the boolean true.
type VerifiedClaims struct {
	Subject   string
	Assurance string
	AuthTime  *int64
	Email     *string
}

type claimRules struct {
	issuer, clientID, nonce string
	mappings                []config.AssuranceMapping
}

// idTokenClaims keeps each member raw: a member that is absent stays nil, and JSON null is present and of
// the wrong type, so it fails like any other.
type idTokenClaims struct {
	Issuer        jsontext.Value `json:"iss"`
	Subject       jsontext.Value `json:"sub"`
	Audience      jsontext.Value `json:"aud"`
	AuthorizedBy  jsontext.Value `json:"azp"`
	Nonce         jsontext.Value `json:"nonce"`
	Expiry        jsontext.Value `json:"exp"`
	IssuedAt      jsontext.Value `json:"iat"`
	NotBefore     jsontext.Value `json:"nbf"`
	AuthTime      jsontext.Value `json:"auth_time"`
	Email         jsontext.Value `json:"email"`
	EmailVerified jsontext.Value `json:"email_verified"`
	Acr           jsontext.Value `json:"acr"`
	Amr           jsontext.Value `json:"amr"`
}

// checkIDTokenClaims holds the claim checks the signature check leaves: exact issuer, audience with azp
// for several audiences, nonce, exp/iat/nbf by now in whole seconds, the subject and auth_time.
func checkIDTokenClaims(payload []byte, rules claimRules, now int64) (VerifiedClaims, error) {
	var claims idTokenClaims
	if !bytes.HasPrefix(bytes.TrimSpace(payload), []byte("{")) || json.Unmarshal(payload, &claims) != nil {
		return VerifiedClaims{}, apperror.ErrAuthenticationFailed
	}
	issuer, issuerOK := jsonText(claims.Issuer)
	subject, subjectOK := jsonText(claims.Subject)
	nonce, nonceOK := jsonText(claims.Nonce)
	expiry, expiryOK := jsonNumber(claims.Expiry)
	_, issuedOK := jsonNumber(claims.IssuedAt)
	notBefore, notBeforeOK := jsonNumber(claims.NotBefore)
	if !issuerOK || issuer != rules.issuer || !nonceOK || nonce != rules.nonce ||
		!expiryOK || expiry <= float64(now-clockTolerance) || !issuedOK ||
		(claims.NotBefore != nil && (!notBeforeOK || notBefore > float64(now+clockTolerance))) ||
		!subjectOK || subject == "" || utf8.RuneCountInString(subject) > maxSubject ||
		!audienceAccepts(claims, rules.clientID) {
		return VerifiedClaims{}, apperror.ErrAuthenticationFailed
	}
	authTime, err := authTimeOf(claims.AuthTime)
	if err != nil {
		return VerifiedClaims{}, err
	}
	return VerifiedClaims{
		Subject: subject, Assurance: assuranceOf(claims, rules.mappings), AuthTime: authTime, Email: verifiedEmail(claims),
	}, nil
}

func audienceAccepts(claims idTokenClaims, clientID string) bool {
	if single, ok := jsonText(claims.Audience); ok {
		return single == clientID
	}
	audiences, ok := jsonTexts(claims.Audience)
	if !ok || !slices.Contains(audiences, clientID) {
		return false
	}
	if len(audiences) == 1 {
		return true
	}
	party, ok := jsonText(claims.AuthorizedBy)
	return ok && party == clientID
}

func authTimeOf(raw jsontext.Value) (*int64, error) {
	if raw == nil {
		return nil, nil
	}
	value, ok := jsonNumber(raw)
	if !ok || value != math.Trunc(value) || value < 0 || value > maxAuthTime {
		return nil, apperror.ErrAuthenticationFailed
	}
	seconds := int64(value)
	return &seconds, nil
}

// verifiedEmail never fails the login: an address that is not a login email is no email.
func verifiedEmail(claims idTokenClaims) *string {
	if !bytes.Equal(claims.EmailVerified, []byte("true")) {
		return nil
	}
	email, ok := jsonText(claims.Email)
	if !ok {
		return nil
	}
	canonical, err := credential.CanonicalLoginEmail(email)
	if err != nil {
		return nil
	}
	return &canonical
}

func assuranceOf(claims idTokenClaims, mappings []config.AssuranceMapping) string {
	acr, acrOK := jsonText(claims.Acr)
	var amr []jsontext.Value
	if !acrOK || json.Unmarshal(claims.Amr, &amr) != nil || amr == nil {
		return "oidc"
	}
	methods := make([]string, 0, len(amr))
	for _, raw := range amr {
		if method, ok := jsonText(raw); ok {
			methods = append(methods, method)
		}
	}
	for _, mapping := range mappings {
		if mapping.Acr == acr && !slices.ContainsFunc(mapping.Amr, func(want string) bool { return !slices.Contains(methods, want) }) {
			return mapping.Assurance
		}
	}
	return "oidc"
}

func jsonText(raw jsontext.Value) (string, bool) {
	var text string
	if !bytes.HasPrefix(raw, []byte(`"`)) || json.Unmarshal(raw, &text) != nil {
		return "", false
	}
	return text, true
}

func jsonTexts(raw jsontext.Value) ([]string, bool) {
	var texts []string
	if !bytes.HasPrefix(raw, []byte("[")) || json.Unmarshal(raw, &texts) != nil {
		return nil, false
	}
	return texts, true
}

func jsonNumber(raw jsontext.Value) (float64, bool) {
	var number float64
	if len(raw) == 0 || (raw[0] != '-' && (raw[0] < '0' || raw[0] > '9')) || json.Unmarshal(raw, &number) != nil {
		return 0, false
	}
	return number, true
}
