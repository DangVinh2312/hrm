package leavecore

import (
	"encoding/json/v2"
	"errors"
)

// EmployeeFacts is everything the balance of one employee and year depends on, from one consistent read.
type EmployeeFacts struct {
	Accrual AccrualFacts
	// Adjustments are the signed opening and adjustment entries dated in the year.
	Adjustments []DatedMinutes
	// Approved is debits minus reversals by segment date.
	Approved []DatedMinutes
	// Pending is the segments of annual-leave requests waiting for a decision.
	Pending []PendingMinutes
}

type ledgerEntry struct {
	Kind    string `json:"kind"`
	Date    string `json:"date"`
	Minutes int    `json:"minutes"`
}

// FactsRow is the stored shape of FactsSQL for one employee and year.
type FactsRow struct {
	HiredOn      string           `json:"hiredOn"`
	TerminatedOn *string          `json:"terminatedOn"`
	Periods      []StatusPeriod   `json:"periods"`
	Rates        []RatePeriod     `json:"rates"`
	Ledger       []ledgerEntry    `json:"ledger"`
	Pending      []PendingMinutes `json:"pending"`
}

var ErrStoredFacts = errors.New("stored leave facts are invalid")

func date(column string) string { return "to_char(" + column + ",'YYYY-MM-DD')" }

// FactsSQL is a JSON object (SQL fragment) with everything the balance of employee row e in year (an SQL int
// expression) depends on, as correlated subselects, so one statement reads the profile, the ledger and the
// pending segments from one snapshot: a decision commits the request state and its debits together, so a
// request is never counted as pending and approved, nor as neither. Arguments are SQL of the caller, never input.
func FactsSQL(e, year string) string {
	return `json_build_object(
  'hiredOn', ` + date(e+".hired_on") + `, 'terminatedOn', ` + date(e+".terminated_on") + `,
  'periods', COALESCE((SELECT json_agg(json_build_object('status', p.status, 'startsOn', ` + date("p.starts_on") + `,
              'endsOn', ` + date("p.ends_on") + `) ORDER BY p.starts_on)
              FROM employment_status_period p
             WHERE p.employee_id = ` + e + `.id AND p.starts_on <= make_date(` + year + `, 12, 31)), '[]'::json),
  'rates', COALESCE((SELECT json_agg(json_build_object('effectiveFrom', ` + date("l.effective_from") + `,
              'annualMinutes', l.annual_minutes) ORDER BY l.effective_from)
              FROM leave_rate l
             WHERE l.employee_id = ` + e + `.id AND l.effective_from <= make_date(` + year + `, 12, 31)), '[]'::json),
  'ledger', COALESCE((SELECT json_agg(json_build_object('kind', l.entry_kind, 'date', ` + date("l.effective_on") + `,
              'minutes', l.minutes) ORDER BY l.effective_on, l.id)
              FROM leave_ledger l
             WHERE l.employee_id = ` + e + `.id
               AND l.effective_on BETWEEN make_date(` + year + `, 1, 1) AND make_date(` + year + `, 12, 31)), '[]'::json),
  'pending', COALESCE((SELECT json_agg(json_build_object('requestId', r.id::text, 'date', ` + date("s.work_date") + `,
              'minutes', s.minutes) ORDER BY s.work_date, r.id)
              FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
             WHERE r.employee_id = ` + e + `.id AND r.kind = 'annual-leave'
               AND r.state IN ('pending_lead','pending_final')
               AND s.work_date BETWEEN make_date(` + year + `, 1, 1) AND make_date(` + year + `, 12, 31)), '[]'::json))`
}

// DecodeFactsRow reads one FactsSQL value; another shape is ErrStoredFacts.
func DecodeFactsRow(raw []byte) (FactsRow, error) {
	var row FactsRow
	if err := json.Unmarshal(raw, &row, json.RejectUnknownMembers(true)); err != nil {
		return FactsRow{}, ErrStoredFacts
	}
	return row, nil
}

// FactsOf is the facts of one employee and year from their stored row.
func FactsOf(row FactsRow, year int) EmployeeFacts {
	facts := EmployeeFacts{
		Accrual:     AccrualFacts{Year: year, HiredOn: row.HiredOn, TerminatedOn: row.TerminatedOn, Periods: row.Periods, Rates: row.Rates},
		Adjustments: []DatedMinutes{},
		Approved:    []DatedMinutes{},
		Pending:     row.Pending,
	}
	var reversals []DatedMinutes
	for _, e := range row.Ledger {
		switch e.Kind {
		case "opening", "adjustment":
			facts.Adjustments = append(facts.Adjustments, DatedMinutes{e.Date, e.Minutes})
		case "debit":
			facts.Approved = append(facts.Approved, DatedMinutes{e.Date, e.Minutes})
		case "reversal":
			reversals = append(reversals, DatedMinutes{e.Date, -e.Minutes})
		}
	}
	facts.Approved = append(facts.Approved, reversals...)
	if facts.Pending == nil {
		facts.Pending = []PendingMinutes{}
	}
	return facts
}

// Entitlement is the entitlement to the end of each month of the facts' year.
func Entitlement(facts EmployeeFacts) ([]int, error) {
	return EntitledByMonth(AccruedByMonth(facts.Accrual), facts.Adjustments, facts.Accrual.Year)
}

// PendingDated drops the request of each pending segment.
func PendingDated(pending []PendingMinutes) []DatedMinutes {
	dated := make([]DatedMinutes, len(pending))
	for i, p := range pending {
		dated[i] = DatedMinutes{p.Date, p.Minutes}
	}
	return dated
}
