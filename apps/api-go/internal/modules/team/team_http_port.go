package team

import "context"

type HTTPPort interface {
	List(context.Context, string, ListQuery) (ListView, error)
	Detail(context.Context, string, string) (View, error)
	Create(context.Context, string, CreateInput) (Created, error)
	Rename(context.Context, string, RenameInput) (Renamed, error)
	AddMember(context.Context, string, MemberInput) (Status, error)
	SetPrimary(context.Context, string, MembershipRef) (Status, error)
	EndMembership(context.Context, string, MembershipRef) (Status, error)
	AssignLead(context.Context, string, LeadInput) (Status, error)
}
