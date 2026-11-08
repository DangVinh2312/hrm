package credential

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 TOTP is HMAC-SHA1, the algorithm authenticator apps implement
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

// TOTPSecretBytes is the size of a TOTP secret: RFC 6238 over RFC 4226 HOTP with HMAC-SHA1, 6 digits and
// 30 s steps. The step comes from the clock of the database; nothing here reads the machine clock.
const TOTPSecretBytes = 20

const (
	totpDigits         = 6
	recoveryCodeBytes  = 10
	maxRecoveryInput   = 64
	recoveryGroupWidth = 4
)

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

var (
	base32NoPadding  = base32.NewEncoding(base32Alphabet).WithPadding(base32.NoPadding)
	errBase32        = errors.New("invalid base32")
	totpCode         = regexp.MustCompile(`^[0-9]{6}$`)
	recoveryCode     = regexp.MustCompile(`^[A-Z2-7]{16}$`)
	uriUnreservedSet = "-_.!~*'()"
)

// Base32Encode is RFC 4648 base32, upper case, without padding: the form authenticator apps accept.
func Base32Encode(raw []byte) string {
	return base32NoPadding.EncodeToString(raw)
}

// Base32Decode accepts only what Base32Encode writes. encoding/base32 has no strict mode: it skips line
// breaks and ignores nonzero spare bits, so a text that does not encode back to itself is refused.
func Base32Decode(text string) ([]byte, error) {
	decoded, err := base32NoPadding.DecodeString(text)
	if err != nil || Base32Encode(decoded) != text {
		return nil, errBase32
	}
	return decoded, nil
}

func hotp(secret []byte, counter uint64, digits int) string {
	message := binary.BigEndian.AppendUint64(nil, counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(message)
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 15
	binaryCode := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	modulus := uint32(1)
	for range digits {
		modulus *= 10
	}
	return fmt.Sprintf("%0*d", digits, binaryCode%modulus)
}

// HOTP is the 6 digit RFC 4226 code of counter.
func HOTP(secret []byte, counter uint64) string {
	return hotp(secret, counter, totpDigits)
}

// MatchTOTP returns the step of step-1, step or step+1 whose code equals code. Every candidate is
// computed and compared, so the time taken does not tell which step matched. The caller still requires
// the matched step to exceed the last one used.
func MatchTOTP(secret []byte, code string, step uint64) (uint64, bool) {
	if !totpCode.MatchString(code) {
		return 0, false
	}
	candidates := make([]uint64, 0, 3)
	if step > 0 {
		candidates = append(candidates, step-1)
	}
	candidates = append(candidates, step)
	if step < math.MaxUint64 {
		candidates = append(candidates, step+1)
	}
	var matched uint64
	found := false
	for _, candidate := range candidates {
		if subtle.ConstantTimeCompare([]byte(HOTP(secret, candidate)), []byte(code)) == 1 && !found {
			matched, found = candidate, true
		}
	}
	return matched, found
}

// escapeURIComponent escapes as encodeURIComponent does: every byte but ASCII letters, digits and
// -_.!~*'() becomes %XX.
func escapeURIComponent(text string) string {
	var escaped strings.Builder
	for i := range len(text) {
		c := text[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.IndexByte(uriUnreservedSet, c) >= 0 {
			escaped.WriteByte(c)
			continue
		}
		fmt.Fprintf(&escaped, "%%%02X", c)
	}
	return escaped.String()
}

// TOTPURI is the authenticator URI; the label is `HRM:<email>`, or `HRM` for an account without email.
func TOTPURI(secret []byte, email *string) string {
	label := "HRM"
	if email != nil {
		label += ":" + escapeURIComponent(*email)
	}
	return "otpauth://totp/" + label + "?secret=" + Base32Encode(secret) + "&issuer=HRM&algorithm=SHA1&digits=6&period=30"
}

// NewRecoveryCode is 80 random bits as 16 base32 characters.
func NewRecoveryCode() string {
	raw := make([]byte, recoveryCodeBytes)
	_, _ = rand.Read(raw)
	return Base32Encode(raw)
}

// FormatRecoveryCode is the shown form `XXXX-XXXX-XXXX-XXXX`.
func FormatRecoveryCode(code string) string {
	if len(code) == 0 || len(code)%recoveryGroupWidth != 0 {
		return code
	}
	groups := make([]string, 0, len(code)/recoveryGroupWidth)
	for i := 0; i < len(code); i += recoveryGroupWidth {
		groups = append(groups, code[i:i+recoveryGroupWidth])
	}
	return strings.Join(groups, "-")
}

// isJSWhiteSpace is the JavaScript \s set: ECMAScript WhiteSpace (with U+FEFF and every Zs) and
// LineTerminator. unicode.IsSpace differs from it (U+0085 in, U+FEFF out).
func isJSWhiteSpace(c rune) bool {
	switch c {
	case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return c >= 0x2000 && c <= 0x200a
}

// NormalizeRecoveryCode turns typed input into the canonical code: case, hyphens and JavaScript white
// space are ignored, anything else fails. Only ASCII letters are upper-cased, so no other letter (U+017F,
// U+0131, U+00DF, the ligatures U+FB00-FB06) turns into code characters.
func NormalizeRecoveryCode(input string) (string, bool) {
	if utf8.RuneCountInString(input) > maxRecoveryInput {
		return "", false
	}
	var code strings.Builder
	for _, c := range input {
		switch {
		case c == '-' || isJSWhiteSpace(c):
		case c >= 'a' && c <= 'z':
			code.WriteRune(c - 'a' + 'A')
		default:
			code.WriteRune(c)
		}
	}
	if !recoveryCode.MatchString(code.String()) {
		return "", false
	}
	return code.String(), true
}

// RecoveryCodeHash binds a purpose label and the user id: 80 bits resist offline search without a slow
// hash.
func RecoveryCodeHash(userID, code string) []byte {
	digest := sha256.Sum256([]byte("HRM-MFA-RECOVERY\x00v1\x00" + userID + "\x00" + code))
	return digest[:]
}
