package role

import (
	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/grant"
	"hrm/api/internal/authorization/keys"
)

// commands run in admin mode on the role anchor, which Execute locks FOR NO KEY UPDATE after the fence, the
// session and the plan, so every role write is serialized. Then: the role row (update, delete), the actor's grant
// facts, the checks, the writes and the audit. A command checks the catalog again rather than trust its caller.
type commands struct {
	core         *core.Core
	declarations *core.ValidatedDeclarations
}

// within: Root is outside the grant sets; an IAM actor must hold everything it writes or touches, and an
// incomplete read of its own grants proves nothing.
func (m commands) within(c authority.CommandContext, target []grant.GrantRuleFact) (bool, error) {
	if c.Actor.Kind == "root" {
		return true, nil
	}
	facts, truncated, err := grant.Read(c.Tx, m.core, []string{c.Actor.ID}, grant.MaxFactRows)
	if err != nil {
		return false, err
	}
	return grant.ProvenWithin(target, facts[c.Actor.ID], truncated), nil
}

func factsOf(rules []storedRule) []grant.GrantRuleFact {
	facts := make([]grant.GrantRuleFact, len(rules))
	for i, rule := range rules {
		facts[i] = grant.GrantRuleFact{Source: grant.SourceRole, Effect: core.Effect(rule.Effect), Permission: rule.Permission, Template: core.RelationRef{Key: rule.Template, Version: rule.Version}, Parameters: rule.Parameters}
	}
	return facts
}

func rulePairs(rules []storedRule) []GrantPair {
	pairs := make([]GrantPair, len(rules))
	for i, rule := range rules {
		pairs[i] = GrantPair{Permission: rule.Permission, Template: TemplateRef{Key: rule.Template, Version: rule.Version}}
	}
	return pairs
}

type current struct {
	rules  []storedRule
	digest string
}

// current is the stored rules of a role the actor reaches; a role this API could not have written is refused:
// above the grant limit it is not found for IAM and a conflict for Root, outside the actor's set it is not found.
func (m commands) current(c authority.CommandContext, key, label string) (current, error) {
	stored, truncated, err := rules(c.Tx, key)
	if err != nil {
		return current{}, err
	}
	if truncated {
		if c.Actor.Kind == "iam" {
			return current{}, apperror.ErrNotFound
		}
		return current{}, apperror.ErrCommandRejected
	}
	ok, err := m.within(c, factsOf(stored))
	if err != nil {
		return current{}, err
	}
	if !ok {
		return current{}, apperror.ErrNotFound
	}
	digest, err := grant.GrantsDigest(label, specs(rulePairs(stored)))
	return current{rules: stored, digest: digest}, err
}

func (m commands) audit(c authority.CommandContext, kind audit.Kind, key string, count int, digest string) error {
	return c.Audit(kind, authority.AuditTarget{Resource: string(keys.RoleResourceRole), Key: c.Target.Key, ObjectID: c.Target.ObjectID}, &authority.PermissionAuditDetail{RoleKey: key, GrantCount: &count, GrantsDigest: digest})
}

func (m commands) create(c authority.CommandContext, input CreateInput) (WriteResult, error) {
	if !grant.IsRuntimeRoleKey(input.Key) {
		return WriteResult{}, apperror.ErrInvalidRequest
	}
	if err := checkCatalog(m.declarations, input.Label, input.Grants); err != nil {
		return WriteResult{}, err
	}
	ok, err := m.within(c, grant.GrantsAsFacts(specs(input.Grants)))
	if err != nil {
		return WriteResult{}, err
	}
	if !ok {
		return WriteResult{}, apperror.ErrAccessDenied
	}
	count, err := runtimeRoleCount(c.Tx)
	if err != nil {
		return WriteResult{}, err
	}
	if count >= grant.MaxRuntimeRoles {
		return WriteResult{}, apperror.ErrCommandRejected
	}
	inserted, err := insertRole(c.Tx, input.Key, input.Label)
	if err != nil {
		return WriteResult{}, err
	}
	if !inserted {
		return WriteResult{}, apperror.ErrCommandRejected
	}
	if err := insertRules(c.Tx, input.Key, input.Grants); err != nil {
		return WriteResult{}, err
	}
	digest, err := grant.GrantsDigest(input.Label, specs(input.Grants))
	if err != nil {
		return WriteResult{}, err
	}
	if err := m.audit(c, audit.KindPermissionRoleCreate, input.Key, len(input.Grants), digest); err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Key: input.Key, Digest: digest}, nil
}

func (m commands) update(c authority.CommandContext, input UpdateInput) (WriteResult, error) {
	if err := checkCatalog(m.declarations, input.Label, input.Grants); err != nil {
		return WriteResult{}, err
	}
	label, found, err := lockRole(c.Tx, input.Key)
	if err != nil {
		return WriteResult{}, err
	}
	if !found {
		return WriteResult{}, apperror.ErrNotFound
	}
	now, err := m.current(c, input.Key, label)
	if err != nil {
		return WriteResult{}, err
	}
	ok, err := m.within(c, grant.GrantsAsFacts(specs(input.Grants)))
	if err != nil {
		return WriteResult{}, err
	}
	if !ok {
		return WriteResult{}, apperror.ErrAccessDenied
	}
	// A deny or a parameterised rule is not something this API writes: it is refused, not dropped silently.
	for _, rule := range now.rules {
		if rule.Effect != effectAllow || rule.Parameters != "{}" {
			return WriteResult{}, apperror.ErrCommandRejected
		}
	}
	if now.digest != input.ExpectedDigest {
		return WriteResult{}, apperror.ErrCommandRejected
	}
	wanted := make(map[GrantPair]bool, len(input.Grants))
	for _, pair := range input.Grants {
		wanted[pair] = true
	}
	kept := make(map[GrantPair]bool, len(now.rules))
	var dropped []string
	for i, pair := range rulePairs(now.rules) {
		kept[pair] = true
		if !wanted[pair] {
			dropped = append(dropped, now.rules[i].RuleID)
		}
	}
	var added []GrantPair
	for _, pair := range input.Grants {
		if !kept[pair] {
			added = append(added, pair)
		}
	}
	if err := deleteRules(c.Tx, dropped); err != nil {
		return WriteResult{}, err
	}
	if err := insertRules(c.Tx, input.Key, added); err != nil {
		return WriteResult{}, err
	}
	if label != input.Label {
		if err := setLabel(c.Tx, input.Key, input.Label); err != nil {
			return WriteResult{}, err
		}
	}
	digest, err := grant.GrantsDigest(input.Label, specs(input.Grants))
	if err != nil {
		return WriteResult{}, err
	}
	if err := m.audit(c, audit.KindPermissionRoleUpdate, input.Key, len(input.Grants), digest); err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Key: input.Key, Digest: digest}, nil
}

func (m commands) remove(c authority.CommandContext, key string) (Removed, error) {
	label, found, err := lockRole(c.Tx, key)
	if err != nil {
		return Removed{}, err
	}
	if !found {
		return Removed{}, apperror.ErrNotFound
	}
	now, err := m.current(c, key, label)
	if err != nil {
		return Removed{}, err
	}
	refs, err := referencesOf(c.Tx, key)
	if err != nil {
		return Removed{}, err
	}
	if refs.Held || refs.Exception {
		return Removed{}, apperror.ErrCommandRejected
	}
	if err := deleteRole(c.Tx, key); err != nil {
		return Removed{}, err
	}
	if err := m.audit(c, audit.KindPermissionRoleDelete, key, len(now.rules), now.digest); err != nil {
		return Removed{}, err
	}
	return Removed{Status: "deleted"}, nil
}
