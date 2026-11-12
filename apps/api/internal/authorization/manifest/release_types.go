package manifest

import "hrm/api/internal/authorization/core"

type Role struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type DefaultGrant struct {
	Permission string                 `json:"permission"`
	Role       string                 `json:"role"`
	Template   core.RelationRef       `json:"template"`
	Parameters map[string]core.Scalar `json:"parameters"`
}

type Endpoint struct {
	Type string   `json:"type"`
	Key  core.Key `json:"key"`
}

type RelationSeed struct {
	Owner     string           `json:"owner"`
	Key       string           `json:"key"`
	Relation  core.RelationRef `json:"relation"`
	Source    Endpoint         `json:"source"`
	Target    Endpoint         `json:"target"`
	StartsAt  string           `json:"startsAt"`
	ExpiresAt string           `json:"expiresAt,omitempty"`
}

type SeedRemoval struct {
	Owner string `json:"owner"`
	Key   string `json:"key"`
}

type BoundaryBinding struct {
	Owner      string           `json:"owner"`
	Identity   string           `json:"identity"`
	Permission string           `json:"permission"`
	Boundary   core.RelationRef `json:"boundary"`
}

type BoundaryRemoval struct {
	Owner      string `json:"owner"`
	Identity   string `json:"identity"`
	Permission string `json:"permission"`
}

type Source struct {
	Sequence               string
	Predecessor            string
	Declarations           core.SystemDeclarations
	Roles                  []Role
	DefaultGrants          []DefaultGrant
	RemoveDefaultGrants    []DefaultGrant
	Seeds                  []RelationSeed
	RemoveSeeds            []SeedRemoval
	BoundaryBindings       []BoundaryBinding
	RemoveBoundaryBindings []BoundaryRemoval
}

type Release struct {
	source       Source
	declarations *core.ValidatedDeclarations
	owner        *core.Core
	hash         string
}

func (r Release) Sequence() string                          { return r.source.Sequence }
func (r Release) Hash() string                              { return r.hash }
func (r Release) Declarations() *core.ValidatedDeclarations { return r.declarations }

type Rejection struct{ Reason string }

func (r *Rejection) Error() string { return "manifest: " + r.Reason }
func reject(reason string) error   { return &Rejection{Reason: reason} }

type Result struct {
	Changed      bool
	Revision     string
	ManifestHash string
}
