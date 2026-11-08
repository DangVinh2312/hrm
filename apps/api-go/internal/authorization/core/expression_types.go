package core

import "encoding/json"

type LogicalOp string

const (
	OpAnd LogicalOp = "and"
	OpOr  LogicalOp = "or"
)

type CompareOp string

const (
	OpEq  CompareOp = "eq"
	OpLt  CompareOp = "lt"
	OpLte CompareOp = "lte"
)

type ValueSource string

const (
	SourceLiteral   ValueSource = "literal"
	SourcePrincipal ValueSource = "principal"
	SourceContext   ValueSource = "context"
	SourceParameter ValueSource = "parameter"
)

// ValueRef names where a compared value comes from. Literal applies to SourceLiteral, Name to the others.
type ValueRef struct {
	From    ValueSource `json:"from"`
	Name    string      `json:"name,omitempty"`
	Literal FieldValue  `json:"value,omitzero"`
}

// Expr is the declaration AST written by system code. It has no `not`: only the core creates one.
// The set is closed, and a value of any other type (nil, a pointer, a struct embedding a member)
// is refused by the validator.
type Expr interface{ isExpr() }

type ConstantExpr struct{ Value bool }

type LogicalExpr struct {
	Op   LogicalOp
	Args []Expr
}

type CompareExpr struct {
	Op    CompareOp
	Field string
	Value ValueRef
}

type IsNullExpr struct{ Field string }

// ExistsExpr names its relation as `key@version`.
type ExistsExpr struct {
	Relation string
	Where    Expr
}

func (ConstantExpr) isExpr() {}

func (LogicalExpr) isExpr() {}

func (CompareExpr) isExpr() {}

func (IsNullExpr) isExpr() {}

func (ExistsExpr) isExpr() {}

func (e ConstantExpr) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Op    string `json:"op"`
		Value bool   `json:"value"`
	}{"constant", e.Value})
}

func (e LogicalExpr) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Op   LogicalOp `json:"op"`
		Args []Expr    `json:"args"`
	}{e.Op, e.Args})
}

func (e CompareExpr) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Op    CompareOp `json:"op"`
		Field string    `json:"field"`
		Value ValueRef  `json:"value"`
	}{e.Op, e.Field, e.Value})
}

func (e IsNullExpr) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Op    string `json:"op"`
		Field string `json:"field"`
	}{"isNull", e.Field})
}

func (e ExistsExpr) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Op       string `json:"op"`
		Relation string `json:"relation"`
		Where    Expr   `json:"where"`
	}{"exists", e.Relation, e.Where})
}

// PlanExpr is the lowered, typed, fully bound predicate. Compilers and the evaluator consume only this.
type PlanExpr interface{ isPlanExpr() }

type PlanConstant struct{ Value bool }

type PlanLogical struct {
	Op   LogicalOp
	Args []PlanExpr
}

type PlanNot struct{ Arg PlanExpr }

type PlanCompare struct {
	Op    CompareOp
	Field string
	Kind  FieldKind
	Value Scalar
}

type PlanIsNull struct{ Field string }

type RelationTargetKind string

const (
	RelationTargetResource RelationTargetKind = "resource"
	RelationTargetIdentity RelationTargetKind = "identity"
)

type RelationTarget struct {
	Kind RelationTargetKind `json:"kind"`
	Type string             `json:"type,omitempty"`
}

type PlanExists struct {
	Relation RelationRef
	Source   string
	Target   RelationTarget
	Where    PlanExpr
}

// PlanException is the record exception lookup on the requested object; only the core creates it.
type PlanException struct {
	Effect     Effect
	Permission string
	Identity   IdentityID
	Roles      []string
}

func (PlanConstant) isPlanExpr() {}

func (PlanLogical) isPlanExpr() {}

func (PlanNot) isPlanExpr() {}

func (PlanCompare) isPlanExpr() {}

func (PlanIsNull) isPlanExpr() {}

func (PlanExists) isPlanExpr() {}

func (PlanException) isPlanExpr() {}
