package core

import (
	"maps"
	"regexp"
	"slices"
	"strconv"
	"unicode/utf8"
)

const (
	defaultExpressionNodes = 256
	ceilingExpressionNodes = 10_000
	defaultRules           = 512
	ceilingRules           = 100_000
)

var (
	identifierPattern  = regexp.MustCompile(`^[a-z][A-Za-z0-9_]*$`)
	dottedKeyPattern   = regexp.MustCompile(`^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)*$`)
	handlerNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]*@[1-9][0-9]*$`)
)

// declarationChecker collects every problem in one pass. fault is a codec failure, which is reported as
// one fixed message so that no declared value is echoed. Free text that reaches the canonical form must be
// valid UTF-8: encoding/json writes U+FFFD for anything else, so two different declarations would hash alike.
type declarationChecker struct {
	core       *Core
	source     SystemDeclarations
	errors     []string
	fault      error
	limits     EffectiveLimits
	validators map[string]bool
	handlers   map[string]bool
	tables     declarationTables
	policies   map[string]PermissionPolicy
	templates  map[string]ScopeTemplate
	boundaries map[string]PermissionBoundary
}

func (c *declarationChecker) report(problem string) { c.errors = append(c.errors, problem) }

func validateDeclarations(core *Core, source SystemDeclarations) (*ValidatedDeclarations, error) {
	c := &declarationChecker{core: core, source: source}
	c.checkLists()
	if len(c.errors) > 0 {
		return nil, &DeclarationsError{Errors: c.errors}
	}
	c.limits = EffectiveLimits{
		MaxPathDepth:       c.limitOf(source.Limits.MaxPathDepth, MaxPathDepth, MaxPathDepth, "maxPathDepth"),
		MaxExpressionNodes: c.limitOf(source.Limits.MaxExpressionNodes, defaultExpressionNodes, ceilingExpressionNodes, "maxExpressionNodes"),
		MaxRules:           c.limitOf(source.Limits.MaxRules, defaultRules, ceilingRules, "maxRules"),
	}
	c.validators = namesOf(source.Capabilities.Validators)
	c.handlers = namesOf(source.Capabilities.ObligationHandlers)
	c.checkResources()
	c.checkRelations()
	c.checkPolicies()
	c.checkActions()
	c.checkTemplates()
	c.checkBoundaries()
	if c.fault != nil {
		return nil, codecFailure()
	}
	if len(c.errors) > 0 {
		return nil, &DeclarationsError{Errors: c.errors}
	}
	return c.build()
}

func namesOf(items []string) map[string]bool {
	names := make(map[string]bool, len(items))
	for _, item := range items {
		names[item] = true
	}
	return names
}

func (c *declarationChecker) checkLists() {
	if c.source.Resources == nil {
		c.report("resources must be a list")
	}
	if c.source.Relations == nil {
		c.report("relations must be a list")
	}
	if c.source.Policies == nil {
		c.report("policies must be a list")
	}
	if c.source.Templates == nil {
		c.report("templates must be a list")
	}
	if c.source.Boundaries == nil {
		c.report("boundaries must be a list")
	}
	capabilities := c.source.Capabilities
	named := func(name string) bool { return handlerNamePattern.MatchString(name) }
	if capabilities.Validators == nil || capabilities.ObligationHandlers == nil ||
		!allOf(capabilities.Validators, named) || !allOf(capabilities.ObligationHandlers, named) {
		c.report("capabilities must list validator and obligation handler names as name@version")
	}
}

func allOf[T any](items []T, holds func(T) bool) bool {
	return !slices.ContainsFunc(items, func(item T) bool { return !holds(item) })
}

func (c *declarationChecker) limitOf(value *int, fallback, ceiling int, name string) int {
	if value == nil {
		return fallback
	}
	if *value < 1 || *value > ceiling {
		c.report("limits." + name + " must be an integer between 1 and " + strconv.Itoa(ceiling))
		return fallback
	}
	return *value
}

func (c *declarationChecker) checkContextRequirements(requirements []ContextRequirement, at string) {
	if requirements == nil {
		c.report(at + ": contextRequirements must be a list")
		return
	}
	for _, requirement := range requirements {
		if !c.validators[requirement.Validator] {
			c.report(at + ": context validator " + requirement.Validator + " is not registered")
			continue
		}
		if requirement.Parameters == nil {
			c.report(at + ": validator parameters must be strings or booleans")
			continue
		}
		for name, parameter := range requirement.Parameters {
			text, isText := parameter.AsText()
			if parameter == (Scalar{}) || !utf8.ValidString(name) || (isText && !utf8.ValidString(text)) {
				c.report(at + ": validator parameters must be strings or booleans in valid UTF-8")
				break
			}
		}
	}
}

func (c *declarationChecker) checkResources() {
	resources := make(map[string]ResourceDeclaration, len(c.source.Resources))
	for i, resource := range c.source.Resources {
		at := "resources[" + strconv.Itoa(i) + "]"
		if !identifierPattern.MatchString(resource.Key) {
			c.report(at + ": key must be an identifier")
			continue
		}
		if _, twice := resources[resource.Key]; twice {
			c.report(at + ": resource " + resource.Key + " is declared twice")
		}
		resources[resource.Key] = resource
		if resource.KeyKind != KeyInteger && resource.KeyKind != KeyUUID && resource.KeyKind != KeyString {
			c.report(at + ": unknown key kind")
		}
		if resource.Fields == nil {
			c.report(at + ": fields must be declared")
		}
		for _, name := range slices.Sorted(maps.Keys(resource.Fields)) {
			if !identifierPattern.MatchString(name) || !slices.Contains(fieldKinds, resource.Fields[name].Kind) {
				c.report(at + ": invalid field " + name)
			}
		}
		if resource.Actions == nil {
			c.report(at + ": actions must be declared")
		}
		for _, name := range slices.Sorted(maps.Keys(resource.Actions)) {
			action := resource.Actions[name]
			if !identifierPattern.MatchString(name) || action.Policy.Key == "" || action.Policy.Version < 1 {
				c.report(at + ": action " + name + " needs an explicit policy key@version")
			}
			if action.Boundary != BoundaryRequired && action.Boundary != BoundaryOptional {
				c.report(at + ": action " + name + " needs an explicit boundary requirement (required|optional)")
			}
		}
	}
	c.tables.resources = resources
}

func (c *declarationChecker) checkRelations() {
	relations := make(map[string]RelationDeclaration, len(c.source.Relations))
	for i, relation := range c.source.Relations {
		at := "relations[" + strconv.Itoa(i) + "]"
		ref := RelationRef{Key: relation.Key, Version: relation.Version}.String()
		if _, twice := relations[ref]; twice {
			c.report("relation " + ref + " is declared twice")
		}
		relations[ref] = relation
		if !dottedKeyPattern.MatchString(relation.Key) || relation.Version < 1 {
			c.report(at + ": relation needs key and positive version")
			continue
		}
		if _, declared := c.tables.resources[relation.SourceType]; !declared {
			c.report(at + ": source type " + relation.SourceType + " is not declared")
		}
		target := relation.Target
		if _, _, declared := relationTarget(relation, c.tables); !declared || (target.Kind == RelationTargetIdentity && target.Type != "") {
			c.report(at + ": target must be identity (without a type) or a declared resource")
		}
		binding := relation.Binding
		edgeStore := binding.Kind == BindingEdgeStore && binding.Key == ""
		domain := binding.Kind == BindingDomain && binding.Key != "" && utf8.ValidString(binding.Key)
		if !edgeStore && !domain {
			c.report(at + ": binding must be edgeStore (without a key) or a named domain binding, in valid UTF-8")
		}
	}
	c.tables.relations = relations
}
