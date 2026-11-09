package workrequest

import "context"

// HTTPPort is the bound work request operations; the detail and the decision answer found=false for 404.
type HTTPPort interface {
	Submit(ctx context.Context, secret string, input SubmitInput) (SubmitResult, error)
	List(ctx context.Context, secret string, query ListQuery) (ListView, error)
	Detail(ctx context.Context, secret, requestID string) (DetailView, bool, error)
	Decide(ctx context.Context, secret string, input DecisionInput) (SubmitResult, bool, error)
	Cancel(ctx context.Context, secret string, input CancelInput) (SubmitResult, bool, error)
	LeadQueue(ctx context.Context, secret string, query ListQuery) (ApprovalView, error)
	FinalQueue(ctx context.Context, secret string, query ListQuery) (ApprovalView, error)
	Decided(ctx context.Context, secret string, query ListQuery) (DecidedView, error)
}
