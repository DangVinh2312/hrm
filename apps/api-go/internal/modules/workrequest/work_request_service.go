package workrequest

import (
	"context"
	"errors"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/database"
)

// Operations are the work request queries and the submit command, to register with authority.New; Bind
// gives the facade that runs exactly these pointers.
type Operations struct {
	effects      approvedEffects
	submitter    *authority.Query[struct{}, string]
	submit       *authority.Command[submitCommand, SubmitResult]
	ownRequests  *authority.Query[ListQuery, ListView]
	detail       *authority.Query[string, DetailView]
	leadRejected *authority.Query[string, DetailView]
}

func NewOperations() *Operations { return newOperations(productionEffects()) }

func newOperations(effects approvedEffects) *Operations {
	employee := string(keys.EmployeeResourceEmployee)
	submit := string(keys.EmployeeActionSubmitRequest)
	request := string(keys.WorkRequestResourceWorkRequest)
	byID := func(id string) string { return id }
	o := &Operations{effects: effects}
	o.submitter = authority.NewQuery(employee, submit, nil, readSubmitter)
	o.submit = authority.NewCommand(employee, submit, database.ModeWrite, func(c submitCommand) string { return c.EmployeeID }, o.runSubmit)
	o.ownRequests = authority.NewQuery(request, string(keys.WorkRequestActionRead), nil, readOwnRequests)
	o.detail = authority.NewQuery(request, string(keys.WorkRequestActionRead), byID, readDetail)
	o.leadRejected = authority.NewQuery(request, string(keys.WorkRequestActionReadLeadRejected), byID, readDetail)
	return o
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.submitter, o.submit, o.ownRequests, o.detail, o.leadRejected}
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
