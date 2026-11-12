package employee

import (
	"regexp"
	"strings"
)

var (
	documentGrammar = regexp.MustCompile(`^[A-Z0-9]{6,20}$`)
	taxCodeGrammar  = regexp.MustCompile(`^[0-9]{10,13}(-[0-9]{3})?$`)
	phoneGrammar    = regexp.MustCompile(`^0[1-9][0-9]{8,9}$`)
	emailGrammar    = regexp.MustCompile(`^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	phoneSeparators = strings.NewReplacer(" ", "", ".", "", "-", "", "(", "", ")", "")
)

type identityBody struct {
	DateOfBirth    nullable[string] `json:"dateOfBirth"`
	DocumentKind   nullable[string] `json:"documentKind"`
	DocumentNumber nullable[string] `json:"documentNumber"`
	TaxCode        nullable[string] `json:"taxCode"`
	Gender         nullable[string] `json:"gender"`
	Phone          nullable[string] `json:"phone"`
	WorkEmail      nullable[string] `json:"workEmail"`
}

func isASCII(text string) bool {
	for i := 0; i < len(text); i++ {
		if text[i] >= 0x80 {
			return false
		}
	}
	return true
}

// parsePhone drops separators (space . - parentheses), turns a leading +84 into 0 and needs national digits
// 0[1-9] + 8..9 digits. Letters, other country codes and a bare 84 are refused rather than guessed.
func parsePhone(value string) (string, error) {
	if len(value) > 32 {
		return "", errInvalidFields
	}
	national := phoneSeparators.Replace(value)
	if rest, ok := strings.CutPrefix(national, "+84"); ok {
		national = "0" + rest
	}
	if !phoneGrammar.MatchString(national) {
		return "", errInvalidFields
	}
	return national, nil
}

// parseWorkEmail is trimmed, ASCII only, lowercase, at most 254 characters, a dot-atom subset with a DNS-style
// domain. A non-ASCII character is refused before lowercasing: Unicode case mapping must not make one.
func parseWorkEmail(value string) (string, error) {
	if len(value) > 300 {
		return "", errInvalidFields
	}
	trimmed := strings.TrimFunc(value, isScriptSpace)
	if len(trimmed) > 254 || !isASCII(trimmed) {
		return "", errInvalidFields
	}
	email := strings.ToLower(trimmed)
	if !emailGrammar.MatchString(email) {
		return "", errInvalidFields
	}
	return email, nil
}

func parseDocumentKind(value string) (DocumentKind, error) {
	switch kind := DocumentKind(value); kind {
	case DocumentCCCD, DocumentCMND, DocumentPassport:
		return kind, nil
	default:
		return "", errInvalidFields
	}
}

func parseGender(value string) (Gender, error) {
	switch gender := Gender(value); gender {
	case GenderMale, GenderFemale, GenderOther:
		return gender, nil
	default:
		return "", errInvalidFields
	}
}

func parseDocumentNumber(value string) (string, error) {
	if !documentGrammar.MatchString(value) {
		return "", errInvalidFields
	}
	return value, nil
}

func parseTaxCode(value string) (string, error) {
	if !taxCodeGrammar.MatchString(value) {
		return "", errInvalidFields
	}
	return value, nil
}

// parseIdentity needs every member (null clears it); formats match the table CHECKs, and a document kind
// goes with its number.
func parseIdentity(body *identityBody) (Identity, error) {
	if body == nil {
		return Identity{}, errInvalidFields
	}
	var identity Identity
	var err error
	if identity.DateOfBirth, err = parseOptional(body.DateOfBirth, parseDate); err != nil {
		return Identity{}, err
	}
	if identity.DocumentKind, err = parseOptional(body.DocumentKind, parseDocumentKind); err != nil {
		return Identity{}, err
	}
	if identity.DocumentNumber, err = parseOptional(body.DocumentNumber, parseDocumentNumber); err != nil {
		return Identity{}, err
	}
	if identity.TaxCode, err = parseOptional(body.TaxCode, parseTaxCode); err != nil {
		return Identity{}, err
	}
	if identity.Gender, err = parseOptional(body.Gender, parseGender); err != nil {
		return Identity{}, err
	}
	if identity.Phone, err = parseOptional(body.Phone, parsePhone); err != nil {
		return Identity{}, err
	}
	if identity.WorkEmail, err = parseOptional(body.WorkEmail, parseWorkEmail); err != nil {
		return Identity{}, err
	}
	if (identity.DocumentKind == nil) != (identity.DocumentNumber == nil) {
		return Identity{}, errInvalidFields
	}
	return identity, nil
}
