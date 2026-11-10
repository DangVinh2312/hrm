package attendance

import "context"

// HTTPPort is the bound attendance operations; the reads answer found=false for 404.
type HTTPPort interface {
	Sheet(ctx context.Context, secret string, query SheetQuery) (SheetView, bool, error)
	PeriodState(ctx context.Context, secret, month string) (PeriodHistory, bool, error)
	Adjustments(ctx context.Context, secret string, query AdjustmentQuery) (AdjustmentList, bool, error)
	ClosePeriod(ctx context.Context, secret, month string) (PeriodResult, error)
	ReopenPeriod(ctx context.Context, secret string, input ReopenInput) (PeriodResult, error)
	Adjust(ctx context.Context, secret string, input AdjustmentInput) (AdjustmentResult, error)
}
