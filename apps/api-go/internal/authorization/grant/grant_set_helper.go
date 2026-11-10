// Package grant compares effective grant sets and checks the grants of runtime roles. A grant is the tuple
// (permission, template key, template version, parameters); two grants are the same only when the whole tuple
// is equal. Different tuples of one permission are incomparable and refused: no scope containment is decided.
package grant

import "hrm/api-go/internal/authorization/core"

type Source string

const (
	SourceRole Source = "role"
	SourceUser Source = "user"
)

// GrantRuleFact is one policy_rule row that applies to an account. Parameters is the RFC 8785 form of the
// rule's parameters, so equal values compare equal whatever jsonb printed.
type GrantRuleFact struct {
	Source     Source
	Effect     core.Effect
	Permission string
	Template   core.RelationRef
	Parameters string
}

type Verdict string

const (
	Within       Verdict = "within"
	Larger       Verdict = "larger"
	Incomparable Verdict = "incomparable"
	Unprovable   Verdict = "unprovable"
)

type grantKey struct {
	permission, template string
	version              int
	parameters           string
}

func keyOf(fact GrantRuleFact) grantKey {
	return grantKey{fact.Permission, fact.Template.Key, fact.Template.Version, fact.Parameters}
}

// provable: a deny lowers what an account can do and a user rule has no UI path, so a set holding either
// cannot be reduced to plain grants.
func provable(facts []GrantRuleFact) bool {
	for _, fact := range facts {
		if fact.Effect != core.EffectAllow || fact.Source != SourceRole {
			return false
		}
	}
	return true
}

func CompareGrantSets(target, actor []GrantRuleFact) Verdict {
	if !provable(target) || !provable(actor) {
		return Unprovable
	}
	grants := make(map[grantKey]bool, len(actor))
	permissions := make(map[string]bool, len(actor))
	for _, fact := range actor {
		grants[keyOf(fact)] = true
		permissions[fact.Permission] = true
	}
	verdict := Within
	for _, fact := range target {
		if grants[keyOf(fact)] {
			continue
		}
		if !permissions[fact.Permission] {
			return Larger
		}
		verdict = Incomparable
	}
	return verdict
}

// ProvenWithin proves target inside actor; a truncated read is incomplete, so it never proves anything.
func ProvenWithin(target, actor []GrantRuleFact, truncated bool) bool {
	return !truncated && CompareGrantSets(target, actor) == Within
}
