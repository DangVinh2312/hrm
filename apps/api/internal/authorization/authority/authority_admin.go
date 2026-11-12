package authority

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/gateway"
	"hrm/api/internal/database"
)

// AdminContext is what an admin command sees inside its exclusive-fence transaction. Detail reads a key of the
// command's resource through the command's plan; Reaches plans another permission for the same session and,
// with fulfil, runs that plan's obligations when it reaches key.
type AdminContext struct {
	Tx         *database.Tx
	Actor      Actor
	Permission string
	Detail     func(key string) (gateway.Row, error)
	Reaches    func(resource, action, key string, fulfil bool) (bool, error)
}

// AdminCommand is an admin-mode command whose target cannot be locked through its binding (account_directory is a
// view), so it locks what it needs itself. rootEvent is Root's audit of the result; &audit.Event{} means run
// already wrote it.
type AdminCommand[I, R any] struct {
	self      *AdminCommand[I, R]
	op        *operation
	run       func(AdminContext, I) (R, error)
	rootEvent func(AdminContext, I, R) *audit.Event
}

func NewAdminCommand[I, R any](resource, action string, run func(AdminContext, I) (R, error), rootEvent func(AdminContext, I, R) *audit.Event) *AdminCommand[I, R] {
	command := &AdminCommand[I, R]{op: &operation{pair: Probe{resource, action}}, run: run, rootEvent: rootEvent}
	command.self = command
	return command
}

func (c *AdminCommand[I, R]) operationRef() *operation {
	if c == nil {
		return nil
	}
	return c.op
}
func (c *AdminCommand[I, R]) validOperation() bool {
	return c != nil && c.self == c && c.run != nil && c.rootEvent != nil
}
func (c *AdminCommand[I, R]) adminOperation() bool { return true }

// Administer runs a registered admin command under the exclusive fence: session, facts and plan of the
// transaction, then run, then Root's audit and the plan's obligations. A shared-fence precheck
// (ReachesTarget, AllowsAll) belongs to the caller, before this.
func Administer[I, R any](ctx context.Context, a *Authorization, secret string, command *AdminCommand[I, R], input I) (R, error) {
	var zero R
	if a == nil || !command.validOperation() || !a.operations[command.op] {
		return zero, apperror.ErrAccessDenied
	}
	return access(ctx, a, secret, command.op.pair, database.ModeAdmin, func(tx *database.Tx, plan *core.AuthorizedPlan, s session) (R, *audit.Event, error) {
		c := AdminContext{Tx: tx, Actor: Actor{ID: string(s.userID), Kind: s.kind}, Permission: plan.Permission(),
			Detail: func(key string) (gateway.Row, error) {
				parsed, err := a.requestKey(plan.Resource(), key)
				if err != nil {
					return nil, err
				}
				return a.gateway.Detail(plan, parsed, tx)
			},
			Reaches: func(resource, action, key string, fulfil bool) (bool, error) {
				return a.reachesIn(tx, s, Probe{resource, action}, key, fulfil)
			}}
		value, err := command.run(c, input)
		if err != nil || s.kind != "root" {
			return value, nil, err
		}
		return value, command.rootEvent(c, input, value), nil
	})
}
