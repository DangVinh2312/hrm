package schedulecore

import "errors"

// Shift is [start, end) in minutes of the day.
type Shift [2]int

// Frame is 0–3 shifts in increasing order; an empty frame is a day off.
type Frame []Shift

type ScheduleVersion struct {
	EffectiveFrom string
	// Days are seven frames, Monday first (index = ISO weekday − 1).
	Days []Frame
}

type EmployeeFrames struct {
	ValidFrom string
	// ValidTo is inclusive; nil has no end.
	ValidTo *string
	// Days by ISO weekday; a weekday not listed follows the company schedule.
	Days map[int]Frame
}

type FrameSource string

const (
	FrameSourceCompany  FrameSource = "company"
	FrameSourceEmployee FrameSource = "employee"
)

type MakeupDay struct {
	AsWeekday   int
	FrameSource FrameSource
}

type ScheduleFacts struct {
	// Versions are sorted by EffectiveFrom; the first one starts on or before every date asked.
	Versions []ScheduleVersion
	// Overrides are the frames of the one employee asked about, never overlapping.
	Overrides    []EmployeeFrames
	PaidHolidays map[string]bool
	MakeupDays   map[string]MakeupDay
}

type DayKind string

const (
	DayWorkday       DayKind = "workday"
	DayOff           DayKind = "off"
	DayPaidHoliday   DayKind = "paid_holiday"
	DayMakeupWorkday DayKind = "makeup_workday"
)

type DaySchedule struct {
	Kind DayKind
	// Frame is empty exactly when Kind is DayOff.
	Frame Frame
}

const (
	MaxShifts         = 3
	ShiftStepMinutes  = 5
	minutesInDay      = 1440
	minutesInFullHour = 60
)

// ErrNoScheduleVersion is facts that miss the version of a date: reading on would make it a day off.
var ErrNoScheduleVersion = errors.New("no schedule version covers the date")

func companyOn(date string, versions []ScheduleVersion) (ScheduleVersion, error) {
	found := -1
	for i, version := range versions {
		if version.EffectiveFrom <= date {
			found = i
		}
	}
	if found < 0 {
		return ScheduleVersion{}, ErrNoScheduleVersion
	}
	return versions[found], nil
}

func frameOf(version ScheduleVersion, weekday int) Frame {
	if weekday < 1 || weekday > len(version.Days) {
		return Frame{}
	}
	return version.Days[weekday-1]
}

// CompanyFrameOn is the company frame of ISO weekday in the version in force on date; empty is a day off.
func CompanyFrameOn(date string, weekday int, versions []ScheduleVersion) (Frame, error) {
	version, err := companyOn(date, versions)
	if err != nil {
		return nil, err
	}
	return frameOf(version, weekday), nil
}

// FrameOn is the schedule of date for the employee whose frames are in facts (ADR-19).
func FrameOn(date string, facts ScheduleFacts) (DaySchedule, error) {
	weekday, err := IsoWeekday(date)
	if err != nil {
		return DaySchedule{}, err
	}
	company, err := companyOn(date, facts.Versions)
	if err != nil {
		return DaySchedule{}, err
	}
	var own *EmployeeFrames
	for i := range facts.Overrides {
		o := &facts.Overrides[i]
		if o.ValidFrom <= date && (o.ValidTo == nil || date <= *o.ValidTo) {
			own = o
			break
		}
	}
	ownFrame := func(weekday int, base Frame) Frame {
		if own != nil {
			if frame, ok := own.Days[weekday]; ok {
				return frame
			}
		}
		return base
	}
	if makeup, ok := facts.MakeupDays[date]; ok {
		frame := frameOf(company, makeup.AsWeekday)
		if makeup.FrameSource == FrameSourceEmployee && len(frame) > 0 {
			frame = ownFrame(makeup.AsWeekday, frame)
		}
		if len(frame) == 0 {
			return DaySchedule{Kind: DayOff, Frame: Frame{}}, nil
		}
		return DaySchedule{Kind: DayMakeupWorkday, Frame: frame}, nil
	}
	base := frameOf(company, weekday)
	if len(base) == 0 {
		return DaySchedule{Kind: DayOff, Frame: Frame{}}, nil
	}
	kind := DayWorkday
	if facts.PaidHolidays[date] {
		kind = DayPaidHoliday
	}
	return DaySchedule{Kind: kind, Frame: ownFrame(weekday, base)}, nil
}

