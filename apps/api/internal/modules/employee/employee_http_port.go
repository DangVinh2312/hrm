package employee

import "context"

type HTTPPort interface {
	List(context.Context, string, ListQuery) (ListView, error)
	Detail(context.Context, string, string) (View, error)
	Identity(context.Context, string, string) (IdentityView, error)
	LeaveRates(context.Context, string, string) (LeaveRateListView, error)
	Profile(context.Context, string) (SelfView, error)
	Create(context.Context, string, CreateInput) (Created, error)
	Update(context.Context, string, UpdateInput) (Versioned, error)
	Official(context.Context, string, OfficialInput) (Versioned, error)
	Terminate(context.Context, string, TerminationInput) (Versioned, error)
	UpdateIdentity(context.Context, string, IdentityUpdateInput) (Versioned, error)
	AdjustLeaveRate(context.Context, string, LeaveRateInput) (Created, error)
	LinkAccount(context.Context, string, AccountLinkInput) (Versioned, error)
}
