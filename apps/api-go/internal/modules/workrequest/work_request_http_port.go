package workrequest

import "context"

// HTTPPort is the bound work request operations; the detail answers found=false for 404.
type HTTPPort interface {
	Submit(ctx context.Context, secret string, input SubmitInput) (SubmitResult, error)
	List(ctx context.Context, secret string, query ListQuery) (ListView, error)
	Detail(ctx context.Context, secret, requestID string) (DetailView, bool, error)
}
