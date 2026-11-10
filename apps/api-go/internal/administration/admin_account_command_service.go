package administration

import (
	"context"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/keys"
)

// accountTarget is the input of a command on another account; targetID is the id as the request wrote it.
type accountTarget interface{ targetID() string }

type accountID string

func (id accountID) targetID() string { return string(id) }

// accountCommand is a command on another IAM account. Its work runs inside the exclusive fence only after the
// account was found through the command's plan (account_directory holds IAM accounts only, so an absent id and
// any Root are the same not found) and after oneself was refused. work returns the business event of a done
// command, which is appended here in the same transaction, or nil for a not found that changed nothing; absent
// is Root's audit of that not found. Locks, grant comparisons and state checks belong to work.
type accountCommand[I accountTarget] struct {
	action  string
	command *authority.AdminCommand[I, bool]
}

func newAccountCommand[I accountTarget](action keys.AccountAction, work func(authority.AdminContext, I) (*audit.Event, error), absent func(authority.AdminContext, I) audit.Event) accountCommand[I] {
	run := func(c authority.AdminContext, input I) (bool, error) {
		row, err := c.Detail(input.targetID())
		if err != nil || row == nil {
			return false, err
		}
		if c.Actor.ID == input.targetID() {
			return false, apperror.ErrAccessDenied
		}
		event, err := work(c, input)
		if err != nil || event == nil {
			return false, err
		}
		return true, audit.Append(c.Tx, *event)
	}
	rootEvent := func(c authority.AdminContext, input I, done bool) *audit.Event {
		if done {
			return &audit.Event{}
		}
		event := absent(c, input)
		return &event
	}
	return accountCommand[I]{action: string(action), command: authority.NewAdminCommand(string(keys.AccountResourceAccount), string(action), run, rootEvent)}
}

// onAccount: a target that is not a canonical lowercase UUID is refused before anything is read; then the
// shared-fence answer, where an IAM caller that does not reach the target is not found without taking the
// exclusive fence or advancing the revision; then the command. found=false is one 404 for every not found.
func onAccount[I accountTarget](ctx context.Context, a *authority.Authorization, c *core.Core, secret string, command accountCommand[I], input I) (bool, error) {
	id := input.targetID()
	if c == nil || !c.IsCanonicalUUID(id) {
		return false, apperror.ErrAccessDenied
	}
	reached, err := a.ReachesTarget(ctx, secret, string(keys.AccountResourceAccount), command.action, id)
	if err != nil || !reached {
		return false, err
	}
	return authority.Administer(ctx, a, secret, command.command, input)
}

// rootOutcome marks Root's event of a command; an IAM actor's event carries none.
func rootOutcome(c authority.AdminContext, outcome string) *audit.RootOutcome {
	if c.Actor.Kind != "root" {
		return nil
	}
	return &audit.RootOutcome{Outcome: outcome}
}

func accountEvent(kind audit.Kind, c authority.AdminContext, target string, outcome string) audit.Event {
	return audit.Event{Kind: kind, Actor: c.Actor.ID, Detail: audit.AccountChange{Permission: c.Permission, TargetUserID: target, Root: rootOutcome(c, outcome)}}
}

func accessAbsent(c authority.AdminContext, action, target string) audit.Event {
	return audit.Event{Kind: audit.Kind("access." + string(keys.AccountResourceAccount) + "." + action), Actor: c.Actor.ID, Detail: audit.Access{
		Permission: c.Permission, Root: &audit.RootOutcome{Outcome: "absent"},
		Target: &audit.RequestedKey{Resource: string(keys.AccountResourceAccount), KeyKind: core.KeyUUID, Key: target},
	}}
}
