package workrequest

import (
	"hrm/api-go/internal/database"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/leavecore"
)

// effectPart is one effect of an approval, written in the approving transaction.
type effectPart string

const (
	effectLeave      effectPart = "leave"
	effectWfh        effectPart = "wfh"
	effectAttendance effectPart = "attendance"
)

// approvedEffects are the effect handlers fixed at boot. A kind is open only when every part it needs has
// a handler; a composition without one refuses that kind before anything is written (fail closed).
// acknowledged is the approver's D04 acknowledgement of the WFH limit.
type approvedEffects map[effectPart]func(tx *database.Tx, requestID string, acknowledged bool) error

// requiredEffects are the parts of each kind in lock order: the bucket or counter before the period.
var requiredEffects = map[hrbase.RequestKind][]effectPart{
	hrbase.RequestAnnualLeave:    {effectLeave, effectAttendance},
	hrbase.RequestUnpaidLeave:    {effectAttendance},
	hrbase.RequestWfh:            {effectWfh, effectAttendance},
	hrbase.RequestLateArrival:    {effectAttendance},
	hrbase.RequestEarlyDeparture: {effectAttendance},
}

// productionEffects registers all three parts, so every kind is open.
func productionEffects() approvedEffects {
	return approvedEffects{
		effectLeave:      func(tx *database.Tx, id string, _ bool) error { return leavecore.ApplyApproved(tx, id) },
		effectWfh:        attendancecore.ApplyApprovedWfh,
		effectAttendance: func(tx *database.Tx, id string, _ bool) error { return attendancecore.ApplyApprovedAttendance(tx, id) },
	}
}

// effectsOf are the handlers of kind in order, or false when one is missing.
func (e approvedEffects) effectsOf(kind hrbase.RequestKind) ([]func(*database.Tx, string, bool) error, bool) {
	parts := requiredEffects[kind]
	handlers := make([]func(*database.Tx, string, bool) error, 0, len(parts))
	for _, part := range parts {
		handler, ok := e[part]
		if !ok || handler == nil {
			return nil, false
		}
		handlers = append(handlers, handler)
	}
	return handlers, len(parts) > 0
}
