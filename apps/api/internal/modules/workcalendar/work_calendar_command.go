package workcalendar

import (
	"fmt"

	"hrm/api/internal/apperror"
	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/modules/attendancecore"
	"hrm/api/internal/modules/schedulecore"
)

const (
	kindStandard    = "standard"
	kindPaidHoliday = "paid_holiday"
	kindMakeup      = "makeup_workday"
)

var (
	errStaleVersion = fmt.Errorf("stale calendar version: %w", apperror.ErrCommandRejected)
	errUnchanged    = fmt.Errorf("calendar unchanged: %w", apperror.ErrCommandRejected)
)

func calendarTarget(c authority.CommandContext) authority.AuditTarget {
	return authority.AuditTarget{Resource: string(keys.WorkCalendarResourceWorkCalendar), Key: c.Target.Key, ObjectID: c.Target.ObjectID}
}

func equalText(stored, want *string) bool {
	return (stored == nil && want == nil) || (stored != nil && want != nil && *stored == *want)
}

func sameMakeup(day storedDay, makeup *MakeupHours) bool {
	if makeup == nil {
		return day.AsWeekday == nil && day.FrameSource == nil
	}
	return day.AsWeekday != nil && *day.AsWeekday == makeup.AsWeekday && day.FrameSource != nil && *day.FrameSource == string(makeup.FrameSource)
}

// checkMakeup: a makeup day works a day the schedule has off, with the hours of a weekday it works. The
// schedule versions are written under the calendar row lock the command holds, so they cannot change here.
func checkMakeup(c authority.CommandContext, date string, makeup MakeupHours) error {
	versions, err := versionsBetween(c.Tx, date, date)
	if err != nil {
		return err
	}
	weekday, err := schedulecore.IsoWeekday(date)
	if err != nil {
		return apperror.ErrInvalidRequest
	}
	works, err := companyWorks(date, weekday, versions)
	if err != nil {
		return err
	}
	borrowed, err := companyWorks(date, makeup.AsWeekday, versions)
	if err != nil {
		return err
	}
	if works || !borrowed {
		return apperror.ErrInvalidRequest
	}
	return nil
}

// runSetDay is one change, one new version, optimistic on ExpectedVersion. Execute already holds the
// calendar row FOR NO KEY UPDATE, so concurrent changes serialize and the later one sees a stale version.
// A day of a closed attendance month is refused (409 error.periodClosed) and the month stays locked FOR
// SHARE until commit, after the calendar row: a close takes the company row and the period, never the
// calendar, so the order makes no cycle.
func runSetDay(c authority.CommandContext, input DayInput) (VersionResult, error) {
	kind, name := kindStandard, (*string)(nil)
	switch {
	case input.Makeup != nil:
		kind = kindMakeup
	case !input.IsMakeup && input.Holiday != nil:
		kind, name = kindPaidHoliday, input.Holiday
	}
	if input.Makeup != nil {
		if err := checkMakeup(c, input.Date, *input.Makeup); err != nil {
			return VersionResult{}, err
		}
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, []string{input.Date}); err != nil {
		return VersionResult{}, err
	}
	current, err := currentDay(c.Tx, c.Target.Key, input.Date)
	if err != nil {
		return VersionResult{}, err
	}
	if len(current) != 1 || current[0].Version != input.ExpectedVersion {
		return VersionResult{}, errStaleVersion
	}
	day := current[0]
	// A holiday and a makeup day can share a date: clearing one never clears the other.
	clearing := ""
	switch {
	case input.IsMakeup && input.Makeup == nil:
		clearing = kindMakeup
	case !input.IsMakeup && input.Holiday == nil:
		clearing = kindPaidHoliday
	}
	if clearing != "" && day.Kind != clearing {
		return VersionResult{}, errUnchanged
	}
	if day.Kind == kind && equalText(day.Name, name) && sameMakeup(day, input.Makeup) {
		return VersionResult{}, errUnchanged
	}
	version, err := writeDay(c.Tx, c.Target.Key, input.Date, kind, name, input.Makeup)
	if err != nil {
		return VersionResult{}, err
	}
	if err := c.Audit(audit.KindHRWorkCalendarUpdate, calendarTarget(c), nil); err != nil {
		return VersionResult{}, err
	}
	return VersionResult{Version: version}, nil
}

// runSetHolidays is a holiday range in one transaction and one audit, one version per changed day the
// company works, consecutive in date order so every earlier version stays exact. Same lock order as
// runSetDay; at most two months for 31 days. Days that already are this holiday are left alone; nothing to
// change is unchanged, and a closed month refuses the whole range.
func runSetHolidays(c authority.CommandContext, input HolidaysInput) (VersionResult, error) {
	versions, err := versionsBetween(c.Tx, input.From, input.To)
	if err != nil {
		return VersionResult{}, err
	}
	workdays := []string{}
	for _, day := range schedulecore.DatesBetween(input.From, input.To, schedulecore.MaxHolidayRangeDays) {
		weekday, err := schedulecore.IsoWeekday(day)
		if err != nil {
			return VersionResult{}, apperror.ErrInvalidRequest
		}
		works, err := companyWorks(day, weekday, versions)
		if err != nil {
			return VersionResult{}, err
		}
		if works {
			workdays = append(workdays, day)
		}
	}
	if len(workdays) == 0 {
		return VersionResult{}, errUnchanged
	}
	if err := attendancecore.AssertPeriodsOpen(c.Tx, workdays); err != nil {
		return VersionResult{}, err
	}
	current, err := currentDays(c.Tx, c.Target.Key, workdays)
	if err != nil {
		return VersionResult{}, err
	}
	if len(current) == 0 || current[0].Version != input.ExpectedVersion {
		return VersionResult{}, errStaleVersion
	}
	changing := []string{}
	for _, row := range current {
		if row.Kind != kindPaidHoliday || row.Name == nil || *row.Name != input.Name {
			changing = append(changing, row.Day)
		}
	}
	if len(changing) == 0 {
		return VersionResult{}, errUnchanged
	}
	version, err := writeHolidays(c.Tx, c.Target.Key, changing, input.Name)
	if err != nil {
		return VersionResult{}, err
	}
	if err := c.Audit(audit.KindHRWorkCalendarUpdate, calendarTarget(c), nil); err != nil {
		return VersionResult{}, err
	}
	return VersionResult{Version: version}, nil
}
