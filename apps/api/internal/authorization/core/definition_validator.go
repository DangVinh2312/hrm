package core

import (
	"maps"
	"slices"
	"strconv"
	"strings"
)

func validLifecycle(lifecycle Lifecycle) bool {
	return lifecycle == "" || lifecycle == LifecycleActive || lifecycle == LifecycleDeprecated || lifecycle == LifecycleRetired
}

func (c *declarationChecker) checkPolicies() {
	c.policies = make(map[string]PermissionPolicy, len(c.source.Policies))
	for _, policy := range c.source.Policies {
		ref := RelationRef{Key: policy.Key, Version: policy.Version}.String()
		at := "policy " + ref
		if _, twice := c.policies[ref]; twice {
			c.report("policy " + ref + " is declared twice")
		}
		c.policies[ref] = policy
		if !dottedKeyPattern.MatchString(policy.Key) || policy.Version < 1 {
			c.report(at + ": invalid key/version")
		}
		if !validLifecycle(policy.Lifecycle) {
			c.report(at + ": invalid lifecycle")
		}
		budget := c.limits.MaxExpressionNodes
		if !wellFormed(policy.RequiredScope, &budget) {
			c.report(at + ": requiredScope is not a well-formed expression")
		}
		if policy.ContextRequirements == nil || policy.Obligations == nil {
			c.report(at + ": contextRequirements and obligations must be lists")
			continue
		}
		c.checkContextRequirements(policy.ContextRequirements, at)
		for _, obligation := range policy.Obligations {
			if !c.handlers[obligation.Handler] {
				c.report(at + ": obligation handler " + obligation.Handler + " is not registered")
			}
		}
	}
}

// checkActions requires every action to bind an existing, non-retired policy whose required scope type-checks.
func (c *declarationChecker) checkActions() {
	for _, resource := range c.source.Resources {
		for _, action := range slices.Sorted(maps.Keys(resource.Actions)) {
			ref := resource.Actions[action].Policy.String()
			at := resource.Key + "." + action
			policy, declared := c.policies[ref]
			if !declared {
				c.report(at + ": policy " + ref + " is not declared")
				continue
			}
			if policy.Lifecycle == LifecycleRetired {
				c.report(at + ": policy " + ref + " is retired")
			}
			c.checkExpr(policy.RequiredScope, exprScope{typeName: resource.Key, fields: resource.Fields}, at+" requiredScope")
		}
	}
}

func (c *declarationChecker) checkTemplates() {
	c.templates = make(map[string]ScopeTemplate, len(c.source.Templates))
	for _, template := range c.source.Templates {
		ref := RelationRef{Key: template.Key, Version: template.Version}.String()
		at := "template " + ref
		if _, twice := c.templates[ref]; twice {
			c.report("template " + ref + " is declared twice")
		}
		c.templates[ref] = template
		if !dottedKeyPattern.MatchString(template.Key) || template.Version < 1 {
			c.report(at + ": invalid key/version")
			continue
		}
		resource, declared := c.tables.resources[template.Resource]
		if !declared {
			c.report(at + ": resource " + template.Resource + " is not declared")
			continue
		}
		if template.Parameters == nil {
			c.report(at + ": parameters must map names to field kinds")
			continue
		}
		valid := true
		for name, kind := range template.Parameters {
			valid = valid && identifierPattern.MatchString(name) && slices.Contains(fieldKinds, kind)
		}
		if !valid {
			c.report(at + ": parameters must map names to field kinds")
			continue
		}
		c.checkExpr(template.Expression, exprScope{typeName: resource.Key, fields: resource.Fields, parameters: template.Parameters}, at)
	}
}

func (c *declarationChecker) checkBoundaries() {
	c.boundaries = make(map[string]PermissionBoundary, len(c.source.Boundaries))
	for _, boundary := range c.source.Boundaries {
		ref := RelationRef{Key: boundary.Key, Version: boundary.Version}.String()
		at := "boundary " + ref
		if _, twice := c.boundaries[ref]; twice {
			c.report("boundary " + ref + " is declared twice")
		}
		c.boundaries[ref] = boundary
		if !dottedKeyPattern.MatchString(boundary.Key) || boundary.Version < 1 {
			c.report(at + ": invalid key/version")
			continue
		}
		if !validLifecycle(boundary.Lifecycle) {
			c.report(at + ": invalid lifecycle")
		}
		if len(boundary.Entries) == 0 {
			c.report(at + ": entries must be a non-empty list")
			continue
		}
		seen := map[string]bool{}
		for i, entry := range boundary.Entries {
			entryAt := at + " entries[" + strconv.Itoa(i) + "]"
			if seen[entry.Permission] {
				c.report(entryAt + ": " + entry.Permission + " appears twice")
			}
			seen[entry.Permission] = true
			resourceKey, action, _ := strings.Cut(entry.Permission, ".")
			resource, declared := c.tables.resources[resourceKey]
			if _, hasAction := resource.Actions[action]; !declared || !hasAction {
				c.report(entryAt + ": permission " + entry.Permission + " is not declared")
				continue
			}
			c.checkContextRequirements(entry.ContextRequirements, entryAt)
			c.checkExpr(entry.RequiredScope, exprScope{typeName: resource.Key, fields: resource.Fields}, entryAt+" requiredScope")
		}
	}
}
