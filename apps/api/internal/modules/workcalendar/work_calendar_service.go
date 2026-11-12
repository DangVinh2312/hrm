package workcalendar

import (
	"context"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/database"
	"hrm/api/internal/modules/permission"
)

// Operations are the calendar query and commands, to register with authority.New; Bind gives the facade
// that runs exactly these pointers.
type Operations struct {
	year        *authority.Query[int, YearView]
	setDay      *authority.Command[DayInput, VersionResult]
	setHolidays *authority.Command[HolidaysInput, VersionResult]
}

func NewOperations() *Operations {
	resource := string(keys.WorkCalendarResourceWorkCalendar)
	return &Operations{
		year:        authority.NewQuery(resource, string(keys.WorkCalendarActionRead), func(int) string { return permission.WorkCalendarID }, readYear),
		setDay:      authority.NewCommand(resource, string(keys.WorkCalendarActionManage), database.ModeWrite, func(DayInput) string { return permission.WorkCalendarID }, runSetDay),
		setHolidays: authority.NewCommand(resource, string(keys.WorkCalendarActionManage), database.ModeWrite, func(HolidaysInput) string { return permission.WorkCalendarID }, runSetHolidays),
	}
}

func (o *Operations) All() []authority.Operation {
	return []authority.Operation{o.year, o.setDay, o.setHolidays}
}

// Service is the calendar operations bound to the authority; it implements HTTPPort.
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}

// Year answers found=false when the plan of the caller does not reach the calendar (no HR role): 404.
func (s *Service) Year(ctx context.Context, secret string, year int) (YearView, bool, error) {
	result, err := authority.Read(ctx, s.authorization, secret, s.operations.year, year)
	return result.Value, result.Found, err
}

// SetDay: the calendar anchor always exists, so a command that does not reach it means no grant (403).
func (s *Service) SetDay(ctx context.Context, secret string, input DayInput) (VersionResult, error) {
	return changed(authority.Execute(ctx, s.authorization, secret, s.operations.setDay, input))
}

func (s *Service) SetHolidays(ctx context.Context, secret string, input HolidaysInput) (VersionResult, error) {
	return changed(authority.Execute(ctx, s.authorization, secret, s.operations.setHolidays, input))
}

func changed(result authority.CommandResult[VersionResult], err error) (VersionResult, error) {
	if err != nil {
		return VersionResult{}, err
	}
	if !result.Found {
		return VersionResult{}, apperror.ErrAccessDenied
	}
	return result.Value, nil
}