func FrameMinutes(frame Frame) int {
	total := 0
	for _, shift := range frame {
		total += shift[1] - shift[0]
	}
	return total
}

// OverlapMinutes is the minutes of [from, to) inside the frame.
func OverlapMinutes(frame Frame, from, to int) int {
	total := 0
	for _, shift := range frame {
		total += max(0, min(to, shift[1])-max(from, shift[0]))
	}
	return total
}

// IsValidFrame is a storable frame: at most MaxShifts shifts on the 5-minute grid inside one day, each
// non-empty, increasing with a gap between two shifts, totalling at most maxMinutes.
func IsValidFrame(frame Frame, maxMinutes int) bool {
	if len(frame) > MaxShifts {
		return false
	}
	previousEnd := -1
	for _, shift := range frame {
		start, end := shift[0], shift[1]
		if start%ShiftStepMinutes != 0 || end%ShiftStepMinutes != 0 || start <= previousEnd || start >= end || start < 0 || end > minutesInDay {
			return false
		}
		previousEnd = end
	}
	return FrameMinutes(frame) <= maxMinutes
}

func isLeaveEdge(frame Frame, minute int) bool {
	for _, shift := range frame {
		start, end := shift[0], shift[1]
		if minute == start || minute == end || (minute%minutesInFullHour == 0 && start < minute && minute < end) {
			return true
		}
	}
	return false
}

// LeaveMinutes is the working minutes of leave [start, end) on a day, refused when either edge is not a
// shift edge or a whole hour inside a shift, or when nothing is worked.
func LeaveMinutes(day DaySchedule, start, end int) (int, error) {
	if day.Kind == DayMakeupWorkday {
		return 0, WorkingTimeRejected{RejectMakeupDay}
	}
	if day.Kind != DayWorkday {
		return 0, WorkingTimeRejected{RejectNonWorkingDay}
	}
	if start >= end || !isLeaveEdge(day.Frame, start) || !isLeaveEdge(day.Frame, end) {
		return 0, WorkingTimeRejected{RejectInvalidSlot}
	}
	minutes := OverlapMinutes(day.Frame, start, end)
	if minutes == 0 {
		return 0, WorkingTimeRejected{RejectInvalidSlot}
	}
	return minutes, nil
}

// LateSegment is the booked part of a late arrival at expected, from the start of its shift. Arriving at a
// shift's end is late for that whole shift, except for the last shift. False when expected is in no shift.
func LateSegment(frame Frame, expected int) (Shift, bool) {
	if len(frame) == 0 || expected >= frame[len(frame)-1][1] {
		return Shift{}, false
	}
	for _, shift := range frame {
		if shift[0] < expected && expected <= shift[1] {
			return Shift{shift[0], expected}, true
		}
	}
	return Shift{}, false
}

// EarlySegment is the booked part of an early departure at expected, up to the end of its shift.
func EarlySegment(frame Frame, expected int) (Shift, bool) {
	for _, shift := range frame {
		if shift[0] < expected && expected < shift[1] {
			return Shift{expected, shift[1]}, true
		}
	}
	return Shift{}, false
}

type WfhSpan struct {
	Start, End, Minutes int
}

// WfhSegment is a WFH day over the whole frame: from the first shift's start to the last shift's end.
func WfhSegment(frame Frame) (WfhSpan, bool) {
	if len(frame) == 0 {
		return WfhSpan{}, false
	}
	return WfhSpan{Start: frame[0][0], End: frame[len(frame)-1][1], Minutes: FrameMinutes(frame)}, true
}
