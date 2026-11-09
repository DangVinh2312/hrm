package workrequest

import (
	"context"
	"errors"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/hrbase"
)

// Operations are the work request queries and commands, to register with authority.New; Bind gives the
// facade that runs exactly these pointers.
type Operations struct {
	effects       ApprovedEffects
	submitter     *authority.Query[struct{}, string]
	submit        *authority.Command[submitCommand, SubmitResult]
	ownRequests   *authority.Query[ListQuery, ListView]
	detail        *authority.Query[string, DetailView]
	leadRejected  *authority.Query[string, DetailView]
	decisionFacts *authority.Query[decideCommand, decisionFacts]
	decideLead    *authority.Command[decideCommand, SubmitResult]
	decideFinal   *authority.Command[decideCommand, SubmitResult]
	leadQueue     *authority.Query[ListQuery, ApprovalView]
	finalQueue    *authority.Query[ListQuery, ApprovalView]
	decided       *authority.Query[ListQuery, DecidedView]
}

func NewOperations() *Operations { return newOperations(createApprovedEffects()) }

func newOperations(effects ApprovedEffects) *Operations {
	employee := string(keys.EmployeeResourceEmployee)
	submit := string(keys.EmployeeActionSubmitRequest)
	request := string(keys.WorkRequestResourceWorkRequest)
	read, lead, final := string(keys.WorkRequestActionRead), string(keys.WorkRequestActionDecideLead), string(keys.WorkRequestActionDecideFinal)
	byID := func(id string) string { return id }
	byRequest := func(c decideCommand) string { return c.RequestID }
	o := &Operations{effects: effects}
	o.submitter = authority.NewQuery(employee, submit, nil, readSubmitter)
	o.submit = authority.NewCommand(employee, submit, database.ModeWrite, func(c submitCommand) string { return c.EmployeeID }, o.runSubmit)
	o.ownRequests = authority.NewQuery(request, read, nil, readOwnRequests)
	o.detail = authority.NewQuery(request, read, byID, readDetail)
	o.leadRejected = authority.NewQuery(request, string(keys.WorkRequestActionReadLeadRejected), byID, readDetail)
	o.decisionFacts = authority.NewQuery(request, read, byRequest, readDecisionFacts)
	o.decideLead = authority.NewCommand(request, lead, database.ModeWrite, byRequest, o.runDecision(stageLead))
	o.decideFinal = authority.NewCommand(request, final, database.ModeWrite, byRequest, o.runDecision(stageFinal))
	o.leadQueue = authority.NewQuery(request, lead, nil, readQueue(stageLead))
	o.finalQueue = authority.NewQuery(request, final, nil, readQueue(stageFinal))
	o.decided = authority.NewQuery(request, string(keys.WorkRequestActionReadDecided), nil, readDecided)
	return o
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.submitter, o.submit, o.ownRequests, o.detail, o.leadRejected, o.decisionFacts, o.decideLead, o.decideFinal, o.leadQueue, o.finalQueue, o.decided}
}

// Service is the work request operations bound to the authority; it implements HTTPPort.
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}

// Submit is not found (404) without an own profile reachable through employee.submitRequest (no role, no
// profile, Root). A retry of a committed key answers its stored result after the plan reached the
// employee again.
func (s *Service) Submit(ctx context.Context, secret string, input SubmitInput) (SubmitResult, error) {
	employee, err := authority.Read(ctx, s.authorization, secret, s.operations.submitter, struct{}{})
	if err != nil {
		return SubmitResult{}, err
	}
	if !employee.Found {
		return SubmitResult{}, apperror.ErrNotFound
	}
	hash, err := payloadHash(input)
	if err != nil {
		return SubmitResult{}, err
	}
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.submit, submitCommand{SubmitInput: input, EmployeeID: employee.Value, Hash: hash})
	if _, ok := errors.AsType[submitterNotFound](err); ok {
		return SubmitResult{}, apperror.ErrNotFound
	}
	if err != nil {
		return SubmitResult{}, err
	}
	if !result.Found {
		return SubmitResult{}, apperror.ErrNotFound
	}
	return result.Value, nil
}

func (s *Service) List(ctx context.Context, secret string, query ListQuery) (ListView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.ownRequests, query)
	return result.Value, err
}

// Detail is workRequest.read, else the COO's readLeadRejected (an empty plan for everyone else); absent and
// unreadable are both found=false (404).
func (s *Service) Detail(ctx context.Context, secret, requestID string) (DetailView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.detail, requestID)
	if err != nil || result.Found {
		return result.Value, result.Found, err
	}
	result, err = authority.Read(ctx, s.authorization, secret, s.operations.leadRejected, requestID)
	return result.Value, result.Found, err
}

// Decide approves or rejects at the request's current stage. The stage comes from the stored state, never
// from the caller: the state and any claim of this key are read under workRequest.read, then that stage's
// command rechecks everything on the locked row. found=false is absent, unreadable, or a stage the caller
// may not decide (404). A replay rechecks a current read of the request, so it answers after the request
// moved on.
func (s *Service) Decide(ctx context.Context, secret string, input DecisionInput) (SubmitResult, bool, error) {
	hash, err := decisionHash(input)
	if err != nil {
		return SubmitResult{}, false, err
	}
	command := decideCommand{DecisionInput: input, Hash: hash}
	seen, err := authority.Read(ctx, s.authorization, secret, s.operations.decisionFacts, command)
	if err != nil || !seen.Found {
		return SubmitResult{}, false, err
	}
	if answer, done, err := settled(seen.Value, command); done {
		return answer, true, err
	}
	stages := map[string]*authority.Command[decideCommand, SubmitResult]{statePendingLead: s.operations.decideLead, statePendingFinal: s.operations.decideFinal}
	stage, ok := stages[seen.Value.State]
	if !ok {
		return SubmitResult{}, false, apperror.ErrCommandRejected
	}
	result, err := authority.Execute(ctx, s.authorization, secret, stage, command)
	if err != nil || result.Found {
		return result.Value, result.Found, err
	}
	// The plan missed the locked row: the caller may not decide this stage, or a concurrent decision moved
	// the request on (then this key is a replay, another key a stale version).
	again, err := authority.Read(ctx, s.authorization, secret, s.operations.decisionFacts, command)
	if err != nil || !again.Found {
		return SubmitResult{}, false, err
	}
	if answer, done, err := settled(again.Value, command); done {
		return answer, true, err
	}
	return SubmitResult{}, false, nil
}

// settled answers a committed claim of the key, or refuses a version that moved on.
func settled(facts decisionFacts, command decideCommand) (SubmitResult, bool, error) {
	if facts.Prior != nil {
		result, err := hrbase.Replay(*facts.Prior, command.Hash)
		return result, true, err
	}
	if facts.Version != command.ExpectedVersion {
		return SubmitResult{}, true, apperror.ErrCommandRejected
	}
	return SubmitResult{}, false, nil
}

func (s *Service) LeadQueue(ctx context.Context, secret string, query ListQuery) (ApprovalView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.leadQueue, query)
	return result.Value, err
}

func (s *Service) FinalQueue(ctx context.Context, secret string, query ListQuery) (ApprovalView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.finalQueue, query)
	return result.Value, err
}

func (s *Service) Decided(ctx context.Context, secret string, query ListQuery) (DecidedView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.decided, query)
	return result.Value, err
}
