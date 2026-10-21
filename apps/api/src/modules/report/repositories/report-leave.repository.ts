import type { ProductQuery } from '../../../authorization/services/product-authority.service.js';
import { hrScoped } from '../../hr/helpers/hr-database.helper.js';
import { leaveBalanceView } from '../../leave/helpers/leave-balance.helper.js';
import {
  type LeaveFactsRow,
  leaveFactsColumns,
  leaveFactsOf,
} from '../../leave/repositories/leave-facts.repository.js';
import type { LeaveReport, ReportQueryOf } from '../report.types.js';

interface LeaveStored extends LeaveFactsRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
}

/**
 * employee.reportLeave: the D09 balance of every employee the caller's scope allows who was
 * employed at some time in the cutoff's year, at the cutoff date `asOn`. ONE statement (one
 * snapshot): the plan's `scope` is ANDed into the employee scan before count and page, and the
 * profile, ledger and pending segments of the page come from the same columns the balance endpoint
 * reads (`leaveFactsColumns`), computed by the same pure `leaveBalanceView`, so a report row always
 * equals `GET …/leave-balance?date=` for that employee. Ordered by employee code, id.
 */
export const leaveReport: ProductQuery<ReportQueryOf<'leave'>, LeaveReport> = {
  resource: 'employee',
  action: 'reportLeave',
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.asOn, input.limit, input.offset);
    const [result] = await tx.manager.query<{ result: { total: string; rows: LeaveStored[] } }[]>(
      `WITH yr AS (SELECT EXTRACT(year FROM CAST(${bound.at(1)} AS date))::int AS y),
       scoped AS (
         SELECT r.id, r.code, r.full_name FROM employee r, yr
          WHERE ${scope.sql}
            AND r.hired_on <= make_date(yr.y, 12, 31)
            AND (r.terminated_on IS NULL OR r.terminated_on >= make_date(yr.y, 1, 1))),
       page AS (SELECT * FROM scoped ORDER BY code, id
                 LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8))
       SELECT json_build_object(
         'total', (SELECT count(*) FROM scoped)::text,
         'rows', COALESCE((SELECT json_agg(x ORDER BY x."employeeCode", x."employeeId") FROM (
                   SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                          ${leaveFactsColumns('e', '(SELECT y FROM yr)')}
                     FROM page p JOIN employee e ON e.id = p.id) x), '[]'::json)) AS result`,
      bound.parameters,
    );
    if (!result) throw new Error('Report returned no row');
    const year = Number(input.asOn.slice(0, 4));
    return {
      kind: 'leave',
      total: result.result.total,
      rows: result.result.rows.map((row) => {
        const facts = leaveFactsOf(row, year);
        const { employeeId: _id, ...balance } = leaveBalanceView({
          employeeId: row.employeeId,
          asOn: input.asOn,
          facts: facts.accrual,
          adjustments: facts.adjustments,
          approved: facts.approved,
          pending: facts.pending,
        });
        void _id;
        return {
          employeeId: row.employeeId,
          employeeCode: row.employeeCode,
          employeeName: row.employeeName,
          ...balance,
        };
      }),
    };
  },
};
