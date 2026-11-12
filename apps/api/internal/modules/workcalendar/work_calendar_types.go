// Package workcalendar is the company work calendar (ADR-19): paid holidays and makeup days, one new
// calendar version per changed day.
package workcalendar

import "hrm/api/internal/modules/schedulecore"

// MakeupHours are the hours of a makeup day: those of AsWeekday, from the company schedule or each
// employee's frame.
type MakeupHours struct {
	AsWeekday   int                      `json:"asWeekday"`
	FrameSource schedulecore.FrameSource `json:"frameSource"`
}

// DayInput is one day's change. IsMakeup says which member the body carried: Makeup nil makes the day a
// day off again, Holiday nil works a holiday again.
type DayInput struct {
	ExpectedVersion string
	Date            string
	IsMakeup        bool
	Holiday         *string
	Makeup          *MakeupHours
}

// HolidaysInput is a holiday on every day of From..To (inclusive, at most 31 days) the company works.
type HolidaysInput struct {
	ExpectedVersion, From, To, Name string
}

type Holiday struct {
	Date string `json:"date"`
	Name string `json:"name"`
}

type MakeupDay struct {
	Date        string                   `json:"date"`
	AsWeekday   int                      `json:"asWeekday"`
	FrameSource schedulecore.FrameSource `json:"frameSource"`
}

// YearView is the calendar of one year at the current version; Version is int8 as text.
type YearView struct {
	Version    string      `json:"version"`
	Year       int         `json:"year"`
	Holidays   []Holiday   `json:"holidays"`
	MakeupDays []MakeupDay `json:"makeupDays"`
}

type VersionResult struct {
	Version string `json:"version"`
}
