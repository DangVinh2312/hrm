import type { ProductQuery } from '../../../authorization/services/product-authority.service.js';
import { hrScoped } from '../../hr/helpers/hr-database.helper.js';
import type { BirthdayReport, BirthdayReportRow, ReportQueryOf } from '../report.types.js';

/**
 * employee.reportBirthday (T9 part B, design §12.0 D-birthday): who celebrates in each month of
 * `from..to` and on which day, from `employee_identity.date_of_birth` joined to the employee row
 * the plan authorizes. ONE statement with the plan's `scope` before count and page.
 *
 * The date is computed here so the birth YEAR never leaves the database: the day of birth is
 * clamped to the last day of the month shown (29/02 → 28/02 in a common year, 29/02 in a leap
 * year), and the row is only an employee celebrating while employed (hired on or before that day,
 * not left before it). An employee with no date of birth has no row. Ordered by day, code, id.
 * No CCCD, tax code or other F2 field is selected.
 */
export const birthdayReport: ProductQuery<ReportQueryOf<'birthday'>, BirthdayReport> = {
  resource: 'employee',
  action: 'reportBirthday',
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.from, input.to, input.limit, input.offset);
    const [result] = await tx.manager.query<
      { result: { total: string; rows: BirthdayReportRow[] } }[]
    >(
      `WITH ms AS (
         SELECT CAST(g AS date) AS first, CAST(g + interval '1 month' AS date) AS next
           FROM generate_series(CAST(${bound.at(1)} || '-01' AS timestamp), CAST(${bound.at(2)} || '-01' AS timestamp), interval '1 month') g),
       pairs AS (
         SELECT r.id, r.code, r.full_name, ms.first, b.day
           FROM employee r
           JOIN employee_identity i ON i.employee_id = r.id
           JOIN ms ON EXTRACT(month FROM i.date_of_birth) = EXTRACT(month FROM ms.first)
          CROSS JOIN LATERAL (
            SELECT make_date(EXTRACT(year FROM ms.first)::int, EXTRACT(month FROM ms.first)::int,
                             LEAST(EXTRACT(day FROM i.date_of_birth)::int, EXTRACT(day FROM ms.next - 1)::int)) AS day) b
          WHERE ${scope.sql}
            AND r.hired_on <= b.day
            AND (r.terminated_on IS NULL OR r.terminated_on >= b.day)),
       page AS (SELECT * FROM pairs ORDER BY day, code, id
                 LIMIT CAST(${bound.at(3)} AS int8) OFFSET CAST(${bound.at(4)} AS int8))
       SELECT json_build_object(
         'total', (SELECT count(*) FROM pairs)::text,
         'rows', COALESCE((SELECT json_agg(x ORDER BY x."birthdayOn", x."employeeCode", x."employeeId") FROM (
                   SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                          to_char(p.first, 'YYYY-MM') AS month, to_char(p.day, 'YYYY-MM-DD') AS "birthdayOn"
                     FROM page p) x), '[]'::json)) AS result`,
      bound.parameters,
    );
    if (!result) throw new Error('Report returned no row');
    return { kind: 'birthday', total: result.result.total, rows: result.result.rows };
  },
};
