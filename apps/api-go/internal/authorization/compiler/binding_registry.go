// Package compiler validates storage bindings against validated declarations and compiles
// authorized plans and expressions into parameterized PostgreSQL predicates.
package compiler

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"

	"hrm/api-go/internal/authorization/core"
)

var identifierPattern = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

type ResourceBinding struct {
	Resource       string            `json:"resource"`
	Table          string            `json:"table"`
	ObjectIDColumn string            `json:"objectIdColumn"`
	KeyColumn      string            `json:"keyColumn"`
	Columns        map[string]string `json:"columns"`
	Projection     []string          `json:"projection"`
}

type DomainRelationBinding struct {
	Table         string `json:"table"`
	SourceColumn  string `json:"sourceColumn"`
	TargetColumn  string `json:"targetColumn"`
	StartsColumn  string `json:"startsColumn,omitempty"`
	ExpiresColumn string `json:"expiresColumn,omitempty"`
}

type StorageBindings struct {
	Resources []ResourceBinding                `json:"resources"`
	Domains   map[string]DomainRelationBinding `json:"domains"`
}

type Registry struct {
	core         *core.Core
	declarations *core.ValidatedDeclarations
	resources    map[string]ResourceBinding
	domains      map[string]DomainRelationBinding
}

func QuoteIdentifier(name string) (string, error) {
	if !identifierPattern.MatchString(name) {
		return "", fmt.Errorf("unsafe SQL identifier: %q", name)
	}
	return `"` + name + `"`, nil
}

func FieldPgType(kind core.FieldKind) (string, bool) {
	switch kind {
	case core.FieldInteger:
		return "int8", true
	case core.FieldDecimal:
		return "numeric", true
	case core.FieldString:
		return "text", true
	case core.FieldUUID:
		return "uuid", true
	case core.FieldBoolean:
		return "boolean", true
	case core.FieldTimestamp:
		return "timestamptz", true
	default:
		return "", false
	}
}

func KeyPgType(kind core.KeyKind) (string, bool) {
	switch kind {
	case core.KeyInteger:
		return "int8", true
	case core.KeyUUID:
		return "uuid", true
	case core.KeyString:
		return "text", true
	default:
		return "", false
	}
}

func NewRegistry(c *core.Core, declarations *core.ValidatedDeclarations, bindings StorageBindings) (*Registry, error) {
	if c == nil || !c.IsValidated(declarations) {
		return nil, errors.New("declarations must come from Validate of this authorization core")
	}
	resources := make(map[string]ResourceBinding, len(bindings.Resources))
	for _, binding := range bindings.Resources {
		resource, ok := declarations.Resource(binding.Resource)
		if !ok {
			return nil, fmt.Errorf("binding for undeclared resource %s", binding.Resource)
		}
		if _, exists := resources[binding.Resource]; exists {
			return nil, fmt.Errorf("resource %s bound twice", binding.Resource)
		}
		for _, name := range []string{binding.Table, binding.ObjectIDColumn, binding.KeyColumn} {
			if _, err := QuoteIdentifier(name); err != nil {
				return nil, err
			}
		}
		for field := range resource.Fields {
			if field == "key" {
				return nil, fmt.Errorf("field name \"key\" is reserved (%s)", binding.Resource)
			}
			col, hasCol := binding.Columns[field]
			if !hasCol {
				return nil, fmt.Errorf("field %s.%s has no column", binding.Resource, field)
			}
			if _, err := QuoteIdentifier(col); err != nil {
				return nil, err
			}
		}
		for field, col := range binding.Columns {
			if _, declared := resource.Fields[field]; !declared {
				return nil, fmt.Errorf("column mapping %s.%s is not declared", binding.Resource, field)
			}
			if _, err := QuoteIdentifier(col); err != nil {
				return nil, err
			}
		}
		for _, field := range binding.Projection {
			if _, declared := resource.Fields[field]; !declared {
				return nil, fmt.Errorf("projection field %s.%s is not declared", binding.Resource, field)
			}
		}
		resources[binding.Resource] = cloneResourceBinding(binding)
	}
	for _, declared := range declarations.Resources() {
		if _, ok := resources[declared.Key]; !ok {
			return nil, fmt.Errorf("resource %s has no storage binding", declared.Key)
		}
	}
	domains := make(map[string]DomainRelationBinding)
	usedDomains := make(map[string]bool, len(bindings.Domains))
	for _, relation := range declarations.Relations() {
		if relation.Binding.Kind != core.BindingDomain {
			continue
		}
		ref := core.RelationRef{Key: relation.Key, Version: relation.Version}.String()
		domain, ok := bindings.Domains[relation.Binding.Key]
		if !ok {
			return nil, fmt.Errorf("relation %s has no domain binding %s", ref, relation.Binding.Key)
		}
		if relation.Target.Kind != core.RelationTargetIdentity {
			return nil, fmt.Errorf("relation %s: domain bindings to resources are not supported", ref)
		}
		for _, name := range []string{domain.Table, domain.SourceColumn, domain.TargetColumn} {
			if _, err := QuoteIdentifier(name); err != nil {
				return nil, err
			}
		}
		if (domain.StartsColumn == "") != (domain.ExpiresColumn == "") {
			return nil, errors.New("domain relation validity requires both startsColumn and expiresColumn")
		}
		if domain.StartsColumn != "" {
			if _, err := QuoteIdentifier(domain.StartsColumn); err != nil {
				return nil, err
			}
			if _, err := QuoteIdentifier(domain.ExpiresColumn); err != nil {
				return nil, err
			}
		}
		usedDomains[relation.Binding.Key] = true
		domains[ref] = domain
	}
	for key := range bindings.Domains {
		if !usedDomains[key] {
			return nil, fmt.Errorf("unused domain binding %s", key)
		}
	}
	return &Registry{
		core:         c,
		declarations: declarations,
		resources:    resources,
		domains:      domains,
	}, nil
}

func cloneResourceBinding(b ResourceBinding) ResourceBinding {
	return ResourceBinding{
		Resource:       b.Resource,
		Table:          b.Table,
		ObjectIDColumn: b.ObjectIDColumn,
		KeyColumn:      b.KeyColumn,
		Columns:        maps.Clone(b.Columns),
		Projection:     slices.Clone(b.Projection),
	}
}

func (r *Registry) Core() *core.Core {
	if r == nil {
		return nil
	}
	return r.core
}

func (r *Registry) Declarations() *core.ValidatedDeclarations {
	if r == nil {
		return nil
	}
	return r.declarations
}

func (r *Registry) Resource(name string) (ResourceBinding, error) {
	if r == nil {
		return ResourceBinding{}, errors.New("nil storage binding registry")
	}
	binding, ok := r.resources[name]
	if !ok {
		return ResourceBinding{}, fmt.Errorf("resource %s has no storage binding", name)
	}
	return cloneResourceBinding(binding), nil
}

func (r *Registry) Domain(relationRef string) (DomainRelationBinding, bool) {
	if r == nil {
		return DomainRelationBinding{}, false
	}
	domain, ok := r.domains[relationRef]
	return domain, ok
}
