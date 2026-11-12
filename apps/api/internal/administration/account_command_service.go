package administration

import (
	"errors"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/grant"
	"hrm/api/internal/authorization/keys"
)

type roleChange struct{ UserID, RoleKey string }

func (r roleChange) targetID() string { return r.UserID }

type provisionInput struct{ UserID, Email, Issuer, RoleKey string }

type provisioned struct {
	found bool
	row   ProvisionedAccount
}

// commands are the account commands; each runs in an admin transaction after the exclusive fence.
type commands struct{ core *core.Core }

// suspend: the target's grants within the actor's before anything is written (Root skips the comparison).
func (m commands) suspend(c authority.AdminContext, target accountID) (*audit.Event, error) {
	within, _, err := grant.WithinActor(c.Tx, m.core, grant.Actor(c.Actor), string(target))
	if err != nil || !within {
		return nil, err
	}
	if err := suspendAccount(c.Tx, string(target)); err != nil {
		return nil, err
	}
	event := accountEvent(audit.KindAccountSuspend, c, string(target), "ok")
	return &event, nil
}

// reactivate compares the grants before the state check, so a larger account never reveals whether it is
// suspended.
func (m commands) reactivate(c authority.AdminContext, target accountID) (*audit.Event, error) {
	within, _, err := grant.WithinActor(c.Tx, m.core, grant.Actor(c.Actor), string(target))
	if err != nil || !within {
		return nil, err
	}
	if err := reactivateAccount(c.Tx, string(target)); err != nil {
		return nil, err
	}
	event := accountEvent(audit.KindAccountReactivate, c, string(target), "ok")
	return &event, nil
}

// roleWithin: an IAM actor assigns only a role whose every rule it holds, read whole; Root needs the role to exist.
func roleWithin(c authority.AdminContext, roleKey string, actorGrants []grant.GrantRuleFact) (bool, error) {
	switch c.Actor.Kind {
	case "root":
		return roleExists(c.Tx, roleKey)
	case "iam":
		facts, truncated, found, err := roleRules(c.Tx, roleKey)
		if err != nil || !found || truncated {
			return false, err
		}
		return grant.CompareGrantSets(facts, actorGrants) == grant.Within, nil
	}
	return false, errors.New("unknown principal kind")
}

// changeRole locks the target's row before reading facts, so it is serialized with every other writer of the
// account; then the target within the actor's grants, then (assign of IAM) the role within them too, then state.
func (m commands) changeRole(assigning bool) func(authority.AdminContext, roleChange) (*audit.Event, error) {
	return func(c authority.AdminContext, input roleChange) (*audit.Event, error) {
		if err := lockAccount(c.Tx, input.UserID); err != nil {
			return nil, err
		}
		within, actorGrants, err := grant.WithinActor(c.Tx, m.core, grant.Actor(c.Actor), input.UserID)
		if err != nil || !within {
			return nil, err
		}
		reached := false
		if assigning {
			reached, err = roleWithin(c, input.RoleKey, actorGrants)
		} else {
			reached, err = roleExists(c.Tx, input.RoleKey)
		}
		if err != nil || !reached {
			return nil, err
		}
		if err := changeHolding(c, input, assigning); err != nil {
			return nil, err
		}
		kind := audit.KindPermissionRoleRevoke
		if assigning {
			kind = audit.KindPermissionRoleAssign
		}
		return &audit.Event{Kind: kind, Actor: c.Actor.ID, Detail: audit.PermissionChange{
			Permission: c.Permission, Root: rootOutcome(c, "ok"), RoleKey: input.RoleKey, TargetUserID: input.UserID,
			Target: audit.RequestedKey{Resource: string(keys.AccountResourceAccount), KeyKind: core.KeyUUID, Key: input.UserID, ObjectID: input.UserID},
		}}, nil
	}
}

