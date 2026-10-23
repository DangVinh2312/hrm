import type { ProductQuery } from '../../../authorization/services/product-authority.service.js';
import { scopedParameters } from '../../permission/permission-database.helper.js';
import { date } from '../../attendance/helpers/attendance-facts.helper.js';
import { seniorityOf } from '../seniority.helper.js';
import type { ReportQueryOf, SeniorityReport } from '../report.types.js';

interface SeniorityStored {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly hiredOn: string;
}

export class ReportSeniorityRepository {
  /**
   * employee.reportSeniority: length of service at the cutoff `asOn` of every employee the caller's
   * scope allows who is employed that day (hired on or before it, not left before it), from the
   * employment dates of the employee row (the history), never `created_at`. ONE statement with the
   * plan's `scope` before count and page; ordered by employee code, id.
   */
  readonly seniorityReport: ProductQuery<ReportQueryOf<'seniority'>, SeniorityReport> = {
    resource: 'employee',
    action: 'reportSeniority',
    run: async ({ tx, scope }, input) => {
      const bound = scopedParameters(scope, input.asOn, input.limit, input.offset);
      const [result] = await tx.manager.query<
        { result: { total: string; rows: SeniorityStored[] } }[]
      >(
        `WITH scoped AS (
         SELECT r.id, r.code, r.full_name, r.hired_on FROM employee r
          WHERE ${scope.sql}
            AND r.hired_on <= CAST(${bound.at(1)} AS date)
            AND (r.terminated_on IS NULL OR r.terminated_on >= CAST(${bound.at(1)} AS date))),
       page AS (SELECT * FROM scoped ORDER BY code, id
                 LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8))
       SELECT json_build_object(
         'total', (SELECT count(*) FROM scoped)::text,
         'rows', COALESCE((SELECT json_agg(x ORDER BY x."employeeCode", x."employeeId") FROM (
                   SELECT p.id::text AS "employeeId", p.code AS "employeeCode", p.full_name AS "employeeName",
                          ${date('p.hired_on')} AS "hiredOn"
                     FROM page p) x), '[]'::json)) AS result`,
        bound.parameters,
      );
      if (!result) throw new Error('Report returned no row');
      return {
        kind: 'seniority',
        total: result.result.total,
        rows: result.result.rows.map((row) => {
          const service = seniorityOf(row.hiredOn, input.asOn);
          if (!service) throw new Error('Employee is not employed at the cutoff');
          return { ...row, asOn: input.asOn, ...service };
        }),
      };
    },
  };
}
