package setting

import (
	"encoding/json/v2"
	"errors"
	"strconv"

	"hrm/api/internal/modules/settingcore"
)

var errNoValueKind = errors.New("setting value has no kind")

// jsonValue writes a setting value as a JSON number or string.
type jsonValue settingcore.Value

func (v jsonValue) MarshalJSON() ([]byte, error) {
	switch v.Kind {
	case settingcore.ValueInt:
		return strconv.AppendInt(nil, v.Int, 10), nil
	case settingcore.ValueText:
		return json.Marshal(v.Text)
	}
	return nil, errNoValueKind
}

// SecurityPolicy is what the security page shows. The values are enforced elsewhere (credential.FreshAuthSQL,
// the session, limiter and OIDC statements of authentication, resolve_session for idle), so
// test/setting_security_policy_test.go fails when one of them drifts from this view.
func SecurityPolicy() SecurityView {
	return SecurityView{FreshAuthenticationSeconds: 300, SessionHours: 12, RateLimitWindowMinutes: 15, OidcAttemptMinutes: 5, IdleMinutes: 30}
}

// settingViews is every registered key with the value in force, in the order of the registry: the stored
// row, or the default at version 0 when there is none. A row of a key outside the registry is ignored,
// since the application cannot write it; a stored value the registry refuses is ErrStoredInvalid.
func settingViews(rows []storedSetting) ([]View, error) {
	stored := make(map[settingcore.Key]storedSetting, len(rows))
	for _, row := range rows {
		stored[settingcore.Key(row.Key)] = row
	}
	keys := settingcore.Keys()
	views := make([]View, 0, len(keys))
	for _, key := range keys {
		row, found := stored[key]
		view, err := settingView(key, row, found)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func settingView(key settingcore.Key, row storedSetting, found bool) (View, error) {
	def, _ := settingcore.Lookup(string(key))
	view := View{Key: key, Group: def.Group, Default: jsonValue(def.Default), Value: jsonValue(def.Default), Version: "0", IsDefault: !found, Kind: def.Kind}
	if found {
		value, err := settingcore.Stored(key, row.Value)
		if err != nil {
			return View{}, err
		}
		updatedAt := row.UpdatedAt
		view.Value, view.Version, view.UpdatedAt = jsonValue(value), row.Version, &updatedAt
	}
	switch def.Kind {
	case settingcore.KindInt:
		view.Unit, view.Min, view.Max = def.Unit, &def.Min, &def.Max
	case settingcore.KindText:
		view.MaxLength = &def.MaxLength
	case settingcore.KindEnum:
		view.Values = def.Values
	default:
		return View{}, settingcore.ErrUnknownSetting
	}
	return view, nil
}
