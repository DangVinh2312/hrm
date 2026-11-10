package role

import "context"

// HTTPPort is the bound role operations; the reads answer found=false for 404.
type HTTPPort interface {
	Matrix(ctx context.Context, secret string) (MatrixView, bool, error)
	AccountPermissions(ctx context.Context, secret, accountID string) (AccountPermissionView, bool, error)
	Create(ctx context.Context, secret string, input CreateInput) (WriteResult, error)
	Update(ctx context.Context, secret string, input UpdateInput) (WriteResult, error)
	Remove(ctx context.Context, secret, key string) (Removed, error)
}
