package core

import "slices"

// AuthorizedPlan comes from Core.Plan or Core.PlanUnrestricted only. It is immutable: fields are private
// and every accessor returns a copy. Provenance lives in issuer and self, so the zero value and a
// structural copy both read as a plan no core issued.
type AuthorizedPlan struct {
	issuer      *Core
	self        *AuthorizedPlan
	userID      IdentityID
	resource    string
	action      string
	permission  string
	revision    string
	predicate   PlanExpr
	validUntil  string
	obligations []Obligation
}

func (p *AuthorizedPlan) UserID() IdentityID { return p.userID }

func (p *AuthorizedPlan) Resource() string { return p.resource }

func (p *AuthorizedPlan) Action() string { return p.action }

func (p *AuthorizedPlan) Permission() string { return p.permission }

func (p *AuthorizedPlan) Revision() string { return p.revision }

func (p *AuthorizedPlan) ValidUntil() string { return p.validUntil }

func (p *AuthorizedPlan) Predicate() PlanExpr { return clonePlanExpr(p.predicate) }

func (p *AuthorizedPlan) Obligations() []Obligation { return slices.Clone(p.obligations) }

// Decision is allowed only when it carries a plan, so the zero value denies.
type Decision struct {
	reason string
	plan   *AuthorizedPlan
}

func (d Decision) Allowed() bool { return d.plan != nil }

// Reason is for internal logs and audit; it never reaches a client.
func (d Decision) Reason() string { return d.reason }

func (d Decision) Plan() *AuthorizedPlan { return d.plan }

func (d Decision) Obligations() []Obligation {
	if d.plan == nil {
		return nil
	}
	return d.plan.Obligations()
}
