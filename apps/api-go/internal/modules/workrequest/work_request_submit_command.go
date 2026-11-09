package workrequest

import (
	"errors"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/leavecore"
	"hrm/api-go/internal/modules/permission"
	"hrm/api-go/internal/modules/schedulecore"
	"hrm/api-go/internal/modules/settingcore"
)

var submitRuleKeys = []settingcore.Key{
	settingcore.KeyRequestWindowPastDays, settingcore.KeyRequestWindowFutureDays,
	settingcore.KeyRequestMaxDays, settingcore.KeyWfhMonthLimit,
}

type submitCommand struct {
	SubmitInput
	EmployeeID string
	// Hash is the SHA-256 hex of the normalized request, computed outside SQL.
	Hash string
}

// submitterNotFound is a locked employee that is not the session's own profile any more: 404, no write.
type submitterNotFound struct{}

func (submitterNotFound) Error() string { return "submitter not found" }

// replay answers a committed claim of this actor and key: another payload is 422, the same one is the stored
// result.
func replay(prior hrbase.Claim[SubmitResult], hash string) (SubmitResult, error) {
	result, err := hrbase.Replay(prior, hash)
	if err != nil {
		return SubmitResult{}, err
	}
	return authority.Replay(result)
}

// segmentsOf reads the status and schedule of the request's dates and applies the submit rules.
func segmentsOf(c authority.CommandContext, input SubmitInput, facts *submitterFacts) ([]Segment, error) {
	dates := requestDates(input)
	statuses, err := statusesOn(c.Tx, c.Target.Key, dates)
	if err != nil {
		return nil, err
	}
	schedule, err := schedulecore.EmployeeSchedule(c.Tx, c.Target.Key, dates, *facts.Calendar)
	if err != nil {
		return nil, err
	}
	segments, err := requestSegments(input, submitFacts{Earliest: facts.Earliest, Latest: facts.Latest, Schedule: schedule, StatusOn: func(day string) string { return statuses[day] }})
	if r, ok := errors.AsType[rejected](err); ok {
		return nil, ruleError(r.reason)
	}
	return segments, err
}

// runSubmit is employee.submitRequest: Execute matched the plan on the employee row and locked it FOR NO
// KEY UPDATE, which serializes every submit of one account (employee.account_id is UNIQUE). Lock order:
// employee → idempotency read → periods of the dates FOR SHARE → work_calendar FOR SHARE → inserts; a COO's
// own request then runs the approval effects (bucket → counter → period FOR SHARE again, a no-op).
func (o *Operations) runSubmit(c authority.CommandContext, input submitCommand) (SubmitResult, error) {
	prior, err := priorClaim(c.Tx, c.Actor.ID, submitOperation, input.IdempotencyKey)
	if err != nil {
		return SubmitResult{}, err
	}
	if prior != nil {
		return replay(*prior, input.Hash)
	}
	rules, err := settingcore.Read(c.Tx, submitRuleKeys)
	if err != nil {
		return SubmitResult{}, err
	}
	dates := requestDates(input.SubmitInput)
	if int64(len(dates)) > rules[settingcore.KeyRequestMaxDays].Int {
		return SubmitResult{}, apperror.ErrInvalidRequest
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, dates); err != nil {
		return SubmitResult{}, err
	}
	facts, err := readSubmitterFacts(c.Tx, c.Target.Key, c.Actor.ID, input.TeamID, rules[settingcore.KeyRequestWindowPastDays].Int, rules[settingcore.KeyRequestWindowFutureDays].Int)
	if err != nil {
		return SubmitResult{}, err
	}
	if facts == nil {
		return SubmitResult{}, submitterNotFound{}
	}
	// One answer for every team id that is not a current team of the caller: existence is never told.
	if facts.Team == nil {
		return SubmitResult{}, apperror.Rejection{Code: "error.teamNotMember"}
	}
	segments, err := segmentsOf(c, input.SubmitInput, facts)
	if err != nil {
		return SubmitResult{}, err
	}
	booked, err := bookedOn(c.Tx, c.Target.Key, dates)
	if err != nil {
		return SubmitResult{}, err
	}
	if conflicts(input.Kind, segments, booked) {
		return SubmitResult{}, apperror.Rejection{Code: "error.overlappingRequest"}
	}
	if input.Kind == hrbase.RequestAnnualLeave {
		dated := make([]leavecore.DatedMinutes, len(segments))
		for i, s := range segments {
			dated[i] = leavecore.DatedMinutes{Date: s.Date, Minutes: s.Minutes}
		}
		if err := leavecore.AssertAvailable(c.Tx, c.Target.Key, dated); err != nil {
			return SubmitResult{}, err
		}
	}
	return o.writeSubmit(c, input, facts, segments, dates, int(rules[settingcore.KeyWfhMonthLimit].Int))
}

