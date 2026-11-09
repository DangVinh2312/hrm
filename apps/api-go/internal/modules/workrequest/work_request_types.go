// Package workrequest is the work request routes (T5): an employee submits a request for their own
// profile, lists their own requests and reads one request in the plan of workRequest.read.
package workrequest

import "hrm/api-go/internal/modules/hrbase"

const (
	statePendingLead  = "pending_lead"
	statePendingFinal = "pending_final"
	stateApproved     = "approved"
	stateRejected     = "rejected"
	stateCancelled    = "cancelled"

	decisionApprove = "approve"
	decisionReject  = "reject"

	systemLeadSkipped     = "lead_skipped_submitter_is_lead"
	systemCooSelfApproved = "coo_self_approved"

	statusProbation = "probation"
	statusOfficial  = "official"
)

// Slot is one leave interval [StartMinute, EndMinute) of a business date.
type Slot struct {
	Date        string `json:"date"`
	StartMinute int    `json:"startMinute"`
	EndMinute   int    `json:"endMinute"`
}

// SubmitInput is the validated body of POST /api/hr/requests and its key. Only the fields of Kind are set:
// Date and ExpectedMinute for late/early, Dates for WFH, Segments for leave; lists are sorted and unique.
type SubmitInput struct {
	IdempotencyKey string
	Kind           hrbase.RequestKind
	// TeamID nil is the submitter's current primary team.
	TeamID         *string
	Reason         string
	Date           string
	ExpectedMinute int
	Dates          []string
	Segments       []Slot
}

// SubmitResult is the response and the stored idempotency result: ids and state only.
type SubmitResult struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	Version string `json:"version"`
	// WfhLimitExceeded is set for a WFH request only: a warning, never a refusal.
	WfhLimitExceeded *bool `json:"wfhLimitExceeded,omitzero"`
}

type ListQuery struct {
	Limit, Offset int
}

// Segment is [StartMinute, EndMinute) of one business date and its working minutes.
type Segment struct {
	Date        string `json:"date"`
	StartMinute int    `json:"startMinute"`
	EndMinute   int    `json:"endMinute"`
	Minutes     int    `json:"minutes"`
}

type RequestSummary struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
	Version   string `json:"version"`
	TeamID    string `json:"teamId"`
	CreatedAt string `json:"createdAt"`
	StartDate string `json:"startDate"`
	EndDate   string `json:"endDate"`
	Minutes   int    `json:"minutes"`
}

// ListView is one page of the caller's own requests, newest first; Total is a decimal string.
type ListView struct {
	Items []RequestSummary `json:"items"`
	Total string           `json:"total"`
}

type DecisionView struct {
	Stage        string  `json:"stage"`
	Decision     string  `json:"decision"`
	ActorKind    string  `json:"actorKind"`
	SystemReason *string `json:"systemReason"`
	Reason       *string `json:"reason"`
	DecidedAt    string  `json:"decidedAt"`
}

type DetailView struct {
	ID         string         `json:"id"`
	EmployeeID string         `json:"employeeId"`
	TeamID     string         `json:"teamId"`
	Kind       string         `json:"kind"`
	State      string         `json:"state"`
	Version    string         `json:"version"`
	Reason     string         `json:"reason"`
	CreatedAt  string         `json:"createdAt"`
	Segments   []Segment      `json:"segments"`
	Decisions  []DecisionView `json:"decisions"`
}

// DecisionInput is the validated body of POST /api/hr/requests/:id/decision, its path id and key. Reason is
// nil only on an approval without a note.
type DecisionInput struct {
	RequestID           string
	IdempotencyKey      string
	ExpectedVersion     string
	Decision            string
	Reason              *string
	AcknowledgeWfhLimit bool
}

// ApprovalItem is a request the caller may decide now; the employee is named by id only.
type ApprovalItem struct {
	ID         string `json:"id"`
	EmployeeID string `json:"employeeId"`
	Kind       string `json:"kind"`
	State      string `json:"state"`
	Version    string `json:"version"`
	TeamID     string `json:"teamId"`
	CreatedAt  string `json:"createdAt"`
	StartDate  string `json:"startDate"`
	EndDate    string `json:"endDate"`
	Minutes    int    `json:"minutes"`
}

type ApprovalView struct {
	Items []ApprovalItem `json:"items"`
	Total string         `json:"total"`
}

// LastDecision is the latest lead or final decision of a request, without reason or decider.
type LastDecision struct {
	Stage     string `json:"stage"`
	Decision  string `json:"decision"`
	ActorKind string `json:"actorKind"`
	DecidedAt string `json:"decidedAt"`
}

// DecidedItem is a request decided in the caller's approval scope and its owner's full name only.
type DecidedItem struct {
	ID           string       `json:"id"`
	EmployeeID   string       `json:"employeeId"`
	EmployeeName string       `json:"employeeName"`
	Kind         string       `json:"kind"`
	State        string       `json:"state"`
	Version      string       `json:"version"`
	TeamID       string       `json:"teamId"`
	CreatedAt    string       `json:"createdAt"`
	StartDate    string       `json:"startDate"`
	EndDate      string       `json:"endDate"`
	Minutes      int          `json:"minutes"`
	Decision     LastDecision `json:"decision"`
}

type DecidedView struct {
	Items []DecidedItem `json:"items"`
	Total string        `json:"total"`
}
