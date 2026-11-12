package authentication

import (
	"encoding/json/v2"
	"regexp"
	"unicode/utf8"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authentication/credential"
)

const maxBodyText = 2048

var totpCodePattern = regexp.MustCompile(`^[0-9]{6}$`)

// bodyText is a member of a request body that is a string when it is there: null is a member too, so
// {"recoveryCode":null,"code":"123456"} is both proofs and not a TOTP code.
type bodyText struct {
	present bool
	text    string
}

func (t *bodyText) UnmarshalJSON(raw []byte) error {
	if len(raw) == 0 || raw[0] != '"' {
		return apperror.ErrInvalidRequest
	}
	t.present = true
	return json.Unmarshal(raw, &t.text)
}

// required is the text of a member the route cannot go without. The text is not trimmed or checked further:
// an issuer is matched against the configured ones and a token only ever hashed, so neither reaches SQL.
func (t bodyText) required() (string, error) {
	if !t.present || utf8.RuneCountInString(t.text) > maxBodyText {
		return "", apperror.ErrInvalidRequest
	}
	return t.text, nil
}

type confirmBody struct {
	Code bodyText `json:"code"`
}

type proofBody struct {
	Code         bodyText `json:"code"`
	RecoveryCode bodyText `json:"recoveryCode"`
}

// parseTotpCode takes exactly six ASCII digits; anything else is a malformed request, not a wrong code.
func parseTotpCode(field bodyText) (string, error) {
	code, err := field.required()
	if err != nil {
		return "", err
	}
	if !totpCodePattern.MatchString(code) {
		return "", apperror.ErrInvalidRequest
	}
	return code, nil
}

// parseMfaProof takes one of the two proofs, never both. A recovery code that cannot be one is malformed.
func parseMfaProof(body proofBody) (MfaProof, error) {
	if !body.RecoveryCode.present {
		code, err := parseTotpCode(body.Code)
		return MfaProof{Code: code}, err
	}
	code, err := body.RecoveryCode.required()
	if err != nil || body.Code.present {
		return MfaProof{}, apperror.ErrInvalidRequest
	}
	if _, valid := credential.NormalizeRecoveryCode(code); !valid {
		return MfaProof{}, apperror.ErrInvalidRequest
	}
	return MfaProof{Code: code, Recovery: true}, nil
}
