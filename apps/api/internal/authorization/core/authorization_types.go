package core

import (
	"encoding/json"
	"errors"
	"strconv"
)

// IdentityID is a canonical lowercase UUID; the type is not a security boundary.
type IdentityID string

type KeyKind string

const (
	KeyInteger KeyKind = "integer"
	KeyUUID    KeyKind = "uuid"
	KeyString  KeyKind = "string"
)

// Key keeps integers as canonical decimal strings, never as a Go number.
type Key struct {
	Kind  KeyKind
	Value string
}

func (k Key) String() string { return string(k.Kind) + ":" + k.Value }

type FieldKind string

const (
	FieldInteger   FieldKind = "integer"
	FieldDecimal   FieldKind = "decimal"
	FieldString    FieldKind = "string"
	FieldUUID      FieldKind = "uuid"
	FieldBoolean   FieldKind = "boolean"
	FieldTimestamp FieldKind = "timestamp"
)

type scalarKind uint8

const (
	scalarInvalid scalarKind = iota
	scalarText
	scalarBool
)

var errInvalidScalar = errors.New("value has no scalar")

// Scalar is a text or boolean value; the zero value is neither and every codec refuses it.
type Scalar struct {
	kind scalarKind
	text string
	flag bool
}

func Text(value string) Scalar { return Scalar{kind: scalarText, text: value} }

func Bool(value bool) Scalar { return Scalar{kind: scalarBool, flag: value} }

func (s Scalar) AsText() (string, bool) { return s.text, s.kind == scalarText }

func (s Scalar) AsBool() (bool, bool) { return s.flag, s.kind == scalarBool }

func (s Scalar) MarshalJSON() ([]byte, error) {
	switch s.kind {
	case scalarText:
		return json.Marshal(s.text)
	case scalarBool:
		return json.Marshal(s.flag)
	case scalarInvalid:
	}
	return nil, errInvalidScalar
}

// FieldValue is a scalar or SQL NULL; the zero value is neither, so a malformed fact never reads as NULL.
type FieldValue struct {
	scalar Scalar
	null   bool
}

func Value(scalar Scalar) FieldValue { return FieldValue{scalar: scalar} }

func TextValue(value string) FieldValue { return Value(Text(value)) }

func BoolValue(value bool) FieldValue { return Value(Bool(value)) }

func NullValue() FieldValue { return FieldValue{null: true} }

func (v FieldValue) IsNull() bool { return v.null }

func (v FieldValue) AsText() (string, bool) { return v.scalar.AsText() }

func (v FieldValue) AsBool() (bool, bool) { return v.scalar.AsBool() }

func (v FieldValue) MarshalJSON() ([]byte, error) {
	if v.null {
		return []byte("null"), nil
	}
	return v.scalar.MarshalJSON()
}

type RelationRef struct {
	Key     string `json:"key"`
	Version int    `json:"version"`
}

func (r RelationRef) String() string { return r.Key + "@" + strconv.Itoa(r.Version) }

type Obligation struct {
	Handler string `json:"handler"`
}

type TrustedPrincipal struct {
	ID        IdentityID
	Assurance int
}

// TrustedInput is built by trusted adapters only: verified session, validated routing, authority clock.
// Now and ValidUntil are `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`; ValidUntil is min(session expiry, request deadline).
type TrustedInput struct {
	Principal  TrustedPrincipal
	Resource   string
	Action     string
	Context    map[string]Scalar
	Now        string
	ValidUntil string
}

type ValidatorResult uint8

const (
	ValidatorUnknown ValidatorResult = iota
	ValidatorFalse
	ValidatorTrue
)

type ValidatorInput struct {
	Principal TrustedPrincipal
	Context   map[string]Scalar
}

// ContextValidator reads trusted context only: no record data, no network I/O.
// Anything other than ValidatorTrue, including a panic, denies.
type ContextValidator func(parameters map[string]Scalar, input ValidatorInput) ValidatorResult

type Lifecycle string

const (
	LifecycleActive     Lifecycle = "active"
	LifecycleDeprecated Lifecycle = "deprecated"
	LifecycleRetired    Lifecycle = "retired"
)

type BoundaryRequirement string

const (
	BoundaryRequired BoundaryRequirement = "required"
	BoundaryOptional BoundaryRequirement = "optional"
)

// PermissionFact is a catalog row. An empty Boundary (not yet synced) never matches the code and denies.
type PermissionFact struct {
	Key       string
	Resource  string
	Action    string
	Policy    RelationRef
	Boundary  BoundaryRequirement
	Lifecycle Lifecycle
}

type BoundaryBindingFact struct {
	Identity   IdentityID
	Permission string
	Boundary   RelationRef
	Lifecycle  Lifecycle
}

type Effect string

const (
	EffectAllow Effect = "allow"
	EffectDeny  Effect = "deny"
)

type SubjectKind string

const (
	SubjectRole     SubjectKind = "role"
	SubjectIdentity SubjectKind = "identity"
)

type RuleSubject struct {
	Kind     SubjectKind
	Role     string
	Identity IdentityID
}

type RuleFact struct {
	ID         string
	Permission string
	Subject    RuleSubject
	Effect     Effect
	Template   RelationRef
	Parameters map[string]Scalar
}

type UserState string

const (
	UserActive    UserState = "active"
	UserSuspended UserState = "suspended"
	UserPending   UserState = "pending"
)

type AuthorityUser struct {
	ID    IdentityID
	State UserState
}

type Registry struct {
	Validators         map[string]ContextValidator
	ObligationHandlers []string
}

// AuthoritySnapshot holds authority facts read inside the application transaction, plus the adapter's registry.
type AuthoritySnapshot struct {
	Revision     string
	Declarations *ValidatedDeclarations
	User         *AuthorityUser
	Roles        []string
	Permissions  []PermissionFact
	Rules        []RuleFact
	Boundaries   []BoundaryBindingFact
	Registry     Registry
}

type FactObject struct {
	Type     string
	Key      Key
	ObjectID string
	Fields   map[string]FieldValue
}

type EdgeTargetKind string

const (
	EdgeTargetObject   EdgeTargetKind = "object"
	EdgeTargetIdentity EdgeTargetKind = "identity"
)

type EdgeTarget struct {
	Kind     EdgeTargetKind
	ObjectID string
	Identity IdentityID
}

type EdgeFact struct {
	Relation  RelationRef
	Source    string
	Target    EdgeTarget
	StartsAt  string
	ExpiresAt *string
}

type ExceptionPurpose string

const (
	PurposeManual    ExceptionPurpose = "manual"
	PurposeEmergency ExceptionPurpose = "emergency"
)

type ExceptionFact struct {
	ObjectID   string
	Permission string
	Subject    RuleSubject
	Effect     Effect
	Purpose    ExceptionPurpose
	StartsAt   string
	ExpiresAt  *string
	RevokedAt  *string
}

// CompleteFacts is everything needed to decide one record; missing facts make the evaluator deny.
type CompleteFacts struct {
	Now        string
	Record     FactObject
	Objects    []FactObject
	Edges      []EdgeFact
	Exceptions []ExceptionFact
}
