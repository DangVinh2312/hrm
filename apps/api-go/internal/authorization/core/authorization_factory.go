// Package core decides authorization purely: declaration validation, planning and evaluation over a closed
// AST. It knows no domain, no Root, no clock and no I/O; the caller passes time and hashes the canonical form.
package core

import (
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrInvalidValue is the answer of a codec that refuses the input. Any other error from
	// NormalizeValue, CompareValues and the Canonical methods is a fault of the kind or the codec.
	ErrInvalidValue = errors.New("value is not valid for its kind")

	errUnknownKind    = errors.New("unknown field kind")
	errCodecContract  = errors.New("value codec answered outside its contract")
	errUnknownKeyKind = errors.New("unknown key kind")
)

func codecFailure() error {
	return &DeclarationsError{Errors: []string{"declarations could not be validated: value codec failure"}}
}

// Core is one authorization engine bound to one set of value codecs. Declarations and plans carry the
// provenance of the instance that produced them; another instance refuses them.
type Core struct{ codecs ValueCodecs }

// New has no default codec: a missing one fails here. A codec that panics or answers outside its
// contract surfaces later, and every decision path turns that into deny.
func New(values ValueCodecs) (*Core, error) {
	c := &Core{codecs: values}
	for _, kind := range fieldKinds {
		if c.codec(kind) == nil {
			return nil, fmt.Errorf("value codec %s is missing", kind)
		}
	}
	return c, nil
}

func (c *Core) codec(kind FieldKind) ScalarCodec {
	if c == nil {
		return nil
	}
	switch kind {
	case FieldInteger:
		return c.codecs.Integer
	case FieldDecimal:
		return c.codecs.Decimal
	case FieldString:
		return c.codecs.String
	case FieldUUID:
		return c.codecs.UUID
	case FieldBoolean:
		return c.codecs.Boolean
	case FieldTimestamp:
		return c.codecs.Timestamp
	}
	return nil
}

// Validate checks declarations for boot and CI readiness. Anything unknown or ambiguous is an error;
// the result is a private copy that only this instance accepts.
func (c *Core) Validate(declarations SystemDeclarations) (validated *ValidatedDeclarations, err error) {
	defer func() {
		if recover() != nil {
			validated, err = nil, codecFailure()
		}
	}()
	for _, kind := range fieldKinds {
		if c.codec(kind) == nil {
			return nil, codecFailure()
		}
	}
	return validateDeclarations(c, declarations)
}

// IsValidated is true only for declarations this instance validated.
func (c *Core) IsValidated(declarations *ValidatedDeclarations) bool {
	return c != nil && declarations != nil && declarations.owner == c && declarations.self == declarations
}

// Issued is true only for a plan this instance produced.
func (c *Core) Issued(plan *AuthorizedPlan) bool {
	return c != nil && plan != nil && plan.issuer == c && plan.self == plan
}

func denyOnPanic(decision *Decision) {
	if recover() != nil {
		*decision = Decision{reason: reasonInternalError}
	}
}

// Plan builds the plan of a principal under grants:
// P = policy.requiredScope AND boundary.requiredScope AND (allow scopes OR record allow)
//
//	AND NOT (deny scopes OR record deny).
//
// Any missing, unknown or malformed fact or configuration denies; inputs are not changed.
func (c *Core) Plan(input TrustedInput, snapshot AuthoritySnapshot) (decision Decision) {
	defer denyOnPanic(&decision)
	plan, err := c.planUser(input, snapshot)
	if err != nil {
		return deniedBy(err)
	}
	return Decision{plan: plan}
}

// PlanUnrestricted is for a principal the caller verified as unrestricted. It keeps the target, principal,
// user, validity and revision checks and the action policy with its context requirements; the predicate
// is true, so no grant, deny, required scope, boundary or obligation applies. The core never learns why.
func (c *Core) PlanUnrestricted(input TrustedInput, snapshot AuthoritySnapshot) (decision Decision) {
	defer denyOnPanic(&decision)
	plan, err := c.planUnrestricted(input, snapshot)
	if err != nil {
		return deniedBy(err)
	}
	return Decision{plan: plan}
}

