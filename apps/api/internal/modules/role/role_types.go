// Package role is the role matrix and the runtime roles (`custom.<name>`): read every role with its rules, read
// the roles and rules of one IAM account, and create, update or delete a runtime role.
package role

import "encoding/json/jsontext"

// Source: `code` is owned by the release and immutable; `runtime` was created through the API.
type Source string

const (
	SourceCode    Source = "code"
	SourceRuntime Source = "runtime"
)

// TemplateRef names a scope template by key and version.
type TemplateRef struct {
	Key     string `json:"key"`
	Version int    `json:"version"`
}

// GrantPair is one `(permission, template)` a runtime role may hold; parameters are always `{}`.
type GrantPair struct {
	Permission string      `json:"permission"`
	Template   TemplateRef `json:"template"`
}

// GrantView is one stored rule of a role, exactly as stored.
type GrantView struct {
	Permission string         `json:"permission"`
	Effect     string         `json:"effect"`
	Template   string         `json:"template"`
	Version    int            `json:"version"`
	Parameters jsontext.Value `json:"parameters"`
}

// View is one role of the matrix. Digest is the expectedDigest a role.update must present; Capabilities are
// the risk classes of its allow rules.
type View struct {
	Key          string       `json:"key"`
	Label        string       `json:"label"`
	Source       Source       `json:"source"`
	Holders      int          `json:"holders"`
	Digest       string       `json:"digest"`
	Capabilities []Capability `json:"capabilities"`
	Grants       []GrantView  `json:"grants"`
}

// MatrixView is role.read: every role, code roles first, and the pairs a runtime role may pick. Truncated means
// a read limit cut the answer.
type MatrixView struct {
	Roles     []View      `json:"roles"`
	Catalog   []GrantPair `json:"catalog"`
	Truncated bool        `json:"truncated"`
}

type HeldRole struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Source Source `json:"source"`
}

// AccountGrant is a rule that applies to the account; source `user` is a rule attached straight to it.
type AccountGrant struct {
	GrantView
	Source string `json:"source"`
}

type BoundaryView struct {
	Permission string `json:"permission"`
	Key        string `json:"key"`
	Version    int    `json:"version"`
	Seeded     bool   `json:"seeded"`
}

// AccountPermissionView is account.readPermissions: the roles an IAM account holds and the rules that apply.
type AccountPermissionView struct {
	Roles      []HeldRole     `json:"roles"`
	Grants     []AccountGrant `json:"grants"`
	Boundaries []BoundaryView `json:"boundaries"`
	Truncated  bool           `json:"truncated"`
}

// CreateInput is a validated role.create body; Label is trimmed.
type CreateInput struct {
	Key    string
	Label  string
	Grants []GrantPair
}

// UpdateInput is the whole new label and grant set of a role and the digest of the one it replaces.
type UpdateInput struct {
	CreateInput
	ExpectedDigest string
}

// WriteResult is the digest the next update must present.
type WriteResult struct {
	Key    string `json:"key"`
	Digest string `json:"digest"`
}

type Removed struct {
	Status string `json:"status"`
}
