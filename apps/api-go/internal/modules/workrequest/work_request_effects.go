package workrequest

import (
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/leavecore"
)

// effect is one part of an approval, written in the approving transaction after the request lock;
// acknowledged is the approver's D04 acknowledgement of the WFH limit.
type effect = func(tx *database.Tx, requestID string, acknowledged bool) error

// ApprovedEffects are the effect handlers fixed at boot. A kind is open only when every part it needs has a
// handler; a composition without one refuses that kind before anything is written (fail closed).
type ApprovedEffects struct {
	Leave, Wfh, Attendance effect
}

type effectPart string

const (
	effectLeave      effectPart = "leave"
	effectWfh        effectPart = "wfh"
	effectAttendance effectPart = "attendance"
)

// requiredEffects are the parts of each kind in lock order: the bucket or counter before the period.
var requiredEffects = map[hrbase.RequestKind][]effectPart{
	hrbase.RequestAnnualLeave:    {effectLeave, effectAttendance},
	hrbase.RequestUnpaidLeave:    {effectAttendance},
	hrbase.RequestWfh:            {effectWfh, effectAttendance},
	hrbase.RequestLateArrival:    {effectAttendance},
	hrbase.RequestEarlyDeparture: {effectAttendance},
}

// createApprovedEffects registers all three parts, so every kind is open.
func createApprovedEffects() ApprovedEffects {
	return ApprovedEffects{
		Leave:      func(tx *database.Tx, id string, _ bool) error { return leavecore.ApplyApproved(tx, id) },
		Wfh:        attendancecore.ApplyApprovedWfh,
		Attendance: func(tx *database.Tx, id string, _ bool) error { return attendancecore.ApplyApprovedAttendance(tx, id) },
	}
}

// effectsOf are the handlers of kind in order, or false when one is missing.
func (e ApprovedEffects) effectsOf(kind hrbase.RequestKind) ([]effect, bool) {
	parts := requiredEffects[kind]
	handlers := make([]effect, 0, len(parts))
	for _, part := range parts {
		handler := map[effectPart]effect{effectLeave: e.Leave, effectWfh: e.Wfh, effectAttendance: e.Attendance}[part]
		if handler == nil {
			return nil, false
		}
		handlers = append(handlers, handler)
	}
	return handlers, len(parts) > 0
}
