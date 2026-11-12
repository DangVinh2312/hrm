// Package report is the six HR reports (T9): pages of the scoped employees and their XLSX exports.
package report

import "hrm/api/internal/modules/attendancecore"

// Kind names one of the six reports; it comes from the route, never from the query.
type Kind string

const (
	KindAttendance Kind = "attendance"
	KindLateEarly  Kind = "late-early"
	KindWfh        Kind = "wfh"
	KindBirthday   Kind = "birthday"
	KindLeave      Kind = "leave"
	KindSeniority  Kind = "seniority"
)

var kinds = []Kind{KindAttendance, KindLateEarly, KindWfh, KindBirthday, KindLeave, KindSeniority}

// monthly reports take an inclusive From..To; leave and seniority an explicit cutoff.
func (k Kind) monthly() bool { return k != KindLeave && k != KindSeniority }

// ExportQuery is the validated input of an export: the whole scoped set or a refusal, never a page.
type ExportQuery struct {
	Kind Kind
	// From and To are `YYYY-MM` of a monthly report, at most MaxMonths apart.
	From, To string
	// AsOn is the `YYYY-MM-DD` cutoff of leave and seniority, never "today" implicitly.
	AsOn string
}

// Query is a page of one report: limit 1..100 (default 20), offset at most 10000.
type Query struct {
	ExportQuery
	Limit, Offset int
}

type Employee struct {
	EmployeeID   string `json:"employeeId"`
	EmployeeCode string `json:"employeeCode"`
	EmployeeName string `json:"employeeName"`
}

func (e Employee) person() Employee { return e }

// AttendanceRow is the sheet of one employee in one month; closed months come from the stored snapshot.
type AttendanceRow struct {
	Employee
	Month       string                     `json:"month"`
	PeriodState attendancecore.PeriodState `json:"periodState"`
	attendancecore.Totals
}

// LateEarlyRow is the approved late arrivals and early departures of one employee in one month.
type LateEarlyRow struct {
	Employee
	Month        string                     `json:"month"`
	PeriodState  attendancecore.PeriodState `json:"periodState"`
	LateCount    int                        `json:"lateCount"`
	LateMinutes  int                        `json:"lateMinutes"`
	EarlyCount   int                        `json:"earlyCount"`
	EarlyMinutes int                        `json:"earlyMinutes"`
}

// WfhRow is the approved WFH days dated in the month; OverLimit is above hr.wfhMonthLimit in force.
type WfhRow struct {
	Employee
	Month       string                     `json:"month"`
	PeriodState attendancecore.PeriodState `json:"periodState"`
	WfhDays     int                        `json:"wfhDays"`
	OverLimit   bool                       `json:"overLimit"`
}

// BirthdayRow is the day celebrated in the month (29/02 on 28/02 in a common year); never the birth year.
type BirthdayRow struct {
	Employee
	Month      string `json:"month"`
	BirthdayOn string `json:"birthdayOn"`
}

// LeaveRow is the leave balance at the cutoff, the numbers of the balance endpoint without a second employeeId.
type LeaveRow struct {
	Employee
	Year                  int    `json:"year"`
	AsOn                  string `json:"asOn"`
	AnnualMinutes         *int   `json:"annualMinutes"`
	EntitledMinutes       int    `json:"entitledMinutes"`
	UsedMinutes           int    `json:"usedMinutes"`
	FutureApprovedMinutes int    `json:"futureApprovedMinutes"`
	PendingMinutes        int    `json:"pendingMinutes"`
	AvailableMinutes      int    `json:"availableMinutes"`
}

// Seniority is the length of service from the hire day to the cutoff, both days counted.
type Seniority struct {
	Years     int `json:"years"`
	Months    int `json:"months"`
	Days      int `json:"days"`
	TotalDays int `json:"totalDays"`
}

type SeniorityRow struct {
	Employee
	HiredOn string `json:"hiredOn"`
	AsOn    string `json:"asOn"`
	Seniority
}

// Row is the closed set of report rows.
type Row interface {
	AttendanceRow | LateEarlyRow | WfhRow | BirthdayRow | LeaveRow | SeniorityRow
}

// Page is one report page: Total counts the rows the caller's scope allows, as a decimal string.
type Page[R Row] struct {
	Kind  Kind   `json:"kind"`
	Total string `json:"total"`
	Rows  []R    `json:"rows"`
}

// Result is a page of any of the six reports.
type Result interface {
	result()
	count() string
}

func (Page[R]) result() {}

func (p Page[R]) count() string { return p.Total }
