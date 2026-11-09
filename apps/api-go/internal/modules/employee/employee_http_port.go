package employee

import "context"

type HTTPPort interface {
	List(context.Context, string, ListQuery) (ListView, error)
	Detail(context.Context, string, string) (View, error)
	Identity(context.Context, string, string) (IdentityView, error)
	LeaveRates(context.Context, string, string) (LeaveRateListView, error)
	Profile(context.Context, string) (SelfView, error)
}
