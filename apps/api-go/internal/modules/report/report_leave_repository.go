package report

import (
	"encoding/json/v2"
	"strconv"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/leavecore"
)

type leaveStored struct {
	Employee
	Facts leavecore.FactsRow `json:"facts"`
}

type leavePage struct {
	Total string        `json:"total"`
	Rows  []leaveStored `json:"rows"`
}

// readLeave is employee.reportLeave: the balance at the cutoff AsOn of every employee in the caller's scope
// employed at some time in the cutoff's year, from ONE statement with the scope before count and page. The facts
// come from leavecore.FactsSQL and leavecore.Balance, the reader and formula of the balance endpoint, so a row
// equals GET …/leave-balance?date= for that employee. Not leavecore.LoadFacts: an export reads up to 5000
// employees in this one statement.
func readLeave(c authority.QueryContext, q Query) (Result, error) {
	year, err := strconv.Atoi(q.AsOn[:4])
	if err != nil {
		return nil, err
	}
	args, at, err := c.Scope.Args(q.AsOn, q.Limit, q.Offset)
	if err != nil {
		return nil, err
	}
	rows, err := c.Tx.Query(`WITH yr AS (SELECT EXTRACT(year FROM CAST(`+at(1)+` AS date))::int AS y),
       scoped AS (
         SELECT r.id, r.code, r.full_name FROM employee r, yr
          WHERE `+c.Scope.SQL+`
            AND r.hired_on <= make_date(yr.y, 12, 31)
            AND (r.terminated_on IS NULL OR r.terminated_on >= make_date(yr.y, 1, 1))),
       page AS (SELECT * FROM scoped ORDER BY code, id
                 LIMIT CAST(`+at(2)+` AS int8) OFFSET CAST(`+at(3)+` AS int8))
       SELECT json_build_object(
         'total', (SELECT count(*) FROM scoped)::text,
         'rows', COALESCE((SELECT json_agg(x ORDER BY x."employeeCode", x."employeeId") FROM (
                   SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                          `+leavecore.FactsSQL("e", "(SELECT y FROM yr)")+` AS facts
                     FROM page p JOIN employee e ON e.id = p.id) x), '[]'::json))::text AS result`, args...)
	if err != nil {
		return nil, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	var page leavePage
	if err := json.Unmarshal([]byte(raw), &page, json.RejectUnknownMembers(true)); err != nil {
		return nil, leavecore.ErrStoredFacts
	}
	out := make([]LeaveRow, len(page.Rows))
	for i, row := range page.Rows {
		facts := leavecore.FactsOf(row.Facts, year)
		balance, err := leavecore.Balance(leavecore.BalanceInput{
			EmployeeID: row.EmployeeID, AsOn: q.AsOn, Facts: facts.Accrual, Adjustments: facts.Adjustments,
			Approved: facts.Approved, Pending: leavecore.PendingDated(facts.Pending),
		})
		if err != nil {
			return nil, err
		}
		out[i] = LeaveRow{
			Employee: row.Employee, Year: balance.Year, AsOn: balance.AsOn, AnnualMinutes: balance.AnnualMinutes,
			EntitledMinutes: balance.EntitledMinutes, UsedMinutes: balance.UsedMinutes, FutureApprovedMinutes: balance.FutureApprovedMinutes,
			PendingMinutes: balance.PendingMinutes, AvailableMinutes: balance.AvailableMinutes,
		}
	}
	return Page[LeaveRow]{Kind: KindLeave, Total: page.Total, Rows: out}, nil
}
