package setting

import (
	"encoding/json/v2"
	"regexp"
	"strconv"

	"hrm/api/internal/apperror"
	"hrm/api/internal/httpapi"
	"hrm/api/internal/modules/settingcore"
)

var integerGrammar = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,18})$`)

// updateBody is the PUT body {value, expectedVersion}; DecodeCommand refuses any other member.
type updateBody struct {
	Value           bodyValue `json:"value"`
	ExpectedVersion string    `json:"expectedVersion"`
}

// bodyValue is a JSON integer or string. The integer is read from its text, never through float64, so
// 1.5, 6.0 and 6e0 are refused like true, null, an array or an object. A missing member stays zero,
// which Validate refuses.
type bodyValue struct{ value settingcore.Value }

func (v *bodyValue) UnmarshalJSON(raw []byte) error {
	if len(raw) > 0 && raw[0] == '"' {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return apperror.ErrInvalidRequest
		}
		v.value = settingcore.TextValue(text)
		return nil
	}
	if !integerGrammar.Match(raw) {
		return apperror.ErrInvalidRequest
	}
	number, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		return apperror.ErrInvalidRequest
	}
	v.value = settingcore.IntValue(number)
	return nil
}

// parseKey is a key of the registry (any group), for the history route.
func parseKey(value string) (settingcore.Key, error) {
	if _, ok := settingcore.Lookup(value); !ok {
		return "", apperror.ErrInvalidRequest
	}
	return settingcore.Key(value), nil
}

// parseHistoryQuery is ?limit=&offset= only, under the shared page budget (default 20, max 100).
func parseHistoryQuery(rawQuery string) (httpapi.Page, error) {
	return httpapi.InputPageQuery(rawQuery)
}

// parseVersion is the optimistic version of a setting: "0" is "no row yet", then a positive int8 as text.
func parseVersion(value string) (string, error) {
	if value == "0" {
		return value, nil
	}
	return httpapi.InputVersion(value)
}

// parseUpdate checks the key belongs to the group of the route, so the permission that was checked is
// the one the key needs.
func parseUpdate(group settingcore.Group, key string, body updateBody) (UpdateInput, error) {
	def, ok := settingcore.Lookup(key)
	if !ok || def.Group != group {
		return UpdateInput{}, apperror.ErrInvalidRequest
	}
	value, err := settingcore.Validate(key, body.Value.value)
	if err != nil {
		return UpdateInput{}, err
	}
	version, err := parseVersion(body.ExpectedVersion)
	if err != nil {
		return UpdateInput{}, err
	}
	return UpdateInput{Key: settingcore.Key(key), Value: value, ExpectedVersion: version}, nil
}
