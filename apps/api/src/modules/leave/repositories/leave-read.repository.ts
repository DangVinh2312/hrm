import { EmployeeAction, HrResource } from '../../hr/hr-authorization.types.js';
import { type ProductQuery } from '../../../authorization/services/product-authority.service.js';
import { HR_TODAY, hrScoped } from '../../hr/helpers/hr-database.helper.js';
import { leaveBalanceView, monthlyMinutes } from '../helpers/leave-balance.helper.js';
import type {
  LeaveBalanceQuery,
  LeaveBalanceView,
  LeaveExcessView,
  LeaveReconciliationQuery,
  LeaveReconciliationView,
} from '../leave.types.js';
import { date, entitlement, loadLeaveFacts } from './leave-facts.repository.js';

/**
 * employee.readLeaveBalance (matrix §5.2 leave-balance.read: self, a lead's members, HR; Root):
 * the plan's scope on the employee row, then the balance at the report date (default: today by
 * the DB clock in the business timezone).
 */
export const leaveBalance: ProductQuery<LeaveBalanceQuery, LeaveBalanceView | undefined> = {
  resource: HrResource.Employee,
  action: EmployeeAction.ReadLeaveBalance,
  target: (input) => input.employeeId,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, input.employeeId, input.asOn);
    const [row] = await tx.manager.query<{ id: string; asOn: string }[]>(
      `SELECT r.id::text AS id, ${date(`COALESCE(CAST(${bound.at(2)} AS date), ${HR_TODAY})`)} AS "asOn"
         FROM employee r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    if (!row) return undefined;
    const facts = (await loadLeaveFacts(tx.manager, [row.id], Number(row.asOn.slice(0, 4)))).get(
      row.id,
    );
    if (!facts) throw new Error('Employee facts are missing');
    return leaveBalanceView({
      employeeId: row.id,
      asOn: row.asOn,
      facts: facts.accrual,
      adjustments: facts.adjustments,
      approved: facts.approved,
      pending: facts.pending,
    });
  },
};

const cumulative = (months: readonly number[]) => {
  let sum = 0;
  return months.map((minutes) => (sum += minutes));
};

/**
 * Pending annual leave that already exceeds the accrual (T5 submitted without the D09 check): per
 * month of the year, approved + pending dated up to its end against the entitlement to its end.
 * Employees are those of the caller's `readLeaveBalance` scope with pending annual leave in the
 * year (paged by code, ≤ 100), their facts read in one batch. Information for HR: nothing here
 * cancels or edits a request (the decision to keep, tell or have it cancelled is theirs).
 */
export const leaveReconciliation: ProductQuery<LeaveReconciliationQuery, LeaveReconciliationView> =
  {
    resource: HrResource.Employee,
    action: EmployeeAction.ReadLeaveBalance,
    run: async ({ tx, scope }, input) => {
      const bound = hrScoped(scope, input.year, input.limit, input.offset);
      const [page] = await tx.manager.query<
        {
          year: number;
          total: string;
          employees: { id: string; code: string; name: string }[];
        }[]
      >(
        `WITH yr AS (SELECT COALESCE(CAST(${bound.at(1)} AS int), EXTRACT(year FROM ${HR_TODAY})::int) AS y),
         scoped AS (
           SELECT r.id, r.code, r.full_name FROM employee r, yr
            WHERE ${scope.sql}
              AND EXISTS (SELECT 1 FROM work_request q JOIN work_request_segment s ON s.request_id = q.id
                           WHERE q.employee_id = r.id AND q.kind = 'annual-leave'
                             AND q.state IN ('pending_lead','pending_final')
                             AND s.work_date BETWEEN make_date(yr.y,1,1) AND make_date(yr.y,12,31)))
         SELECT (SELECT y FROM yr) AS year, (SELECT count(*) FROM scoped)::text AS total,
                COALESCE((SELECT json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.full_name)
                                          ORDER BY p.code, p.id)
                            FROM (SELECT * FROM scoped ORDER BY code, id
                                   LIMIT CAST(${bound.at(2)} AS int8) OFFSET CAST(${bound.at(3)} AS int8)) p),
                         '[]'::json) AS employees`,
        bound.parameters,
      );
      if (!page) throw new Error('Reconciliation returned no row');
      if (page.employees.length === 0) return { year: page.year, total: page.total, items: [] };
      const facts = await loadLeaveFacts(
        tx.manager,
        page.employees.map((e) => e.id),
        page.year,
      );
      const items: LeaveExcessView[] = [];
      for (const employee of page.employees) {
        const own = facts.get(employee.id);
        if (!own) continue;
        const entitled = entitlement(own);
        const approved = cumulative(monthlyMinutes(own.approved, page.year));
        const pending = cumulative(monthlyMinutes(own.pending, page.year));
        entitled.forEach((minutes, index) => {
          const committed = (approved[index] ?? 0) + (pending[index] ?? 0);
          if (committed <= Math.max(0, minutes)) return;
          const month = index + 1;
          items.push({
            employeeId: employee.id,
            employeeCode: employee.code,
            employeeName: employee.name,
            month,
            accruedMinutes: minutes,
            approvedMinutes: approved[index] ?? 0,
            pendingMinutes: pending[index] ?? 0,
            excessMinutes: committed - Math.max(0, minutes),
            requestIds: [
              ...new Set(
                [...own.pending]
                  .sort(
                    (a, b) =>
                      a.date.localeCompare(b.date) || a.requestId.localeCompare(b.requestId),
                  )
                  .filter((p) => Number(p.date.slice(5, 7)) <= month)
                  .map((p) => p.requestId),
              ),
            ],
          });
        });
      }
      return { year: page.year, total: page.total, items };
    },
  };
