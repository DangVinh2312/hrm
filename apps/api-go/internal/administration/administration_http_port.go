package administration

import "context"

// HTTPPort is the bound account operations; each rechecks session, policy and boundary in its transaction.
type HTTPPort interface {
	List(ctx context.Context, secret string, limit, offset int) (AccountPage, error)
	Provision(ctx context.Context, secret string, input ProvisionInput) (ProvisionedAccount, error)
	Suspend(ctx context.Context, secret, userID string) error
	Reactivate(ctx context.Context, secret, userID string) error
	AssignRole(ctx context.Context, secret, userID, roleKey string) error
	RevokeRole(ctx context.Context, secret, userID, roleKey string) error
}