// changeHolding: already held or MaxAccountRoles is a conflict of assign; not held or the last role (an IAM
// account keeps one, suspend removes all access instead) is a conflict of revoke.
func changeHolding(c authority.AdminContext, input roleChange, assigning bool) error {
	count, held, err := holding(c.Tx, input.UserID, input.RoleKey)
	if err != nil {
		return err
	}
	if assigning {
		if held || count >= MaxAccountRoles {
			return apperror.ErrCommandRejected
		}
		inserted, err := insertAccountRole(c.Tx, input.UserID, input.RoleKey)
		if err == nil && !inserted {
			return apperror.ErrCommandRejected
		}
		return err
	}
	if !held || count <= 1 {
		return apperror.ErrCommandRejected
	}
	gone, err := deleteAccountRole(c.Tx, input.UserID, input.RoleKey)
	if err == nil && !gone {
		return apperror.ErrCommandRejected
	}
	return err
}

// provision: the role decides first (IAM: within the actor's grants, read whole; Root: exists), before anything
// is written. The new account must then be seen through the provision plan and reached by the assignRole plan,
// whose obligations run, or the whole command is refused.
func (m commands) provision(c authority.AdminContext, input provisionInput) (provisioned, error) {
	reached := false
	var err error
	switch c.Actor.Kind {
	case "iam":
		facts, truncated, readErr := grant.Read(c.Tx, m.core, []string{c.Actor.ID}, grant.MaxFactRows)
		if readErr != nil || truncated {
			return provisioned{}, readErr
		}
		reached, err = roleWithin(c, input.RoleKey, facts[c.Actor.ID])
	default:
		reached, err = roleWithin(c, input.RoleKey, nil)
	}
	if err != nil || !reached {
		return provisioned{}, err
	}
	if err := provisionAccount(c.Tx, input.UserID, input.Email, input.Issuer, c.Actor.ID); err != nil {
		return provisioned{}, err
	}
	row, err := c.Detail(input.UserID)
	if err != nil {
		return provisioned{}, err
	}
	assignable, err := c.Reaches(string(keys.AccountResourceAccount), string(keys.AccountActionAssignRole), input.UserID, true)
	if err != nil {
		return provisioned{}, err
	}
	account, ok := accountOf(row)
	if !ok || !assignable {
		return provisioned{}, apperror.ErrAccessDenied
	}
	inserted, err := insertAccountRole(c.Tx, input.UserID, input.RoleKey)
	if err != nil {
		return provisioned{}, err
	}
	if !inserted {
		return provisioned{}, apperror.ErrCommandRejected
	}
	if c.Actor.Kind == "iam" {
		if err := audit.Append(c.Tx, accountEvent(audit.KindAccountProvision, c, input.UserID, "ok")); err != nil {
			return provisioned{}, err
		}
	}
	assigned := audit.Event{Kind: audit.KindPermissionRoleAssign, Actor: c.Actor.ID, Detail: audit.PermissionChange{
		Permission: string(keys.AccountResourceAccount) + "." + string(keys.AccountActionAssignRole), Root: rootOutcome(c, "ok"),
		RoleKey: input.RoleKey, TargetUserID: input.UserID,
		Target: audit.RequestedKey{Resource: string(keys.AccountResourceAccount), KeyKind: core.KeyUUID, Key: input.UserID, ObjectID: input.UserID},
	}}
	if err := audit.Append(c.Tx, assigned); err != nil {
		return provisioned{}, err
	}
	return provisioned{found: true, row: ProvisionedAccount{UserID: account.UserID, Email: account.Email, State: account.State}}, nil
}

func provisionRootEvent(c authority.AdminContext, input provisionInput, result provisioned) *audit.Event {
	if result.found {
		event := accountEvent(audit.KindAccountProvision, c, input.UserID, "ok")
		return &event
	}
	return &audit.Event{Kind: audit.Kind("access." + string(keys.AccountResourceAccount) + "." + string(keys.AccountActionProvision)), Actor: c.Actor.ID, Detail: audit.Access{Permission: c.Permission, Root: &audit.RootOutcome{Outcome: "absent"}}}
}
