package core

import (
	"maps"
	"slices"
	"strings"
)

type FieldType struct {
	Kind     FieldKind `json:"kind"`
	Nullable bool      `json:"nullable,omitempty"`
}

// ActionDeclaration states its boundary for every action: `required` denies without a binding,
// `optional` enforces one if bound.
type ActionDeclaration struct {
	Policy   RelationRef         `json:"policy"`
	Boundary BoundaryRequirement `json:"boundary"`
}

type ResourceDeclaration struct {
	Key     string                       `json:"key"`
	KeyKind KeyKind                      `json:"keyKind"`
	Fields  map[string]FieldType         `json:"fields"`
	Actions map[string]ActionDeclaration `json:"actions"`
}

type BindingKind string

const (
	BindingEdgeStore BindingKind = "edgeStore"
	BindingDomain    BindingKind = "domain"
)

type RelationBinding struct {
	Kind BindingKind `json:"kind"`
	Key  string      `json:"key,omitempty"`
}

type RelationDeclaration struct {
	Key        string          `json:"key"`
	Version    int             `json:"version"`
	SourceType string          `json:"sourceType"`
	Target     RelationTarget  `json:"target"`
	Binding    RelationBinding `json:"binding"`
}

type ContextRequirement struct {
	Validator  string            `json:"validator"`
	Parameters map[string]Scalar `json:"parameters"`
}

// PermissionPolicy is the code-owned contract every grant path of a permission must satisfy.
// RequiredScope is ANDed outside every grant, including record allows.
type PermissionPolicy struct {
	Key                 string               `json:"key"`
	Version             int                  `json:"version"`
	Lifecycle           Lifecycle            `json:"lifecycle,omitempty"`
	ContextRequirements []ContextRequirement `json:"contextRequirements"`
	RequiredScope       Expr                 `json:"requiredScope"`
	Obligations         []Obligation         `json:"obligations"`
}

type BoundaryEntry struct {
	Permission          string               `json:"permission"`
	ContextRequirements []ContextRequirement `json:"contextRequirements"`
	RequiredScope       Expr                 `json:"requiredScope"`
}

// PermissionBoundary is a code-owned limit bound to a user per permission. Entries only restrict,
// ANDed outside every allow, and never grant.
type PermissionBoundary struct {
	Key       string          `json:"key"`
	Version   int             `json:"version"`
	Lifecycle Lifecycle       `json:"lifecycle,omitempty"`
	Entries   []BoundaryEntry `json:"entries"`
}

// ScopeTemplate is a reviewed scope. Parameters are typed values bound per rule; no code, no SQL.
type ScopeTemplate struct {
	Key        string               `json:"key"`
	Version    int                  `json:"version"`
	Resource   string               `json:"resource"`
	Parameters map[string]FieldKind `json:"parameters"`
	Expression Expr                 `json:"expression"`
}

// DeclarationLimits uses pointers because an explicit 0 is an error, while an absent limit takes its default.
type DeclarationLimits struct {
	MaxPathDepth       *int
	MaxExpressionNodes *int
	MaxRules           *int
}

type EffectiveLimits struct {
	MaxPathDepth       int `json:"maxPathDepth"`
	MaxExpressionNodes int `json:"maxExpressionNodes"`
	MaxRules           int `json:"maxRules"`
}

type Capabilities struct {
	Validators         []string `json:"validators"`
	ObligationHandlers []string `json:"obligationHandlers"`
}

// SystemDeclarations has every list required: a nil list is a declaration error, an empty one is not.
type SystemDeclarations struct {
	Resources    []ResourceDeclaration
	Relations    []RelationDeclaration
	Policies     []PermissionPolicy
	Templates    []ScopeTemplate
	Boundaries   []PermissionBoundary
	Capabilities Capabilities
	Limits       DeclarationLimits
}

// ValidatedDeclarations comes from Core.Validate only. Its tables are private copies of the source;
// every accessor returns another copy, so no caller can change what later plans read.
type ValidatedDeclarations struct {
	owner        *Core
	self         *ValidatedDeclarations
	resources    map[string]ResourceDeclaration
	relations    map[string]RelationDeclaration
	policies     map[string]PermissionPolicy
	templates    map[string]ScopeTemplate
	boundaries   map[string]PermissionBoundary
	capabilities Capabilities
	limits       EffectiveLimits
	canonical    string
}

func listSorted[T any](table map[string]T, clone func(T) T) []T {
	items := make([]T, 0, len(table))
	for _, key := range slices.Sorted(maps.Keys(table)) {
		items = append(items, clone(table[key]))
	}
	return items
}

func lookup[T any](table map[string]T, key string, clone func(T) T) (T, bool) {
	item, ok := table[key]
	if !ok {
		var zero T
		return zero, false
	}
	return clone(item), true
}

func same[T any](item T) T { return item }

func (d *ValidatedDeclarations) Resources() []ResourceDeclaration {
	return listSorted(d.resources, cloneResource)
}

func (d *ValidatedDeclarations) Resource(key string) (ResourceDeclaration, bool) {
	return lookup(d.resources, key, cloneResource)
}

func (d *ValidatedDeclarations) Relations() []RelationDeclaration {
	return listSorted(d.relations, same[RelationDeclaration])
}

func (d *ValidatedDeclarations) Relation(ref RelationRef) (RelationDeclaration, bool) {
	return lookup(d.relations, ref.String(), same[RelationDeclaration])
}

func (d *ValidatedDeclarations) Policies() []PermissionPolicy {
	return listSorted(d.policies, clonePolicy)
}

func (d *ValidatedDeclarations) Policy(ref RelationRef) (PermissionPolicy, bool) {
	return lookup(d.policies, ref.String(), clonePolicy)
}

func (d *ValidatedDeclarations) Templates() []ScopeTemplate {
	return listSorted(d.templates, cloneTemplate)
}

func (d *ValidatedDeclarations) Template(ref RelationRef) (ScopeTemplate, bool) {
	return lookup(d.templates, ref.String(), cloneTemplate)
}

func (d *ValidatedDeclarations) Boundaries() []PermissionBoundary {
	return listSorted(d.boundaries, cloneBoundary)
}

func (d *ValidatedDeclarations) Boundary(ref RelationRef) (PermissionBoundary, bool) {
	return lookup(d.boundaries, ref.String(), cloneBoundary)
}

func (d *ValidatedDeclarations) Capabilities() Capabilities {
	return Capabilities{
		Validators:         slices.Clone(d.capabilities.Validators),
		ObligationHandlers: slices.Clone(d.capabilities.ObligationHandlers),
	}
}

func (d *ValidatedDeclarations) Limits() EffectiveLimits { return d.limits }

// Canonical is the order-independent form an adapter hashes for the manifest; the core has no crypto.
func (d *ValidatedDeclarations) Canonical() string { return d.canonical }

// DeclarationsError lists every declaration problem found.
type DeclarationsError struct{ Errors []string }

func (e *DeclarationsError) Error() string { return strings.Join(e.Errors, "; ") }