// Evaluate decides one record against a plan of this instance with complete facts. It serves record
// checks and differential tests against SQL; it does not replace query enforcement.
func (c *Core) Evaluate(plan *AuthorizedPlan, facts CompleteFacts) (decision Decision) {
	defer denyOnPanic(&decision)
	if !c.Issued(plan) {
		return Decision{reason: "foreign_plan"}
	}
	allowed, err := c.evaluate(plan, facts)
	if err != nil {
		return deniedBy(err)
	}
	if !allowed {
		return Decision{reason: "predicate_false"}
	}
	return Decision{plan: plan}
}

func (c *Core) issue(resource, action, permission, revision string, user IdentityID, validUntil string, predicate PlanExpr, obligations []Obligation) *AuthorizedPlan {
	plan := &AuthorizedPlan{
		issuer: c, userID: user, resource: resource, action: action, permission: permission,
		revision: revision, predicate: predicate, validUntil: validUntil, obligations: obligations,
	}
	plan.self = plan
	return plan
}

// NormalizeValue returns the canonical value of a kind, ErrInvalidValue when the input is not one.
func (c *Core) NormalizeValue(kind FieldKind, input FieldValue) (Scalar, error) {
	codec := c.codec(kind)
	if codec == nil {
		return Scalar{}, errUnknownKind
	}
	value, ok := codec.Normalize(input)
	if !ok {
		return Scalar{}, ErrInvalidValue
	}
	_, isText := value.AsText()
	_, isBool := value.AsBool()
	if (kind == FieldBoolean && !isBool) || (kind != FieldBoolean && !isText) {
		return Scalar{}, errCodecContract
	}
	return value, nil
}

// CompareValues orders two normalized values exactly.
func (c *Core) CompareValues(kind FieldKind, left, right Scalar) (Comparison, error) {
	codec := c.codec(kind)
	if codec == nil {
		return 0, errUnknownKind
	}
	order, err := codec.Compare(left, right)
	if err != nil {
		return 0, err
	}
	switch order {
	case Less, Equal, Greater:
		return order, nil
	}
	return 0, errCodecContract
}

func (c *Core) canonicalText(kind FieldKind, input string) (string, error) {
	value, err := c.NormalizeValue(kind, TextValue(input))
	if err != nil {
		return "", err
	}
	text, _ := value.AsText()
	return text, nil
}

func (c *Core) CanonicalTimestamp(input string) (string, error) {
	return c.canonicalText(FieldTimestamp, input)
}

func (c *Core) CanonicalInt64(input string) (string, error) {
	return c.canonicalText(FieldInteger, input)
}

// ParseKey reads an external key: canonical int64 text, uuid (lowercased), or text of 1..256 UTF-8 bytes.
// A Go integer key goes through strconv.FormatInt; there is no path through a float.
func (c *Core) ParseKey(kind KeyKind, input string) (Key, error) {
	var field FieldKind
	switch kind {
	case KeyInteger:
		field = FieldInteger
	case KeyUUID:
		field = FieldUUID
	case KeyString:
		field = FieldString
	default:
		return Key{}, errUnknownKeyKind
	}
	value, err := c.canonicalText(field, input)
	if err != nil {
		return Key{}, fmt.Errorf("%s key: %w", kind, err)
	}
	if kind == KeyString && (value == "" || len(value) > MaxKeyBytes) {
		return Key{}, fmt.Errorf("string key must have 1-%d UTF-8 bytes: %w", MaxKeyBytes, ErrInvalidValue)
	}
	return Key{Kind: kind, Value: value}, nil
}

// IsCanonicalUUID leaves validity to the codec and keeps lowercase as the core's own invariant, so a
// codec that keeps uppercase cannot relax identity checks.
func (c *Core) IsCanonicalUUID(input string) bool {
	if input != strings.ToLower(input) {
		return false
	}
	value, err := c.canonicalText(FieldUUID, input)
	return err == nil && value == input
}
