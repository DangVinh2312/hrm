package setting

import "hrm/api/internal/modules/settingcore"

// UpdateInput is a validated update; ExpectedVersion is "0" for a key with no row yet.
type UpdateInput struct {
	Key             settingcore.Key
	Value           settingcore.Value
	ExpectedVersion string
}

type UpdateResult struct {
	Version string `json:"version"`
}

// View is one registered key with the value in force. Version is int8 as text, "0" while the key has no
// row; UpdatedAt is nil then. Unit, Min and Max are set for an int key, MaxLength for text, Values for enum.
type View struct {
	Key       settingcore.Key   `json:"key"`
	Group     settingcore.Group `json:"group"`
	Default   jsonValue         `json:"default"`
	Value     jsonValue         `json:"value"`
	Version   string            `json:"version"`
	IsDefault bool              `json:"isDefault"`
	UpdatedAt *string           `json:"updatedAt"`
	Kind      settingcore.Kind  `json:"kind"`
	Unit      settingcore.Unit  `json:"unit,omitzero"`
	Min       *int64            `json:"min,omitzero"`
	Max       *int64            `json:"max,omitzero"`
	MaxLength *int              `json:"maxLength,omitzero"`
	Values    []string          `json:"values,omitzero"`
}

// CanUpdate is a display hint of the groups the caller may update; the update authorizes itself.
type CanUpdate struct {
	Rule    bool `json:"rule"`
	Profile bool `json:"profile"`
}

type ListView struct {
	Settings  []View    `json:"settings"`
	CanUpdate CanUpdate `json:"canUpdate"`
}

type ProfileView struct {
	CompanyName   string `json:"companyName"`
	DefaultLocale string `json:"defaultLocale"`
}

type HistoryItem struct {
	Version   string    `json:"version"`
	OldValue  jsonValue `json:"oldValue"`
	NewValue  jsonValue `json:"newValue"`
	ChangedAt string    `json:"changedAt"`
}

// HistoryView is a page of changes of one key, newest first; Total is int8 as text.
type HistoryView struct {
	Items []HistoryItem `json:"items"`
	Total string        `json:"total"`
}

// SecurityView is the session and authentication timings in force. View only: not a setting, not stored.
type SecurityView struct {
	FreshAuthenticationSeconds int `json:"freshAuthenticationSeconds"`
	SessionHours               int `json:"sessionHours"`
	RateLimitWindowMinutes     int `json:"rateLimitWindowMinutes"`
	OidcAttemptMinutes         int `json:"oidcAttemptMinutes"`
	IdleMinutes                int `json:"idleMinutes"`
}

type storedSetting struct {
	Key       string
	Value     []byte
	Version   string
	UpdatedAt string
}
