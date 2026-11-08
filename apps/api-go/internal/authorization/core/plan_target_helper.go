package core

import (
	"errors"
	"maps"
	"slices"
)

const reasonInternalError = "internal_error"

// denial is a decision to refuse with a reason for internal logs.
type denial struct{ reason string }

func (d *denial) Error() string { return d.reason }

func deny(reason string) error { return &denial{reason: reason} }

// configurationError is a declaration that passed validation and still cannot be lowered.
type configurationError struct{ message string }

func (e *configurationError) Error() string { return e.message }

func deniedBy(err error) Decision {
	var refused *denial
	if errors.As(err, &refused) {
		return Decision{reason: refused.reason}
	}
	var configuration *configurationError
	if errors.As(err, &configuration) {
		return Decision{reason: "configuration: " + configuration.message}
	}
	return Decision{reason: reasonInternalError}
}

func (c *Core) timestampOr(input, reason string) (string, error) {
	value, err := c.CanonicalTimestamp(input)
	if errors.Is(err, ErrInvalidValue) {
		return "", deny(reason)
	}
	return value, err
}

type resolvedTarget struct {
	declarations  *ValidatedDeclarations
	principal     TrustedPrincipal
	validUntil    string
	resource      ResourceDeclaration
	action        ActionDeclaration
	permissionKey string
	permission    PermissionFact
}

// resolveTarget holds the checks every plan shares: provenance, principal, active user, validity window,
// declared resource and action, and the catalog row.
func (c *Core) resolveTarget(input TrustedInput, snapshot AuthoritySnapshot) (resolvedTarget, error) {
	declarations := snapshot.Declarations
	if !c.IsValidated(declarations) {
		return resolvedTarget{}, deny("unvalidated_declarations")
	}
	principal := input.Principal
	if !c.IsCanonicalUUID(string(principal.ID)) {
		return resolvedTarget{}, deny("invalid_principal")
	}
	if snapshot.User == nil || snapshot.User.ID != principal.ID || snapshot.User.State != UserActive {
		return resolvedTarget{}, deny("inactive_user")
	}
	now, err := c.timestampOr(input.Now, "invalid_now")
	if err != nil {
		return resolvedTarget{}, err
	}
	validUntil, err := c.timestampOr(input.ValidUntil, "invalid_valid_until")
	if err != nil {
		return resolvedTarget{}, err
	}
	order, err := c.CompareValues(FieldTimestamp, Text(validUntil), Text(now))
	if err != nil {
		return resolvedTarget{}, err
	}
	if order != Greater {
		return resolvedTarget{}, deny("invalid_validity_window")
	}
	resource, known := declarations.resources[input.Resource]
	if !known {
		return resolvedTarget{}, deny("unknown_resource")
	}
	action, known := resource.Actions[input.Action]
	if !known {
		return resolvedTarget{}, deny("unknown_action")
	}
	permissionKey := resource.Key + "." + input.Action
	index := slices.IndexFunc(snapshot.Permissions, func(p PermissionFact) bool { return p.Key == permissionKey })
	if index < 0 {
		return resolvedTarget{}, deny("permission_not_in_catalog")
	}
	permission := snapshot.Permissions[index]
	if permission.Resource != resource.Key || permission.Action != input.Action || !usable(permission.Lifecycle) {
		return resolvedTarget{}, deny("permission_unavailable")
	}
	return resolvedTarget{
		declarations: declarations, principal: principal, validUntil: validUntil, resource: resource,
		action: action, permissionKey: permissionKey, permission: permission,
	}, nil
}

// usable also refuses an empty or unknown lifecycle, so a row that was never synced does not pass.
func usable(lifecycle Lifecycle) bool {
	return lifecycle == LifecycleActive || lifecycle == LifecycleDeprecated
}

func resolvePolicy(target resolvedTarget) (PermissionPolicy, error) {
	if target.permission.Policy != target.action.Policy {
		return PermissionPolicy{}, deny("policy_binding_mismatch")
	}
	policy, known := target.declarations.policies[target.action.Policy.String()]
	if !known {
		return PermissionPolicy{}, deny("policy_missing")
	}
	if policy.Lifecycle == LifecycleRetired {
		return PermissionPolicy{}, deny("policy_retired")
	}
	return policy, nil
}

func callValidator(validator ContextValidator, parameters map[string]Scalar, input ValidatorInput) (result ValidatorResult, failed bool) {
	defer func() {
		if recover() != nil {
			failed = true
		}
	}()
	return validator(parameters, input), false
}

// requireContext passes only on ValidatorTrue. Validators get copies: a validator cannot change the
// declarations other plans read, nor the context of the next requirement.
func requireContext(snapshot AuthoritySnapshot, principal TrustedPrincipal, context map[string]Scalar, requirements []ContextRequirement) error {
	for _, requirement := range requirements {
		validator := snapshot.Registry.Validators[requirement.Validator]
		if validator == nil {
			return deny("validator_unavailable")
		}
		input := ValidatorInput{Principal: principal, Context: maps.Clone(context)}
		result, failed := callValidator(validator, maps.Clone(requirement.Parameters), input)
		if failed {
			return deny("validator_failed")
		}
		if result != ValidatorTrue {
			return deny("context_requirement_failed")
		}
	}
	return nil
}

// resolveBoundary returns the entry that binds this user on this permission. The stored requirement must
// equal the code's, and a bound definition, its exact version and entry must all exist. A nil entry means
// optional and unbound.
func resolveBoundary(target resolvedTarget, snapshot AuthoritySnapshot, context map[string]Scalar) (*BoundaryEntry, error) {
	if target.permission.Boundary != target.action.Boundary {
		return nil, deny("boundary_requirement_mismatch")
	}
	var bindings []BoundaryBindingFact
	for _, binding := range snapshot.Boundaries {
		if binding.Identity == target.principal.ID && binding.Permission == target.permissionKey {
			bindings = append(bindings, binding)
		}
	}
	if len(bindings) > 1 {
		return nil, deny("ambiguous_boundary_binding")
	}
	if len(bindings) == 0 {
		if target.action.Boundary != BoundaryOptional {
			return nil, deny("boundary_binding_missing")
		}
		return nil, nil
	}
	boundary, known := target.declarations.boundaries[bindings[0].Boundary.String()]
	if !known {
		return nil, deny("boundary_definition_missing")
	}
	if !usable(bindings[0].Lifecycle) || boundary.Lifecycle == LifecycleRetired {
		return nil, deny("boundary_unavailable")
	}
	index := slices.IndexFunc(boundary.Entries, func(e BoundaryEntry) bool { return e.Permission == target.permissionKey })
	if index < 0 {
		return nil, deny("boundary_entry_missing")
	}
	entry := boundary.Entries[index]
	if err := requireContext(snapshot, target.principal, context, entry.ContextRequirements); err != nil {
		return nil, err
	}
	return &entry, nil
}
