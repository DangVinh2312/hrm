package httpapi

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"hrm/api/internal/apperror"
)

var (
	uuidGrammar    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	versionGrammar = regexp.MustCompile(`^[1-9][0-9]{0,17}$`)
)

// isScriptSpace is the set String.prototype.trim removes: ECMAScript WhiteSpace and LineTerminator.
// It differs from unicode.IsSpace: U+FEFF is in, U+0085 is out.
func isScriptSpace(r rune) bool {
	switch r {
	case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func InputText(value string, limit int) (string, error) {
	text := strings.TrimFunc(value, isScriptSpace)
	if text == "" || !utf8.ValidString(text) || utf8.RuneCountInString(text) > limit {
		return "", apperror.ErrInvalidRequest
	}
	for _, r := range text {
		if r < 0x20 || r == 0x7f {
			return "", apperror.ErrInvalidRequest
		}
	}
	return text, nil
}

func InputUUID(value string) (string, error) {
	if !uuidGrammar.MatchString(value) {
		return "", apperror.ErrInvalidRequest
	}
	return value, nil
}

func InputVersion(value string) (string, error) {
	if !versionGrammar.MatchString(value) {
		return "", apperror.ErrInvalidRequest
	}
	return value, nil
}

func InputBoolean(value *bool) (bool, error) {
	if value == nil {
		return false, apperror.ErrInvalidRequest
	}
	return *value, nil
}
