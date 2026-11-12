// Package credential holds the pure functions of sign-in that other packages need without linking
// internal/authentication: digests, the login email, the limiter buckets, TOTP and the sealing of TOTP
// secrets. The other runtime reads what a digest or a seal produces from the same database, so these
// keep the bytes of the TypeScript functions.
package credential

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json/v2"
	"regexp"
	"strings"

	"hrm/api/internal/apperror"
)

// FreshAuthSQL is a step-up in the past and less than 300 seconds before the statement time, by the
// clock of the database. Authorization and second factor management share this one condition.
const FreshAuthSQL = `(reauthenticated_at IS NOT NULL AND reauthenticated_at<=statement_timestamp() AND statement_timestamp()-reauthenticated_at<interval '300 seconds')`

const (
	sessionSecretBytes = 32
	maxEmailLength     = 254
)

var (
	sessionSecretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	printableASCII       = regexp.MustCompile(`^[!-~]+$`)
	loginEmailPattern    = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
)

func NewSessionSecret() string {
	raw := make([]byte, sessionSecretBytes)
	_, _ = rand.Read(raw)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func SecretDigest(secret string) []byte {
	digest := sha256.Sum256([]byte(secret))
	return digest[:]
}

// SessionDigest accepts only the form NewSessionSecret writes: 43 base64url characters whose two spare
// bits are zero, so one session has one spelling.
func SessionDigest(secret string) ([]byte, error) {
	if !sessionSecretPattern.MatchString(secret) {
		return nil, apperror.ErrAuthenticationFailed
	}
	if _, err := base64.RawURLEncoding.Strict().DecodeString(secret); err != nil {
		return nil, apperror.ErrAuthenticationFailed
	}
	return SecretDigest(secret), nil
}

// CanonicalLoginEmail checks printable ASCII before lowering, so no other letter lowers into another
// account's address. A caller with admin input answers ErrInvalidRequest instead.
func CanonicalLoginEmail(email string) (string, error) {
	if len(email) > maxEmailLength || !printableASCII.MatchString(email) || !loginEmailPattern.MatchString(email) {
		return "", apperror.ErrAuthenticationFailed
	}
	return strings.ToLower(email), nil
}

// RootInvitation is what a Root activation attempt is bound to.
type RootInvitation struct {
	UserID    string
	Email     string
	AuthEpoch string
	TokenHash []byte
}

// RootEnrollmentHash changes with the user, issuer, email, epoch or token, so a reissue or any change
// voids a begun attempt.
func RootEnrollmentHash(invitation RootInvitation, issuer string) ([]byte, error) {
	encoded, err := json.Marshal([]string{
		invitation.UserID, issuer, invitation.Email, invitation.AuthEpoch, hex.EncodeToString(invitation.TokenHash),
	})
	if err != nil {
		return nil, err
	}
	return SecretDigest(string(encoded)), nil
}
