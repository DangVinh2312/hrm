package leave

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/leavecore"
)

// Operations are the leave queries and the adjustment, to register with authority.New; Bind gives the facade
// that runs exactly these pointers.
type Operations struct {
	balance        *authority.Query[BalanceQuery, leavecore.BalanceView]
	reconciliation *authority.Query[ReconciliationQuery, ReconciliationView]
	adjust         *authority.Command[adjustCommand, AdjustmentResult]
}

func NewOperations() *Operations {
	resource := string(keys.EmployeeResourceEmployee)
	read := string(keys.EmployeeActionReadLeaveBalance)
	return &Operations{
		balance:        authority.NewQuery(resource, read, func(q BalanceQuery) string { return q.EmployeeID }, readBalance),
		reconciliation: authority.NewQuery(resource, read, nil, readReconciliation),
		adjust:         authority.NewCommand(resource, string(keys.EmployeeActionAdjustLeaveBalance), database.ModeWrite, func(c adjustCommand) string { return c.EmployeeID }, runAdjust),
	}
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.balance, o.reconciliation, o.adjust}
}

// Service is the leave operations bound to the authority; it implements HTTPPort.
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}

// Balance answers found=false for an absent employee or one outside the caller's scope (404).
func (s *Service) Balance(ctx context.Context, secret string, query BalanceQuery) (leavecore.BalanceView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.balance, query)
	return result.Value, result.Found, err
}

func (s *Service) Reconciliation(ctx context.Context, secret string, query ReconciliationQuery) (ReconciliationView, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.reconciliation, query)
	return result.Value, err
}

// Adjust is not found (404) for an absent employee or one outside the plan. A retry of a committed key
// answers its stored result, after the plan reached the employee again.
func (s *Service) Adjust(ctx context.Context, secret string, input AdjustmentInput) (AdjustmentResult, error) {
	hash, err := adjustmentHash(input)
	if err != nil {
		return AdjustmentResult{}, err
	}
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.adjust, adjustCommand{AdjustmentInput: input, Hash: hash})
	if err != nil {
		return AdjustmentResult{}, err
	}
	if !result.Found {
		return AdjustmentResult{}, apperror.ErrNotFound
	}
	return result.Value, nil
}
