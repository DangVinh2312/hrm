package authority

import (
	"context"
	"errors"
	"strings"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

func Read[I, R any](ctx context.Context, a *Authorization, secret string, query *Query[I, R], input I) (QueryResult[R], error) {
	var zero QueryResult[R]
	if a == nil || !query.validOperation() || !a.operations[query.op] {
		return zero, apperror.ErrAccessDenied
	}
	pair := query.op.pair
	var target *audit.RequestedKey
	if query.target != nil {
		parsed, err := a.requestKey(pair.Resource, query.target(input))
		if err != nil {
			return zero, err
		}
		target = &audit.RequestedKey{Resource: pair.Resource, KeyKind: parsed.Kind, Key: parsed.Value}
	}
	return access(ctx, a, secret, pair, database.ModeRead, func(tx *database.Tx, plan *core.AuthorizedPlan, s session) (QueryResult[R], *audit.Event, error) {
		bound, err := compiler.CompilePlan(plan, a.bindings)
		if err != nil {
			return zero, nil, err
		}
		result, err := query.run(QueryContext{Tx: tx, Actor: Actor{ID: string(s.userID), Kind: s.kind}, Scope: Scope{SQL: bound.SQL, Parameters: bound.Parameters}}, input)
		return result, rootAccess(plan, target, target != nil && !result.Found), err
	})
}

type CommandResult[R any] struct {
	Found bool
	Value R
}

var errTargetNotReached = errors.New("admin target no longer reached")

func Execute[I, R any](ctx context.Context, a *Authorization, secret string, command *Command[I, R], input I) (CommandResult[R], error) {
	var zero CommandResult[R]
	if a == nil || !command.validOperation() || !a.operations[command.op] {
		return zero, apperror.ErrAccessDenied
	}
	pair := command.op.pair
	key := command.target(input)
	parsed, err := a.requestKey(pair.Resource, key)
	if err != nil {
		return zero, err
	}
	if command.mode == database.ModeAdmin {
		reaches, err := a.ReachesTarget(ctx, secret, pair.Resource, pair.Action, key)
		if err != nil || !reaches {
			return zero, err
		}
	}
	result, err := access(ctx, a, secret, pair, command.mode, func(tx *database.Tx, plan *core.AuthorizedPlan, s session) (CommandResult[R], *audit.Event, error) {
		objectID, err := a.target(tx, plan, key, true)
		if err != nil {
			return zero, nil, err
		}
		if objectID == "" {
			if command.mode == database.ModeAdmin && s.kind == "iam" {
				return zero, nil, errTargetNotReached
			}
			return zero, rootAccess(plan, &audit.RequestedKey{Resource: pair.Resource, KeyKind: parsed.Kind, Key: parsed.Value}, true), nil
		}
		audited := false
		commandContext := CommandContext{Tx: tx, Actor: Actor{ID: string(s.userID), Kind: s.kind}, Permission: plan.Permission(), Target: Target{Key: parsed.Value, ObjectID: objectID}, Reaches: func(resource, action, key string) (bool, error) {
			return a.reachesIn(tx, s, Probe{resource, action}, key)
		}}
		commandContext.Audit = func(kind audit.Kind, target AuditTarget, detail *PermissionAuditDetail) error {
			parsed, err := a.requestKey(target.Resource, target.Key)
			if err != nil {
				return err
			}
			requested := audit.RequestedKey{Resource: target.Resource, KeyKind: parsed.Kind, Key: parsed.Value, ObjectID: target.ObjectID}
			var root *audit.RootOutcome
			if s.kind == "root" {
				root = &audit.RootOutcome{Outcome: "ok"}
			}
			var payload audit.Detail = audit.ModuleChange{Permission: plan.Permission(), Target: requested, Root: root}
			if strings.HasPrefix(string(kind), "permission.") {
				if detail == nil {
					detail = &PermissionAuditDetail{}
				}
				payload = audit.PermissionChange{Permission: plan.Permission(), Target: requested, Root: root, RoleKey: detail.RoleKey, GrantCount: detail.GrantCount, GrantsDigest: detail.GrantsDigest, BoundaryKey: detail.BoundaryKey, BoundaryVersion: detail.BoundaryVersion, TargetUserID: detail.TargetUserID}
			} else if detail != nil {
				return audit.ErrInvalidEvent
			}
			if err := audit.Append(tx, audit.Event{Kind: kind, Actor: string(s.userID), Detail: payload}); err != nil {
				return err
			}
			audited = true
			return nil
		}
		result, err := command.run(commandContext, input)
		if err != nil {
			return zero, nil, err
		}
		if !audited {
			return zero, nil, errors.New("command did not audit its effect")
		}
		return CommandResult[R]{Found: true, Value: result}, &audit.Event{}, nil
	})
	if errors.Is(err, errTargetNotReached) {
		return zero, nil
	}
	return result, err
}
