package leave

import (
	"context"

	"hrm/api-go/internal/modules/leavecore"
)

// HTTPPort is the bound leave operations; the balance answers found=false for 404.
type HTTPPort interface {
	Balance(ctx context.Context, secret string, query BalanceQuery) (leavecore.BalanceView, bool, error)
	Reconciliation(ctx context.Context, secret string, query ReconciliationQuery) (ReconciliationView, error)
	Adjust(ctx context.Context, secret string, input AdjustmentInput) (AdjustmentResult, error)
}
