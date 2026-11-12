package workschedule

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
)

// Operations are the working-hours queries and commands, to register with authority.New; Bind gives the
// facade that runs exactly these pointers.
type Operations struct {
	company       *authority.Query[none, CompanyScheduleView]
	putCompany    *authority.Command[CompanyScheduleInput, EffectiveResult]
	deleteCompany *authority.Command[string, EffectiveResult]
	frames        *authority.Query[string, FramesView]
	addFrame      *authority.Command[EmployeeFrameInput, IDResult]
	endFrame      *authority.Command[FrameKey, IDResult]
	days          *authority.Query[ScheduleQuery, ScheduleView]
}

func NewOperations() *Operations {
	calendar := string(keys.WorkCalendarResourceWorkCalendar)
	employee := string(keys.EmployeeResourceEmployee)
	manageSchedule, readSchedule := string(keys.EmployeeActionManageSchedule), string(keys.EmployeeActionReadSchedule)
	return &Operations{
		company:       authority.NewQuery(calendar, string(keys.WorkCalendarActionRead), func(none) string { return permission.WorkCalendarID }, readCompanySchedule),
		putCompany:    authority.NewCommand(calendar, string(keys.WorkCalendarActionManageSchedule), database.ModeWrite, func(CompanyScheduleInput) string { return permission.WorkCalendarID }, runPutCompanySchedule),
		deleteCompany: authority.NewCommand(calendar, string(keys.WorkCalendarActionManageSchedule), database.ModeWrite, func(string) string { return permission.WorkCalendarID }, runDeleteCompanySchedule),
		frames:        authority.NewQuery(employee, readSchedule, func(id string) string { return id }, readEmployeeFrames),
		addFrame:      authority.NewCommand(employee, manageSchedule, database.ModeWrite, func(i EmployeeFrameInput) string { return i.EmployeeID }, runAddEmployeeFrame),
		endFrame:      authority.NewCommand(employee, manageSchedule, database.ModeWrite, func(k FrameKey) string { return k.EmployeeID }, runEndEmployeeFrame),
		days:          authority.NewQuery(employee, readSchedule, func(q ScheduleQuery) string { return q.EmployeeID }, readEmployeeDays),
	}
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.company, o.putCompany, o.deleteCompany, o.frames, o.addFrame, o.endFrame, o.days}
}

// Service is the working-hours operations bound to the authority; it implements HTTPPort. A read or an
// employee write answers found=false for an absent or unreachable employee (404); the calendar anchor
// always exists, so not reaching it on a company write is a missing grant (403).
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}

func (s *Service) CompanySchedule(ctx context.Context, secret string) (CompanyScheduleView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.company, none{})
	return result.Value, result.Found, err
}

func (s *Service) PutCompanySchedule(ctx context.Context, secret string, input CompanyScheduleInput) (EffectiveResult, error) {
	return granted(authority.Execute(ctx, s.authorization, secret, s.operations.putCompany, input))
}

func (s *Service) DeleteCompanySchedule(ctx context.Context, secret, effectiveFrom string) (EffectiveResult, error) {
	return granted(authority.Execute(ctx, s.authorization, secret, s.operations.deleteCompany, effectiveFrom))
}

func (s *Service) EmployeeFrames(ctx context.Context, secret, employeeID string) (FramesView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.frames, employeeID)
	return result.Value, result.Found, err
}

func (s *Service) AddEmployeeFrame(ctx context.Context, secret string, input EmployeeFrameInput) (IDResult, bool, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.addFrame, input)
	return result.Value, result.Found, err
}

func (s *Service) EndEmployeeFrame(ctx context.Context, secret string, key FrameKey) (IDResult, bool, error) {
	result, err := authority.Execute(ctx, s.authorization, secret, s.operations.endFrame, key)
	return result.Value, result.Found, err
}

func (s *Service) EmployeeDays(ctx context.Context, secret string, query ScheduleQuery) (ScheduleView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.days, query)
	return result.Value, result.Found, err
}

func granted(result authority.CommandResult[EffectiveResult], err error) (EffectiveResult, error) {
	if err != nil {
		return EffectiveResult{}, err
	}
	if !result.Found {
		return EffectiveResult{}, apperror.ErrAccessDenied
	}
	return result.Value, nil
}
