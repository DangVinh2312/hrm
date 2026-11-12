package attendance

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
)

// Operations are the attendance queries and commands, to register with authority.New; Bind gives the facade
// that runs exactly these pointers.
type Operations struct {
	sheet       *authority.Query[SheetQuery, SheetView]
	periodState *authority.Query[string, PeriodHistory]
	adjustments *authority.Query[AdjustmentQuery, AdjustmentList]
	close       *authority.Command[string, PeriodResult]
	reopen      *authority.Command[ReopenInput, PeriodResult]
	adjust      *authority.Command[adjustCommand, AdjustmentResult]
}

func NewOperations() *Operations {
	employee, company := string(keys.EmployeeResourceEmployee), string(keys.CompanyResourceCompany)
	manage := string(keys.CompanyActionManagePeriod)
	return &Operations{
		sheet:       authority.NewQuery(employee, string(keys.EmployeeActionReadAttendance), func(q SheetQuery) string { return q.EmployeeID }, readSheet),
		periodState: authority.NewQuery(company, string(keys.CompanyActionRead), func(string) string { return permission.CompanyID }, readPeriodState),
		adjustments: authority.NewQuery(employee, string(keys.EmployeeActionReadAttendanceAdjustment), func(q AdjustmentQuery) string { return q.EmployeeID }, readAdjustments),
		close:       authority.NewCommand(company, manage, database.ModeWrite, func(string) string { return permission.CompanyID }, runClose),
		reopen:      authority.NewCommand(company, manage, database.ModeWrite, func(ReopenInput) string { return permission.CompanyID }, runReopen),
		adjust:      authority.NewCommand(employee, string(keys.EmployeeActionAdjustAttendance), database.ModeWrite, func(c adjustCommand) string { return c.EmployeeID }, runAdjust),
	}
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.sheet, o.periodState, o.adjustments, o.close, o.reopen, o.adjust}
}

// Service is the attendance operations bound to the authority.
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}

// Sheet answers found=false for an absent employee or one outside the caller's scope (404).
func (s *Service) Sheet(ctx context.Context, secret string, query SheetQuery) (SheetView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.sheet, query)
	return result.Value, result.Found, err
}

// PeriodState answers found=false when the caller does not read the company row (404).
func (s *Service) PeriodState(ctx context.Context, secret, month string) (PeriodHistory, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.periodState, month)
	return result.Value, result.Found, err
}

// Adjustments answers found=false for an absent employee or one outside the caller's scope (404).
func (s *Service) Adjustments(ctx context.Context, secret string, query AdjustmentQuery) (AdjustmentList, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.adjustments, query)
	return result.Value, result.Found, err
}

// ClosePeriod: the company anchor always exists, so a command that does not reach it means no grant (403).
func (s *Service) ClosePeriod(ctx context.Context, secret, month string) (PeriodResult, error) {
	return granted(authority.Execute(ctx, s.authorization, secret, s.operations.close, month))
}

func (s *Service) ReopenPeriod(ctx context.Context, secret string, input ReopenInput) (PeriodResult, error) {
	return granted(authority.Execute(ctx, s.authorization, secret, s.operations.reopen, input))
}

func granted(result authority.CommandResult[PeriodResult], err error) (PeriodResult, error) {
	if err != nil {
		return PeriodResult{}, err
	}
	if !result.Found {
		return PeriodResult{}, apperror.ErrAccessDenied
	}
	return result.Value, nil
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
