package settingcore

import (
	"bytes"
	"encoding/json/v2"
	"math/big"
	"slices"
	"strings"
	"unicode/utf8"

	"hrm/api/internal/apperror"
)

const maxSafeInteger = 1<<53 - 1

// isScriptSpace is the set String.prototype.trim removes (WhiteSpace and LineTerminator), as in
// httpapi.InputText; settingcore may not import httpapi.
func isScriptSpace(r rune) bool {
	switch r {
	case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Validate is the normalized value of key for input, or ErrInvalidRequest: an unknown key, a wrong
// kind, a value outside min..max, too long, with a control character, or outside the enum. The one
// check used by the request, the command (which does not trust its caller) and the read of a stored row.
func Validate(key string, input Value) (Value, error) {
	def, ok := Lookup(key)
	if !ok {
		return Value{}, apperror.ErrInvalidRequest
	}
	switch def.Kind {
	case KindInt:
		if input.Kind != ValueInt || input.Int < def.Min || input.Int > def.Max {
			return Value{}, apperror.ErrInvalidRequest
		}
		return IntValue(input.Int), nil
	case KindText:
		if input.Kind != ValueText || !utf8.ValidString(input.Text) {
			return Value{}, apperror.ErrInvalidRequest
		}
		text := strings.TrimFunc(input.Text, isScriptSpace)
		if utf8.RuneCountInString(text) > def.MaxLength || strings.ContainsFunc(text, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			return Value{}, apperror.ErrInvalidRequest
		}
		return TextValue(text), nil
	case KindEnum:
		if input.Kind != ValueText || !slices.Contains(def.Values, input.Text) {
			return Value{}, apperror.ErrInvalidRequest
		}
		return TextValue(input.Text), nil
	}
	return Value{}, apperror.ErrInvalidRequest
}

// Stored is the value of a stored jsonb row. A row outside the registry is not a request error: the
// table was changed behind the application, so it fails closed as ErrStoredInvalid (a server error)
// instead of silently using a default.
func Stored(key Key, raw []byte) (Value, error) {
	value, ok := decodeStored(raw)
	if !ok {
		return Value{}, ErrStoredInvalid
	}
	checked, err := Validate(string(key), value)
	if err != nil {
		return Value{}, ErrStoredInvalid
	}
	return checked, nil
}

func decodeStored(raw []byte) (Value, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return Value{}, false
	}
	if raw[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return Value{}, false
		}
		return TextValue(text), true
	}
	if strings.Trim(string(raw), "0123456789+-.eE") != "" {
		return Value{}, false
	}
	number, ok := new(big.Rat).SetString(string(raw))
	if !ok || !number.IsInt() || !number.Num().IsInt64() {
		return Value{}, false
	}
	integer := number.Num().Int64()
	if integer > maxSafeInteger || integer < -maxSafeInteger {
		return Value{}, false
	}
	return IntValue(integer), true
}
