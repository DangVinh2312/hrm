// Package attendance is the attendance routes (T8): the monthly sheet of one employee (D05), HR's close and
// reopen of a month (D07) and HR's signed paid-minutes adjustments. The rules themselves live in
// attendancecore.
package attendance

import "hrm/api/internal/modules/attendancecore"

// SheetQuery is GET …/employees/:id/attendance; Month nil is the current business month by the DB clock.
type SheetQuery struct {
	EmployeeID string
	Month      *string
}

// SheetView is the monthly sheet of one employee in minutes and counts, with the month's close state.
type SheetView struct {
	EmployeeID  string                     `json:"employeeId"`
	Month       string                     `json:"month"`
	PeriodState attendancecore.PeriodState `json:"periodState"`
	attendancecore.Totals
}

type PeriodEventKind string

const (
	PeriodEventClose  PeriodEventKind = "close"
	PeriodEventReopen PeriodEventKind = "reopen"
)

// PeriodEvent is one close or reopen of a month; a reopen always has its reason.
type PeriodEvent struct {
	Event PeriodEventKind `json:"event"`
	// Version is the int8 period version this event produced, as a decimal string.
	Version    string  `json:"version"`
	Reason     *string `json:"reason"`
	OccurredAt string  `json:"occurredAt"`
}

// PeriodHistory is GET /api/hr/attendance/periods/:month: the close state and at most 50 events, newest first.
type PeriodHistory struct {
	Month   string                     `json:"month"`
	State   attendancecore.PeriodState `json:"state"`
	Version string                     `json:"version"`
	Events  []PeriodEvent              `json:"events"`
}

// ReopenInput is POST …/periods/:month/reopen; the close takes the month only.
type ReopenInput struct {
	Month string
	// Reason is 1..1000 code points, trimmed.
	Reason string
}

// PeriodResult is the response of a close or reopen.
type PeriodResult struct {
	Month   string                     `json:"month"`
	State   attendancecore.PeriodState `json:"state"`
	Version string                     `json:"version"`
}

// AdjustmentInput is one signed paid-minutes entry of the employee in the path on one day.
type AdjustmentInput struct {
	EmployeeID     string
	IdempotencyKey string
	WorkDate       string
	// Minutes is signed, non-zero, within ±1440 (the table CHECK).
	Minutes int
	// Reason is 1..300 code points, trimmed; never audited or logged.
	Reason string
	// Reference is nil when omitted, else as sent: 1..64 letters, digits and ` . _ / # : -`.
	Reference *string
}

// AdjustmentResult is the stored idempotency result and the response: the new entry's id only.
type AdjustmentResult struct {
	ID string `json:"id"`
}

// AdjustmentQuery is GET …/employees/:id/attendance-adjustments?month=YYYY-MM[&limit=&offset=].
type AdjustmentQuery struct {
	EmployeeID    string
	Month         string
	Limit, Offset int
}

type AdjustmentItem struct {
	ID        string  `json:"id"`
	WorkDate  string  `json:"workDate"`
	Minutes   int     `json:"minutes"`
	Reason    string  `json:"reason"`
	Reference *string `json:"reference"`
	CreatedAt string  `json:"createdAt"`
}

// AdjustmentList is the entries of one month, newest day first; AdjustmentMinutes is their signed sum as the
// sheet includes it and Total counts them all (decimal string).
type AdjustmentList struct {
	EmployeeID        string                     `json:"employeeId"`
	Month             string                     `json:"month"`
	PeriodState       attendancecore.PeriodState `json:"periodState"`
	AdjustmentMinutes int                        `json:"adjustmentMinutes"`
	Total             string                     `json:"total"`
	Items             []AdjustmentItem           `json:"items"`
}
