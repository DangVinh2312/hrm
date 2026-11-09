package leave

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/hrbase"
	"hrm/api-go/internal/modules/leavecore"
)

var errMissingFacts = errors.New("employee facts are missing")

type balanceRow struct {
	ID   string
	AsOn string
}

// readBalance is employee.readLeaveBalance (self, a lead's members, HR; Root): the plan's scope on the
// employee row, then the balance at the report date (default today by the DB clock). Absent and outside
// the scope are both not found.
func readBalance(c authority.QueryContext, input BalanceQuery) (authority.QueryResult[leavecore.BalanceView], error) {
	var none authority.QueryResult[leavecore.BalanceView]
	args, at, err := c.Scope.Args(input.EmployeeID, input.AsOn)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`SELECT r.id::text AS id, to_char(COALESCE(CAST(`+at(2)+` AS date), `+hrbase.BusinessToday+`),'YYYY-MM-DD') AS "asOn"
         FROM employee r WHERE `+c.Scope.SQL+` AND r.id = CAST(`+at(1)+` AS uuid)`, args...)
	if err != nil {
		return none, err
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[balanceRow])
	if err != nil || len(found) == 0 {
		return none, err
	}
	row := found[0]
	year, err := strconv.Atoi(row.AsOn[:4])
	if err != nil {
		return none, err
	}
	facts, err := leavecore.LoadFacts(c.Tx, []string{row.ID}, year)
	if err != nil {
		return none, err
	}
	own, ok := facts[row.ID]
	if !ok {
		return none, errMissingFacts
	}
	view, err := leavecore.Balance(leavecore.BalanceInput{
		EmployeeID: row.ID, AsOn: row.AsOn, Facts: own.Accrual, Adjustments: own.Adjustments,
		Approved: own.Approved, Pending: leavecore.PendingDated(own.Pending),
	})
	return authority.QueryResult[leavecore.BalanceView]{Found: err == nil, Value: view}, err
}

type pageRow struct {
	Year      int
	Total     string
	Employees string
}

type pagedEmployee struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
}

// readReconciliation lists, per month of the year, approved + pending annual leave dated up to its end
// against the entitlement to its end. The employees are those of the caller's readLeaveBalance scope with
// pending annual leave in the year, filtered in SQL before the page (by code, ≤ 100), their facts read in
// one batch. Nothing here cancels or edits a request.
func readReconciliation(c authority.QueryContext, input ReconciliationQuery) (authority.QueryResult[ReconciliationView], error) {
	var none authority.QueryResult[ReconciliationView]
	args, at, err := c.Scope.Args(input.Year, input.Limit, input.Offset)
	if err != nil {
		return none, err
	}
	rows, err := c.Tx.Query(`WITH yr AS (SELECT COALESCE(CAST(`+at(1)+` AS int), EXTRACT(year FROM `+hrbase.BusinessToday+`)::int) AS y),
         scoped AS (
           SELECT r.id, r.code, r.full_name FROM employee r, yr
            WHERE `+c.Scope.SQL+`
              AND EXISTS (SELECT 1 FROM work_request q JOIN work_request_segment s ON s.request_id = q.id
                           WHERE q.employee_id = r.id AND q.kind = 'annual-leave'
                             AND q.state IN ('pending_lead','pending_final')
                             AND s.work_date BETWEEN make_date(yr.y,1,1) AND make_date(yr.y,12,31)))
         SELECT (SELECT y FROM yr) AS year, (SELECT count(*) FROM scoped)::text AS total,
                COALESCE((SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.full_name)
                                          ORDER BY p.code, p.id)
                            FROM (SELECT * FROM scoped ORDER BY code, id
                                   LIMIT CAST(`+at(2)+` AS int8) OFFSET CAST(`+at(3)+` AS int8)) p),
                         '[]'::json)::text AS employees`, args...)
	if err != nil {
		return none, err
	}
	page, err := pgx.CollectExactlyOneRow(rows, pgx.RowToStructByPos[pageRow])
	if err != nil {
		return none, err
	}
	var employees []pagedEmployee
	if err := json.Unmarshal([]byte(page.Employees), &employees, json.RejectUnknownMembers(true)); err != nil {
		return none, err
	}
	view := ReconciliationView{Year: page.Year, Total: page.Total, Items: []ExcessView{}}
	if len(employees) == 0 {
		return authority.QueryResult[ReconciliationView]{Found: true, Value: view}, nil
	}
	ids := make([]string, len(employees))
	for i, e := range employees {
		ids[i] = e.ID
	}
	facts, err := leavecore.LoadFacts(c.Tx, ids, page.Year)
	if err != nil {
		return none, err
	}
	for _, e := range employees {
		own, ok := facts[e.ID]
		if !ok {
			continue
		}
		items, err := excessMonths(e, own, page.Year)
		if err != nil {
			return none, err
		}
		view.Items = append(view.Items, items...)
	}
	return authority.QueryResult[ReconciliationView]{Found: true, Value: view}, nil
}

func cumulative(months []int) []int {
	sums := make([]int, len(months))
	sum := 0
	for i, minutes := range months {
		sum += minutes
		sums[i] = sum
	}
	return sums
}

// excessMonths are the months of one employee where committed leave exceeds max(0, entitlement).
func excessMonths(e pagedEmployee, own leavecore.EmployeeFacts, year int) ([]ExcessView, error) {
	entitled, err := leavecore.Entitlement(own)
	if err != nil {
		return nil, err
	}
	approvedMonthly, err := leavecore.MonthlyMinutes(own.Approved, year)
	if err != nil {
		return nil, err
	}
	pendingMonthly, err := leavecore.MonthlyMinutes(leavecore.PendingDated(own.Pending), year)
	if err != nil {
		return nil, err
	}
	approved, pending := cumulative(approvedMonthly), cumulative(pendingMonthly)
	oldest := slices.Clone(own.Pending)
	slices.SortStableFunc(oldest, func(a, b leavecore.PendingMinutes) int {
		if order := strings.Compare(a.Date, b.Date); order != 0 {
			return order
		}
		return strings.Compare(a.RequestID, b.RequestID)
	})
	var items []ExcessView
	for i, minutes := range entitled {
		limit := max(0, minutes)
		committed := approved[i] + pending[i]
		if committed <= limit {
			continue
		}
		month := i + 1
		upTo := fmt.Sprintf("%02d", month)
		requestIDs := []string{}
		for _, p := range oldest {
			if p.Date[5:7] <= upTo && !slices.Contains(requestIDs, p.RequestID) {
				requestIDs = append(requestIDs, p.RequestID)
			}
		}
		items = append(items, ExcessView{
			EmployeeID: e.ID, EmployeeCode: e.Code, EmployeeName: e.Name, Month: month, AccruedMinutes: minutes,
			ApprovedMinutes: approved[i], PendingMinutes: pending[i], ExcessMinutes: committed - limit, RequestIDs: requestIDs,
		})
	}
	return items, nil
}
