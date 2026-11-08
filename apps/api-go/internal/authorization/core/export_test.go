package core

// IssueForTest issues a plan with a predicate no Plan call builds, for the evaluator's own checks.
func (c *Core) IssueForTest(resource string, predicate PlanExpr, validUntil string) *AuthorizedPlan {
	return c.issue(resource, "read", resource+".read", "1", IdentityID("a0000000-0000-4000-8000-000000000001"), validUntil, predicate, []Obligation{})
}
