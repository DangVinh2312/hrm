package workrequest

import (
	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/leavecore"
)

const cancelOperation = "workRequest.cancel"

// cancelCommand is a validated cancellation and its payload hash, computed outside SQL.
type cancelCommand struct {
	CancelInput
	Hash string
}

// runCancel is workRequest.cancel (the owner, a pending request) or workRequest.cancelApproved (HR, fresh, an
// approved request): Execute matched the policy's plan on the request row and locked it FOR NO KEY UPDATE, so
// concurrent cancels and decisions on one request serialize and the later one misses the plan. Lock order:
// request → idempotency read → leave bucket (one reversal per debit, UNIQUE) or WFH counters (ascending
// month) → attendance period FOR SHARE (closed is 409 error.periodClosed) → writes; no employee or calendar
// lock. Leaving approved is the attendance effect: the sheet reads approved requests only.
func runCancel(approved bool) func(authority.CommandContext, cancelCommand) (SubmitResult, error) {
	return func(c authority.CommandContext, input cancelCommand) (SubmitResult, error) {
		prior, err := priorClaim(c.Tx, c.Actor.ID, cancelOperation, input.IdempotencyKey)
		if err != nil {
			return SubmitResult{}, err
		}
		if prior != nil {
			return replay(*prior, input.Hash)
		}
		row, err := requestToCancel(c.Tx, c.Target.Key)
		if err != nil {
			return SubmitResult{}, err
		}
		if row == nil {
			return SubmitResult{}, errLockedRequestMissing
		}
		if row.Version != input.ExpectedVersion {
			return SubmitResult{}, apperror.ErrCommandRejected
		}
		event, kind := eventCancel, audit.KindHRRequestCancel
		if approved {
			event, kind = eventCancelApproved, audit.KindHRRequestCancelApproved
		}
		next, ok := nextState(row.State, event, approvalChainOf(row.Kind))
		if !ok {
			return SubmitResult{}, apperror.ErrCommandRejected
		}
		if approved {
			if input.Reason == nil {
				return SubmitResult{}, apperror.ErrInvalidRequest
			}
			if err := reverseApproved(c, row.Kind); err != nil {
				return SubmitResult{}, err
			}
		}
		return writeMove(c, move{
			stage: "cancel", decision: "cancel", operation: cancelOperation, kind: kind,
			key: input.IdempotencyKey, hash: input.Hash, version: input.ExpectedVersion, reason: input.Reason,
			from: row.State, next: next,
		})
	}
}

// reverseApproved gives back what the approval took, then holds every month of the request open FOR SHARE,
// the same guard as the approval.
func reverseApproved(c authority.CommandContext, kind hrbase.RequestKind) error {
	switch kind {
	case hrbase.RequestAnnualLeave:
		if err := leavecore.ReverseApproved(c.Tx, c.Target.Key); err != nil {
			return err
		}
	case hrbase.RequestWfh:
		if err := attendancecore.ReverseApprovedWfh(c.Tx, c.Target.Key); err != nil {
			return err
		}
	case hrbase.RequestUnpaidLeave, hrbase.RequestLateArrival, hrbase.RequestEarlyDeparture:
	}
	return attendancecore.ApplyApprovedAttendance(c.Tx, c.Target.Key)
}
