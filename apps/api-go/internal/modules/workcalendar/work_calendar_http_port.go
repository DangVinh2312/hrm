package workcalendar

import "context"

// HTTPPort is the bound calendar operations; a read answers found=false for 404.
type HTTPPort interface {
	Year(ctx context.Context, secret string, year int) (YearView, bool, error)
	SetDay(ctx context.Context, secret string, input DayInput) (VersionResult, error)
	SetHolidays(ctx context.Context, secret string, input HolidaysInput) (VersionResult, error)
}
