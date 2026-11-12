// Package authority binds verified sessions, authorization plans and effects to one fenced transaction.
package authority

import (
	"context"
	"errors"
	"maps"
	"slices"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/compiler"
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/gateway"
	"hrm/api/internal/database"
)

type Probe struct{ Resource, Action string }
type PermitQuery []Probe

const MaxPermitProbes = 17

func ValidPermitQueries(queries []PermitQuery) bool {
	if len(queries) == 0 || len(queries) > MaxPermitProbes {
		return false
	}
	total := 0
	for _, group := range queries {
		if len(group) == 0 {
			return false
		}
		total += len(group)
		if total > MaxPermitProbes {
			return false
		}
		for _, probe := range group {
			if probe.Resource == "" || probe.Action == "" || len(probe.Resource) > 96 || len(probe.Action) > 96 {
				return false
			}
		}
	}
	return true
}

type ObligationHandler func(*database.Tx, *core.AuthorizedPlan) error
type Capabilities struct {
	Validators  map[string]core.ContextValidator
	Obligations map[string]ObligationHandler
}
type ResourceWrite struct {
	Resource, Action string
	Fields           []string
}

type Authorization struct {
	runner      *database.Runner
	bindings    *compiler.Registry
	gateway     *gateway.Gateway
	registry    core.Registry
	obligations map[string]ObligationHandler
	writable    []ResourceWrite
	operations  map[*operation]bool
}

func New(runner *database.Runner, bindings *compiler.Registry, capabilities Capabilities, writable []ResourceWrite, operations ...Operation) (*Authorization, error) {
	if runner == nil {
		return nil, errors.New("authority requires a transaction runner")
	}
	g, err := gateway.New(bindings)
	if err != nil {
		return nil, err
	}
	a := &Authorization{runner: runner, bindings: bindings, gateway: g, obligations: maps.Clone(capabilities.Obligations), operations: make(map[*operation]bool)}
	a.registry.Validators = maps.Clone(capabilities.Validators)
	for name, handler := range a.obligations {
		if handler != nil {
			a.registry.ObligationHandlers = append(a.registry.ObligationHandlers, name)
		}
	}
	slices.Sort(a.registry.ObligationHandlers)
	for _, op := range operations {
		if op == nil || op.operationRef() == nil || !op.validOperation() {
			return nil, errors.New("invalid authority operation")
		}
		ref := op.operationRef()
		if !a.PermissionExists(ref.pair.Resource, ref.pair.Action) {
			return nil, errors.New("operation permission is undeclared")
		}
		if op.adminOperation() {
			resource, _ := bindings.Declarations().Resource(ref.pair.Resource)
			policy, ok := bindings.Declarations().Policy(resource.Actions[ref.pair.Action].Policy)
			fresh := false
			for _, requirement := range policy.ContextRequirements {
				fresh = fresh || requirement.Validator == "fresh@1"
			}
			if !ok || !fresh {
				return nil, errors.New("admin command requires a fresh authentication policy")
			}
		}
		a.operations[ref] = true
	}
	for _, write := range writable {
		declared, ok := bindings.Declarations().Resource(write.Resource)
		if !ok || !a.PermissionExists(write.Resource, write.Action) || len(write.Fields) == 0 {
			return nil, errors.New("invalid writable declaration")
		}
		for _, field := range write.Fields {
			if _, ok := declared.Fields[field]; !ok {
				return nil, errors.New("undeclared writable field")
			}
		}
		a.writable = append(a.writable, ResourceWrite{Resource: write.Resource, Action: write.Action, Fields: slices.Clone(write.Fields)})
	}
	return a, nil
}

func (a *Authorization) PermissionExists(resource, action string) bool {
	if a == nil || a.bindings == nil {
		return false
	}
	r, ok := a.bindings.Declarations().Resource(resource)
	if !ok {
		return false
	}
	_, ok = r.Actions[action]
	return ok
}

