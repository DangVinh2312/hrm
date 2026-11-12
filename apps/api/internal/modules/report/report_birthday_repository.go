package report

import (
	"encoding/json/v2"

	"github.com/jackc/pgx/v5"

	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/modules/settingcore"
)

type birthdayPage struct {
	Total string        `json:"total"`
	Rows  []BirthdayRow `json:"rows"`
}

// readBirthday is employee.reportBirthday: who celebrates in each month of From..To and on which day, from
// employee_identity.date_of_birth joined to the employee row the plan authorizes, in ONE statement with the
// scope before count and page. The day is computed in SQL so the birth year never leaves the database: it is
// clamped to the last day of the month shown, and only an employee employed that day has a row. No other
// identity field is selected.
func readBirthday(c authority.QueryContext, q Query) (Result, error) {
	limits, err := settingcore.Read(c.Tx, []settingcore.Key{settingcore.KeyReportMaxMonths})
	if err != nil {
		return nil, err
	}
	if err := checkSpan(q.From, q.To, int(limits[settingcore.KeyReportMaxMonths].Int)); err != nil {
		return nil, err
	}
	args, at, err := c.Scope.Args(q.From, q.To, q.Limit, q.Offset)
	if err != nil {
		return nil, err
	}
	rows, err := c.Tx.Query(`WITH ms AS (
         SELECT CAST(g AS date) AS first, CAST(g + interval '1 month' AS date) AS next
           FROM generate_series(CAST(`+at(1)+` || '-01' AS timestamp), CAST(`+at(2)+` || '-01' AS timestamp), interval '1 month') g),
       pairs AS (
         SELECT r.id, r.code, r.full_name, ms.first, b.day
           FROM employee r
           JOIN employee_identity i ON i.employee_id = r.id
           JOIN ms ON EXTRACT(month FROM i.date_of_birth) = EXTRACT(month FROM ms.first)
          CROSS JOIN LATERAL (
            SELECT make_date(EXTRACT(year FROM ms.first)::int, EXTRACT(month FROM ms.first)::int,
                             LEAST(EXTRACT(day FROM i.date_of_birth)::int, EXTRACT(day FROM ms.next - 1)::int)) AS day) b
          WHERE `+c.Scope.SQL+`
            AND r.hired_on <= b.day
            AND (r.terminated_on IS NULL OR r.terminated_on >= b.day)),
       page AS (SELECT * FROM pairs ORDER BY day, code, id
                 LIMIT CAST(`+at(3)+` AS int8) OFFSET CAST(`+at(4)+` AS int8))
       SELECT json_build_object(
         'total', (SELECT count(*) FROM pairs)::text,
         'rows', COALESCE((SELECT json_agg(x ORDER BY x."birthdayOn", x."employeeCode", x."employeeId") FROM (
                   SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                          to_char(p.first, 'YYYY-MM') AS month, to_char(p.day, 'YYYY-MM-DD') AS "birthdayOn"
                     FROM page p) x), '[]'::json))::text AS result`, args...)
	if err != nil {
		return nil, err
	}
	raw, err := pgx.CollectExactlyOneRow(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	var page birthdayPage
	if err := json.Unmarshal([]byte(raw), &page, json.RejectUnknownMembers(true)); err != nil {
		return nil, err
	}
	return Page[BirthdayRow]{Kind: KindBirthday, Total: page.Total, Rows: page.Rows}, nil
}
