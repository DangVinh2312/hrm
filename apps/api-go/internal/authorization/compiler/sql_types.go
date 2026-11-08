package compiler

import (
	"bytes"
	"errors"
	"fmt"
	"slices"

	"hrm/api-go/internal/authorization/core"
)

type ParamKind uint8

const (
	paramInvalid ParamKind = iota
	ParamText
	ParamBool
	ParamInt
	ParamBytes
)

type Param struct {
	kind  ParamKind
	text  string
	flag  bool
	num   int64
	bytes []byte
}

func TextParam(value string) Param {
	return Param{kind: ParamText, text: value}
}

func BoolParam(value bool) Param {
	return Param{kind: ParamBool, flag: value}
}

func IntParam(value int64) Param {
	return Param{kind: ParamInt, num: value}
}

func BytesParam(value []byte) Param {
	return Param{kind: ParamBytes, bytes: slices.Clone(value)}
}

func (p Param) Kind() ParamKind { return p.kind }

func (p Param) AsText() (string, bool) {
	return p.text, p.kind == ParamText
}

func (p Param) AsBool() (bool, bool) {
	return p.flag, p.kind == ParamBool
}

func (p Param) AsInt() (int64, bool) {
	return p.num, p.kind == ParamInt
}

func (p Param) AsBytes() ([]byte, bool) {
	if p.kind != ParamBytes {
		return nil, false
	}
	return slices.Clone(p.bytes), true
}

func (p Param) Equal(other Param) bool {
	if p.kind != other.kind || p.kind == paramInvalid {
		return false
	}
	switch p.kind {
	case ParamText:
		return p.text == other.text
	case ParamBool:
		return p.flag == other.flag
	case ParamInt:
		return p.num == other.num
	case ParamBytes:
		return bytes.Equal(p.bytes, other.bytes)
	case paramInvalid:
		return false
	default:
		return false
	}
}

type Bound struct {
	SQL        string
	Parameters []Param
}

type BindFunc func(value Param, pgType string) string

type NextAliasFunc func(prefix string) string

type Scope interface {
	isScope()
}

type ResourceScope struct {
	Alias   string
	Binding ResourceBinding
}

func (ResourceScope) isScope() {}

type IdentityScope struct {
	Column string
}

func (IdentityScope) isScope() {}

func CompileWith(
	plan *core.AuthorizedPlan,
	registry *Registry,
	alias string,
	bind BindFunc,
) (string, error) {
	if registry == nil || registry.Core() == nil || !registry.Core().Issued(plan) {
		return "", errors.New("authorized plan was not issued by this authorization core")
	}
	if len(alias) != 1 || alias[0] < 'a' || alias[0] > 'z' {
		return "", errors.New("predicate alias must be a single letter")
	}
	if bind == nil {
		return "", errors.New("bind callback is required")
	}
	binding, err := registry.Resource(plan.Resource())
	if err != nil {
		return "", err
	}
	counters := map[string]int{"e": 0, "t": 0, "x": 0}
	nextAlias := func(prefix string) string {
		counters[prefix]++
		return fmt.Sprintf("%s_%s%d", alias, prefix, counters[prefix])
	}
	predicate, err := CompileExpression(plan.Predicate(), registry, ResourceScope{Alias: alias, Binding: binding}, bind, nextAlias)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("statement_timestamp() < %s AND %s", bind(TextParam(plan.ValidUntil()), "timestamptz"), predicate), nil
}

func CompilePlanAt(
	plan *core.AuthorizedPlan,
	registry *Registry,
	alias string,
	firstIndex int,
) (Bound, error) {
	if firstIndex < 1 {
		return Bound{}, errors.New("firstIndex must be at least 1")
	}
	var parameters []Param
	sql, err := CompileWith(plan, registry, alias, func(value Param, pgType string) string {
		parameters = append(parameters, value)
		return fmt.Sprintf("CAST($%d AS %s)", firstIndex+len(parameters)-1, pgType)
	})
	if err != nil {
		return Bound{}, err
	}
	return Bound{SQL: sql, Parameters: parameters}, nil
}

func CompilePlan(plan *core.AuthorizedPlan, registry *Registry) (Bound, error) {
	return CompilePlanAt(plan, registry, "r", 1)
}

func checkAlias(alias string) error {
	if !identifierPattern.MatchString(alias) {
		return fmt.Errorf("unsafe SQL alias: %q", alias)
	}
	return nil
}

func activeWindow(alias, starts, expires string) (string, error) {
	qStarts, err := QuoteIdentifier(starts)
	if err != nil {
		return "", err
	}
	qExpires, err := QuoteIdentifier(expires)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s.%s <= statement_timestamp() AND (%s.%s IS NULL OR %s.%s > statement_timestamp())", alias, qStarts, alias, qExpires, alias, qExpires), nil
}
