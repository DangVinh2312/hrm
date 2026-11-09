// Package workschedule is the working hours of ADR-19: the company schedule versions and each employee's
// own frames, and the hours a day gets.
package workschedule

import "hrm/api-go/internal/modules/schedulecore"

// CompanyScheduleInput is a version from a date after today: seven frames, Monday first.
type CompanyScheduleInput struct {
	EffectiveFrom string
	Days          []schedulecore.Frame
}

type CompanyScheduleVersion struct {
	EffectiveFrom string               `json:"effectiveFrom"`
	Days          []schedulecore.Frame `json:"days"`
}

// CompanyScheduleView is the version in force today and every later one; Today is the DB business date.
type CompanyScheduleView struct {
	Today      string                   `json:"today"`
	MaxMinutes int64                    `json:"maxMinutes"`
	Versions   []CompanyScheduleVersion `json:"versions"`
}

type EffectiveResult struct {
	EffectiveFrom string `json:"effectiveFrom"`
}

// EmployeeFrameInput is own hours from ValidFrom (after today); ValidTo nil has no end. An empty weekday
// keeps the company's hours.
type EmployeeFrameInput struct {
	EmployeeID string
	ValidFrom  string
	ValidTo    *string
	Days       []schedulecore.Frame
}

type FrameKey struct {
	EmployeeID, FrameID string
}

type FrameView struct {
	ID        string               `json:"id"`
	ValidFrom string               `json:"validFrom"`
	ValidTo   *string              `json:"validTo"`
	Days      []schedulecore.Frame `json:"days"`
}

// FramesView is the frames that end today or later.
type FramesView struct {
	Today      string      `json:"today"`
	MaxMinutes int64       `json:"maxMinutes"`
	Frames     []FrameView `json:"frames"`
}

type IDResult struct {
	ID string `json:"id"`
}

type ScheduleQuery struct {
	EmployeeID, From, To string
}

type ScheduleDay struct {
	Date   string               `json:"date"`
	Kind   schedulecore.DayKind `json:"kind"`
	Shifts schedulecore.Frame   `json:"shifts"`
}

// ScheduleView is the hours of each day of the range as requests and attendance see them now.
type ScheduleView struct {
	EmployeeID string        `json:"employeeId"`
	Days       []ScheduleDay `json:"days"`
}