// writeSubmit decides the initial state and writes the request, its segments, a COO's approval, the
// system decision, the claim and the audit.
func (o *Operations) writeSubmit(c authority.CommandContext, input submitCommand, facts *submitterFacts, segments []Segment, dates []string, wfhLimit int) (SubmitResult, error) {
	// A COO is whoever holds the company's final step by permission, whichever role carries it.
	isCoo, err := c.Reaches(string(keys.CompanyResourceCompany), string(keys.CompanyActionApprovals), permission.CompanyID)
	if err != nil {
		return SubmitResult{}, err
	}
	begin := initialState(isCoo, facts.Leads)
	var effects []func(*database.Tx, string, bool) error
	if begin.State == stateApproved {
		var open bool
		if effects, open = o.effects.effectsOf(input.Kind); !open {
			return SubmitResult{}, apperror.ErrCommandRejected
		}
	}
	result := SubmitResult{State: begin.State, Version: "1"}
	if input.Kind == hrbase.RequestWfh {
		exceeded, err := attendancecore.WfhLimitExceeded(c.Tx, c.Target.Key, dates, wfhLimit)
		if err != nil {
			return SubmitResult{}, err
		}
		result.WfhLimitExceeded = &exceeded
	}
	if result.ID, err = newRequestID(c.Tx); err != nil {
		return SubmitResult{}, err
	}
	resource := string(keys.WorkRequestResourceWorkRequest)
	objectID, err := permission.Register(c.Tx, resource, result.ID)
	if err != nil {
		return SubmitResult{}, err
	}
	// A COO's request is written pending_final first, so the decideFinal plan is evaluated on this very row.
	written := begin.State
	if written == stateApproved {
		written = statePendingFinal
	}
	row := newRequest{ID: result.ID, ObjectID: objectID, EmployeeID: c.Target.Key, OwnerAccountID: c.Actor.ID, TeamID: *facts.Team, Kind: input.Kind, State: written, Reason: input.Reason}
	if err := insertRequest(c.Tx, row, segments); err != nil {
		return SubmitResult{}, err
	}
	if begin.State == stateApproved {
		if err := approveOwn(c, result.ID, effects); err != nil {
			return SubmitResult{}, err
		}
	}
	if begin.SystemDecision != "" {
		if err := insertSystemDecision(c.Tx, result.ID, begin); err != nil {
			return SubmitResult{}, err
		}
	}
	if err := insertClaim(c.Tx, c.Actor.ID, input.IdempotencyKey, input.Hash, result.ID, result); err != nil {
		return SubmitResult{}, err
	}
	target := authority.AuditTarget{Resource: resource, Key: result.ID, ObjectID: objectID}
	if err := c.Audit(audit.KindHRRequestSubmit, target, nil); err != nil {
		return SubmitResult{}, err
	}
	if begin.State == stateApproved {
		if err := c.Audit(audit.KindHRRequestSelfApprove, target, nil); err != nil {
			return SubmitResult{}, err
		}
	}
	return result, nil
}

// approveOwn is a COO's final approval of their own request: the same right as a decision (grant, scope,
// deny, boundary) on the written row, then every effect with the WFH warning acknowledged.
func approveOwn(c authority.CommandContext, id string, effects []func(*database.Tx, string, bool) error) error {
	may, err := c.Reaches(string(keys.WorkRequestResourceWorkRequest), string(keys.WorkRequestActionDecideFinal), id)
	if err != nil {
		return err
	}
	if !may {
		return apperror.ErrCommandRejected
	}
	for _, effect := range effects {
		if err := effect(c.Tx, id, true); err != nil {
			return err
		}
	}
	return approveSelf(c.Tx, id)
}
