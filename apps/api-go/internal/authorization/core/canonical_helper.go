package core

import (
	"cmp"
	"encoding/json"
	"maps"
	"slices"
)

// canonicalManifest fixes the order of the hashed form: lists are sorted here, map keys by encoding/json.
type canonicalManifest struct {
	Resources    []ResourceDeclaration `json:"resources"`
	Relations    []RelationDeclaration `json:"relations"`
	Policies     []PermissionPolicy    `json:"policies"`
	Templates    []ScopeTemplate       `json:"templates"`
	Boundaries   []PermissionBoundary  `json:"boundaries"`
	Capabilities Capabilities          `json:"capabilities"`
	Limits       EffectiveLimits       `json:"limits"`
}

// sortRequirements orders requirements by their JSON form, the only order that needs no extra key.
func sortRequirements(requirements []ContextRequirement) error {
	forms := make(map[string]ContextRequirement, len(requirements))
	order := make([]string, 0, len(requirements))
	for _, requirement := range requirements {
		form, err := json.Marshal(requirement)
		if err != nil {
			return err
		}
		forms[string(form)] = requirement
		order = append(order, string(form))
	}
	slices.Sort(order)
	for i, form := range order {
		requirements[i] = forms[form]
	}
	return nil
}

func mergedObligations(obligations []Obligation) []Obligation {
	handlers := make([]string, len(obligations))
	for i, obligation := range obligations {
		handlers[i] = obligation.Handler
	}
	merged := []Obligation{}
	for _, handler := range uniqueSorted(handlers) {
		merged = append(merged, Obligation{Handler: handler})
	}
	return merged
}

func (c *declarationChecker) normalizedPolicies() (map[string]PermissionPolicy, error) {
	policies := make(map[string]PermissionPolicy, len(c.policies))
	for ref, source := range c.policies {
		policy := clonePolicy(source)
		if err := sortRequirements(policy.ContextRequirements); err != nil {
			return nil, err
		}
		policy.Obligations = mergedObligations(policy.Obligations)
		policies[ref] = policy
	}
	return policies, nil
}

func (c *declarationChecker) normalizedBoundaries() (map[string]PermissionBoundary, error) {
	boundaries := make(map[string]PermissionBoundary, len(c.boundaries))
	for ref, source := range c.boundaries {
		boundary := cloneBoundary(source)
		for i := range boundary.Entries {
			if err := sortRequirements(boundary.Entries[i].ContextRequirements); err != nil {
				return nil, err
			}
		}
		slices.SortFunc(boundary.Entries, func(a, b BoundaryEntry) int { return cmp.Compare(a.Permission, b.Permission) })
		boundaries[ref] = boundary
	}
	return boundaries, nil
}

// build runs only after every check passed, so the copies below walk finite, known expressions.
func (c *declarationChecker) build() (*ValidatedDeclarations, error) {
	policies, err := c.normalizedPolicies()
	if err != nil {
		return nil, err
	}
	boundaries, err := c.normalizedBoundaries()
	if err != nil {
		return nil, err
	}
	resources := make(map[string]ResourceDeclaration, len(c.tables.resources))
	for key, resource := range c.tables.resources {
		resources[key] = cloneResource(resource)
	}
	templates := make(map[string]ScopeTemplate, len(c.templates))
	for ref, template := range c.templates {
		templates[ref] = cloneTemplate(template)
	}
	relations := maps.Clone(c.tables.relations)
	capabilities := Capabilities{
		Validators:         uniqueSorted(c.source.Capabilities.Validators),
		ObligationHandlers: uniqueSorted(c.source.Capabilities.ObligationHandlers),
	}
	canonical, err := json.Marshal(canonicalManifest{
		Resources:    listSorted(resources, same[ResourceDeclaration]),
		Relations:    listSorted(relations, same[RelationDeclaration]),
		Policies:     listSorted(policies, same[PermissionPolicy]),
		Templates:    listSorted(templates, same[ScopeTemplate]),
		Boundaries:   listSorted(boundaries, same[PermissionBoundary]),
		Capabilities: capabilities,
		Limits:       c.limits,
	})
	if err != nil {
		return nil, err
	}
	validated := &ValidatedDeclarations{
		owner: c.core, resources: resources, relations: relations, policies: policies, templates: templates,
		boundaries: boundaries, capabilities: capabilities, limits: c.limits, canonical: string(canonical),
	}
	validated.self = validated
	return validated, nil
}
