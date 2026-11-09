package workrequest

import (
	"errors"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/modules/hrbase"
)

const decideOperation = "workRequest.decide"

type stage string

const (
	stageLead  stage = "lead"
	stageFinal stage = "final"
)

// decideCommand is a validated decision and its payload hash, computed outside SQL.
type decideCommand struct {
	DecisionInput
	Hash string
}

var errLockedRequestMissing = errors.New("locked request is missing")

// runDecision is workRequest.decideLead or decideFinal: Execute matched the stage policy's plan on the
// request row and locked it FOR NO KEY UPDATE, so concurrent decisions on one request serialize and the
// second one misses the plan. Lock order: request → idempotency read → effects (leave bucket, WFH counter,
// then the attendance period FOR SHARE) → writes; no employee or calendar lock is taken, and no writer takes
// the request after a bucket. Guards also bind Root, whose plan skips the stage scope: version, never one's
// own request, a real transition, the current first-step approver, every effect handler of the kind.
func (o *Operations) runDecision(s stage) func(authority.CommandContext, decideCommand) (SubmitResult, error) {
	return func(c authority.CommandContext, input decideCommand) (SubmitResult, error) {
		prior, err := priorClaim(c.Tx, c.Actor.ID, decideOperation, input.IdempotencyKey)
		if err != nil {
			return SubmitResult{}, err
		}
		if prior != nil {
			return replay(*prior, input.Hash)
		}
		row, err := lockedRequest(c.Tx, c.Target.Key, c.Actor.ID)
		if err != nil {
			return SubmitResult{}, err
		}
		if row == nil {
			return SubmitResult{}, errLockedRequestMissing
		}
		if row.Version != input.ExpectedVersion {
			return SubmitResult{}, apperror.ErrCommandRejected
		}
		// Never one's own request: neither the submitting account nor the account the employee is linked to now.
		if row.Self {
			return SubmitResult{}, apperror.ErrAccessDenied
		}
		next, ok := nextState(row.State, requestEvent(string(s)+"_"+input.Decision), approvalChainOf(row.Kind))
		if !ok {
			return SubmitResult{}, apperror.ErrCommandRejected
		}
		// The first step is the current lead's; for IAM the plan already says so, Root is never one.
		if s == stageLead && !row.Approver {
			return SubmitResult{}, apperror.ErrAccessDenied
		}
		if next == stateApproved {
			// Every part must exist before any runs: a half-open kind is refused with nothing written.
			effects, open := o.effects.effectsOf(row.Kind)
			if !open {
				return SubmitResult{}, apperror.ErrCommandRejected
			}
			for _, apply := range effects {
				if err := apply(c.Tx, c.Target.Key, input.AcknowledgeWfhLimit); err != nil {
					return SubmitResult{}, err
				}
			}
		}
		return writeDecision(c, s, input, row.State, next)
	}
}

func writeDecision(c authority.CommandContext, s stage, input decideCommand, from, next string) (SubmitResult, error) {
	version, err := moveRequest(c.Tx, c.Target.Key, input.ExpectedVersion, next, from)
	if err != nil {
		return SubmitResult{}, err
	}
	if version == "" {
		return SubmitResult{}, apperror.ErrCommandRejected
	}
	if err := insertDecision(c.Tx, c.Target.Key, string(s), input.Decision, c.Actor.ID, input.Reason); err != nil {
		return SubmitResult{}, err
	}
	result := SubmitResult{ID: c.Target.Key, State: next, Version: version}
	// Two requests decided with one key at once are not serialized by the request lock: the later claim
	// waits for the first and then inserts nothing, a reused key.
	claimed, err := claimDecision(c.Tx, c.Actor.ID, input.IdempotencyKey, input.Hash, c.Target.Key, result)
	if err != nil {
		return SubmitResult{}, err
	}
	if !claimed {
		return SubmitResult{}, apperror.Rejection{Code: "error.idempotencyKeyReused"}
	}
	kind := audit.KindHRRequestDecideLead
	if s == stageFinal {
		kind = audit.KindHRRequestDecideFinal
	}
	if err := c.Audit(kind, authority.AuditTarget{Resource: string(keys.WorkRequestResourceWorkRequest), Key: c.Target.Key, ObjectID: c.Target.ObjectID}, nil); err != nil {
		return SubmitResult{}, err
	}
	return result, nil
}

// decisionFacts are the state and version of a request read under workRequest.read, and this actor's claim
// of the key if any.
type decisionFacts struct {
	State   string
	Version string
	Prior   *hrbase.Claim[SubmitResult]
}
