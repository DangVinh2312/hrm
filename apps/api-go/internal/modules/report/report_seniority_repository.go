package report

import (
	"encoding/json/v2"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/authority"
)

type seniorityStored struct {
	Employee
	HiredOn string `json:"hiredOn"`
}

type seniorityPage struct {
	Total string            `json:"total"`
	Rows  []seniorityStored `json:"rows"`
}

// readSeniority is employee.reportSeniority: the length of service at the cutoff AsOn of every employee in the
// caller's scope employed that day, from the employment dates of the employee row, in ONE statement with the
// scope before count and page.
func readSeniority(c authority.QueryContext, q Query) (Result, error) {
	args, at, err := c.Scope.Args(q.AsOn, q.Limit, q.Offset)
	if err != nil {
		return nil, err
	}
	rows, err := c.Tx.Query(`WITH scoped AS (
         SELECT r.id, r.code, r.full_name, r.hired_on FROM employee r
          WHERE `+c.Scope.SQL+`
            AND r.hired_on <= CAST(`+at(1)+` AS date)
            AND (r.terminated_on IS NULL OR r.terminated_on >= CAST(`+at(1)+` AS date))),
       page AS (SELECT * FROM scoped ORDER BY code, id
                 LIMIT CAST(`+at(2)+` AS int8) OFFSET CAST(`+at(3)+` AS int8))
       SELECT json_build_object(
         'total', (SELECT count(*) FROM scoped)::text,
         'rows', COALESCE((SELECT json_agg(x ORDER BY x."employeeCode", x."employeeId") FROM (
                   SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                          `+isoDate("p.hired_on")+` AS "hiredOn"
                     FROM page p) x), '[]'::json))::text AS result`, args...)
	if err != nil {
		return nil, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	var page seniorityPage
	if err := json.Unmarshal([]byte(raw), &page, json.RejectUnknownMembers(true)); err != nil {
		return nil, err
	}
	out := make([]SeniorityRow, len(page.Rows))
	for i, row := range page.Rows {
		service, err := seniorityOf(row.HiredOn, q.AsOn)
		if err != nil {
			return nil, err
		}
		out[i] = SeniorityRow{Employee: row.Employee, HiredOn: row.HiredOn, AsOn: q.AsOn, Seniority: service}
	}
	return Page[SeniorityRow]{Kind: KindSeniority, Total: page.Total, Rows: out}, nil
}
