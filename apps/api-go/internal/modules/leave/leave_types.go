// Package leave is the annual leave routes (T7): the balance of one employee (D09), the HR reconciliation
// list and HR's signed ledger adjustment (D07, D14). The rules themselves live in leavecore.
package leave

// BalanceQuery is GET …/employees/:id/leave-balance; AsOn nil is today by the DB clock.
type BalanceQuery struct {
	EmployeeID string
	AsOn       *string
}

// ReconciliationQuery is GET /api/hr/leave/reconciliation; Year nil is the current business year.
type ReconciliationQuery struct {
	Year          *int
	Limit, Offset int
}

// AdjustmentInput is one signed `adjustment` ledger entry of the employee in the path.
type AdjustmentInput struct {
	EmployeeID     string
	IdempotencyKey string
	// Minutes is signed, non-zero, within ±175680 (the ledger CHECK).
	Minutes     int
	EffectiveOn string
	// Reference is 1..200 code points, trimmed.
	Reference string
}

// AdjustmentResult is the stored idempotency result and the response: the new entry's id only.
type AdjustmentResult struct {
	ID string `json:"id"`
}

// ExcessView is a month whose approved + pending annual leave up to its end exceeds the entitlement to
// its end (spec §8). Information for HR only.
type ExcessView struct {
	EmployeeID      string `json:"employeeId"`
	EmployeeCode    string `json:"employeeCode"`
	EmployeeName    string `json:"employeeName"`
	Month           int    `json:"month"`
	AccruedMinutes  int    `json:"accruedMinutes"`
	ApprovedMinutes int    `json:"approvedMinutes"`
	PendingMinutes  int    `json:"pendingMinutes"`
	ExcessMinutes   int    `json:"excessMinutes"`
	// RequestIDs are the pending requests with a segment up to that month, oldest first.
	RequestIDs []string `json:"requestIds"`
}

// ReconciliationView pages the employees in scope with pending annual leave in the year; Total is a
// decimal string.
type ReconciliationView struct {
	Year  int          `json:"year"`
	Total string       `json:"total"`
	Items []ExcessView `json:"items"`
}
