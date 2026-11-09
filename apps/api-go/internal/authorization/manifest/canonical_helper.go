package manifest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"slices"
)

func canonical[T any](value T) (string, error) {
	b, err := json.Marshal(value, json.Deterministic(true))
	if err != nil {
		return "", err
	}
	raw := jsontext.Value(b)
	if err := raw.Compact(jsontext.ReorderRawObjects(true)); err != nil {
		return "", err
	}
	return string(raw), nil
}

func digest(text string) string {
	h := sha256.Sum256([]byte(text))
	return hex.EncodeToString(h[:])
}

func sortedForms[T any](values []T) ([]jsontext.Value, error) {
	forms := make([]string, 0, len(values))
	for _, value := range values {
		form, err := canonical(value)
		if err != nil {
			return nil, err
		}
		forms = append(forms, form)
	}
	slices.Sort(forms)
	out := make([]jsontext.Value, 0, len(forms))
	for _, form := range forms {
		out = append(out, jsontext.Value(form))
	}
	return out, nil
}

func grantID(grant DefaultGrant) (string, error) {
	form, err := canonical(grant)
	if err != nil {
		return "", err
	}
	h := digest(form)
	const digits = "89ab"
	nibble := 0
	const hexDigits = "0123456789abcdef"
	for i := range len(hexDigits) {
		if hexDigits[i] == h[16] {
			nibble = i
			break
		}
	}
	return h[:8] + "-" + h[8:12] + "-5" + h[13:16] + "-" + string(digits[nibble&3]) + h[17:20] + "-" + h[20:32], nil
}
