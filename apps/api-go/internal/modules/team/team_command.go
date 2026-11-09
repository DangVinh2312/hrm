package team

import (
	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/modules/permission"
)

func teamTarget(ctx authority.CommandContext) authority.AuditTarget {
	return authority.AuditTarget{Resource: string(keys.TeamResourceTeam), Key: ctx.Target.Key, ObjectID: ctx.Target.ObjectID}
}
func runCreate(ctx authority.CommandContext, input CreateInput) (Created, error) {
	id := newUUID()
	objectID, err := permission.Register(ctx.Tx, string(keys.TeamResourceTeam), id)
	if err != nil {
		return Created{}, err
	}
	if err := insertTeam(ctx.Tx, id, objectID, input.Name); err != nil {
		return Created{}, err
	}
	err = ctx.Audit(audit.KindHRTeamCreate, authority.AuditTarget{Resource: string(keys.TeamResourceTeam), Key: id, ObjectID: objectID}, nil)
	return Created{ID: id}, err
}
func runRename(ctx authority.CommandContext, input RenameInput) (Renamed, error) {
	result, err := renameTeam(ctx.Tx, ctx.Target.Key, input.Name, input.ExpectedVersion)
	if err != nil {
		return Renamed{}, err
	}
	return result, ctx.Audit(audit.KindHRTeamUpdate, teamTarget(ctx), nil)
}
func finishAssign(ctx authority.CommandContext) error {
	if err := advanceTeam(ctx.Tx, ctx.Target.Key); err != nil {
		return err
	}
	return ctx.Audit(audit.KindHRTeamAssign, teamTarget(ctx), nil)
}
func runAddMember(ctx authority.CommandContext, input MemberInput) (Status, error) {
	if err := employeeAssignable(ctx.Tx, input.EmployeeID, ctx.Actor.ID); err != nil {
		return Status{}, err
	}
	current, err := memberships(ctx.Tx, input.EmployeeID)
	if err != nil {
		return Status{}, err
	}
	for _, row := range current {
		if row.Team == ctx.Target.Key {
			return Status{}, apperror.ErrCommandRejected
		}
	}
	primary := len(current) == 0 || input.Primary
	if primary {
		if err := demotePrimary(ctx.Tx, input.EmployeeID, current); err != nil {
			return Status{}, err
		}
	}
	if err := addMembershipRow(ctx.Tx, ctx.Target.Key, input.EmployeeID, primary); err != nil {
		return Status{}, err
	}
	return Status{Status: "added"}, finishAssign(ctx)
}
func runSetPrimary(ctx authority.CommandContext, input MembershipRef) (Status, error) {
	if err := employeeAssignable(ctx.Tx, input.EmployeeID, ctx.Actor.ID); err != nil {
		return Status{}, err
	}
	current, err := memberships(ctx.Tx, input.EmployeeID)
	if err != nil {
		return Status{}, err
	}
	var member *membership
	for _, row := range current {
		if row.Team == ctx.Target.Key {
			member = &row
			break
		}
	}
	if member == nil || member.Primary {
		return Status{}, apperror.ErrCommandRejected
	}
	if err := demotePrimary(ctx.Tx, input.EmployeeID, current); err != nil {
		return Status{}, err
	}
	if err := endMembershipRow(ctx.Tx, member.ID); err != nil {
		return Status{}, err
	}
	if err := addMembershipRow(ctx.Tx, ctx.Target.Key, input.EmployeeID, true); err != nil {
		return Status{}, err
	}
	return Status{Status: "primary"}, finishAssign(ctx)
}
func runEndMembership(ctx authority.CommandContext, input MembershipRef) (Status, error) {
	if err := employeeOther(ctx.Tx, input.EmployeeID, ctx.Actor.ID); err != nil {
		return Status{}, err
	}
	current, err := memberships(ctx.Tx, input.EmployeeID)
	if err != nil {
		return Status{}, err
	}
	var member *membership
	for _, row := range current {
		if row.Team == ctx.Target.Key {
			member = &row
			break
		}
	}
	if member == nil || (member.Primary && len(current) > 1) {
		return Status{}, apperror.ErrCommandRejected
	}
	leading, err := employeeLeading(ctx.Tx, ctx.Target.Key, input.EmployeeID)
	if err != nil {
		return Status{}, err
	}
	if leading {
		return Status{}, apperror.ErrCommandRejected
	}
	if err := endMembershipRow(ctx.Tx, member.ID); err != nil {
		return Status{}, err
	}
	return Status{Status: "ended"}, finishAssign(ctx)
}
func runAssignLead(ctx authority.CommandContext, input LeadInput) (Status, error) {
	lead, err := currentLead(ctx.Tx, ctx.Target.Key)
	if err != nil {
		return Status{}, err
	}
	if (lead == nil && input.EmployeeID == nil) || (lead != nil && input.EmployeeID != nil && lead.Employee == *input.EmployeeID) {
		return Status{}, apperror.ErrCommandRejected
	}
	if input.EmployeeID != nil {
		if err := employeeAssignable(ctx.Tx, *input.EmployeeID, ctx.Actor.ID); err != nil {
			return Status{}, err
		}
		current, err := memberships(ctx.Tx, *input.EmployeeID)
		if err != nil {
			return Status{}, err
		}
		if err := requireMember(current, ctx.Target.Key); err != nil {
			return Status{}, err
		}
	}
	if lead != nil {
		if err := endLeadRow(ctx.Tx, lead.ID); err != nil {
			return Status{}, err
		}
	}
	if input.EmployeeID != nil {
		if err := addLeadRow(ctx.Tx, ctx.Target.Key, *input.EmployeeID); err != nil {
			return Status{}, err
		}
	}
	return Status{Status: "assigned"}, finishAssign(ctx)
}