func DefaultCapabilities() Capabilities {
	return Capabilities{
		Validators: map[string]core.ContextValidator{"fresh@1": func(_ map[string]core.Scalar, input core.ValidatorInput) core.ValidatorResult {
			fresh, ok := input.Context["freshAuthentication"].AsBool()
			if ok && fresh {
				return core.ValidatorTrue
			}
			return core.ValidatorFalse
		}},
		Obligations: map[string]ObligationHandler{"audit@1": func(tx *database.Tx, plan *core.AuthorizedPlan) error {
			return audit.Append(tx, audit.Event{Kind: audit.Kind("access." + plan.Action()), Actor: string(plan.UserID()), Detail: audit.Access{Permission: plan.Permission()}})
		}},
	}
}

func (a *Authorization) decide(tx *database.Tx, s session, f facts, pair Probe) (core.Decision, error) {
	snapshot, err := a.snapshot(tx, s, f, pair.Resource+"."+pair.Action)
	if err != nil {
		return core.Decision{}, err
	}
	assurance := 1
	if s.assurance == "mfa" {
		assurance = 2
	}
	input := core.TrustedInput{Principal: core.TrustedPrincipal{ID: s.userID, Assurance: assurance}, Resource: pair.Resource, Action: pair.Action, Now: s.now, ValidUntil: s.deadline, Context: map[string]core.Scalar{"freshAuthentication": core.Bool(s.fresh)}}
	if s.kind == "root" {
		return a.bindings.Core().PlanUnrestricted(input, snapshot), nil
	}
	return a.bindings.Core().Plan(input, snapshot), nil
}

func (a *Authorization) fulfill(tx *database.Tx, plan *core.AuthorizedPlan) error {
	if !a.bindings.Core().Issued(plan) || plan.Revision() != tx.Revision {
		return errors.New("obligations require the authorizing transaction")
	}
	for _, obligation := range plan.Obligations() {
		handler := a.obligations[obligation.Handler]
		if handler == nil {
			return apperror.ErrAccessDenied
		}
		if err := handler(tx, plan); err != nil {
			return err
		}
	}
	return nil
}

func access[T any](ctx context.Context, a *Authorization, secret string, pair Probe, mode database.Mode, work func(*database.Tx, *core.AuthorizedPlan, session) (T, *audit.Event, error)) (T, error) {
	return database.Run(ctx, a.runner, mode, func(_ context.Context, tx *database.Tx) (T, error) {
		var zero T
		s, f, err := a.readSession(tx, secret, []Probe{pair})
		if err != nil {
			return zero, err
		}
		decision, err := a.decide(tx, s, f, pair)
		if err != nil {
			return zero, err
		}
		if !decision.Allowed() {
			return zero, apperror.ErrAccessDenied
		}
		value, rootEvent, err := work(tx, decision.Plan(), s)
		if err != nil {
			return zero, err
		}
		if s.kind == "root" {
			if rootEvent == nil {
				return zero, errors.New("root access requires audit")
			}
			if rootEvent.Kind != "" {
				if err := audit.Append(tx, *rootEvent); err != nil {
					return zero, err
				}
			}
		}
		if err := a.fulfill(tx, decision.Plan()); err != nil {
			return zero, err
		}
		return value, nil
	}, database.RunOptions{})
}

func rootAccess(plan *core.AuthorizedPlan, target *audit.RequestedKey, absent bool) *audit.Event {
	outcome := "ok"
	if absent {
		outcome = "absent"
	}
	return &audit.Event{Kind: audit.Kind("access." + plan.Resource() + "." + plan.Action()), Actor: string(plan.UserID()), Detail: audit.Access{Permission: plan.Permission(), Root: &audit.RootOutcome{Outcome: outcome}, Target: target}}
}

func (a *Authorization) requestKey(resource, key string) (core.Key, error) {
	declared, ok := a.bindings.Declarations().Resource(resource)
	if !ok {
		return core.Key{}, apperror.ErrAccessDenied
	}
	parsed, err := a.bindings.Core().ParseKey(declared.KeyKind, key)
	if err != nil {
		return core.Key{}, apperror.ErrInvalidRequest
	}
	return parsed, nil
}
