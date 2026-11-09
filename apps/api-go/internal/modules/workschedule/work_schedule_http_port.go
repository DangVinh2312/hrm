package workschedule

import "context"

// HTTPPort is the bound working-hours operations; found=false is 404.
type HTTPPort interface {
	CompanySchedule(ctx context.Context, secret string) (CompanyScheduleView, bool, error)
	PutCompanySchedule(ctx context.Context, secret string, input CompanyScheduleInput) (EffectiveResult, error)
	DeleteCompanySchedule(ctx context.Context, secret, effectiveFrom string) (EffectiveResult, error)
	EmployeeFrames(ctx context.Context, secret, employeeID string) (FramesView, bool, error)
	AddEmployeeFrame(ctx context.Context, secret string, input EmployeeFrameInput) (IDResult, bool, error)
	EndEmployeeFrame(ctx context.Context, secret string, key FrameKey) (IDResult, bool, error)
	EmployeeDays(ctx context.Context, secret string, query ScheduleQuery) (ScheduleView, bool, error)
}
