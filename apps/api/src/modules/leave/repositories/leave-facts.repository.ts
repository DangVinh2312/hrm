import type { EntityManager } from 'typeorm';
import {
  type AccrualFacts,
  accruedByMonth,
  entitledByMonth,
} from '../helpers/leave-balance.helper.js';
import type { DatedMinutes, PendingMinutes } from '../leave.types.js';

export const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

/** Everything the balance of one employee and year depends on, from one consistent read. */
export interface LeaveEmployeeFacts {
  readonly accrual: AccrualFacts;
  /** Opening and adjustment entries (signed), dated in the year. */
  readonly adjustments: readonly DatedMinutes[];
  /** Debits minus reversals by segment date: approved annual leave. */
  readonly approved: readonly DatedMinutes[];
  /** Segments of annual-leave requests waiting for a decision. */
  readonly pending: readonly PendingMinutes[];
}

/**
 * Facts of `employeeIds` for `year` (three reads of slowly changing profile data and one
 * statement for the ledger and the pending segments). The last one is a single statement on
 * purpose: a decision commits the request state and its debits together, so one snapshot never
 * counts a request as pending and approved, nor as neither (spec §7.3 step 6 argument, ADR 0017).
 * Bounded by the caller's id list (≤ 100) and by the year's segments of those employees.
 */
export async function loadLeaveFacts(
  manager: EntityManager,
  employeeIds: readonly string[],
  year: number,
): Promise<ReadonlyMap<string, LeaveEmployeeFacts>> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const ids = [...employeeIds];
  const employees = await manager.query<
    { id: string; hiredOn: string; terminatedOn: string | null }[]
  >(
    `SELECT id::text AS id, ${date('hired_on')} AS "hiredOn", ${date('terminated_on')} AS "terminatedOn"
       FROM employee WHERE id = ANY(CAST($1 AS uuid[]))`,
    [ids],
  );
  const periods = await manager.query<
    {
      employeeId: string;
      status: 'probation' | 'official';
      startsOn: string;
      endsOn: string | null;
    }[]
  >(
    `SELECT employee_id::text AS "employeeId", status, ${date('starts_on')} AS "startsOn", ${date('ends_on')} AS "endsOn"
       FROM employment_status_period WHERE employee_id = ANY(CAST($1 AS uuid[])) AND starts_on <= CAST($2 AS date)`,
    [ids, to],
  );
  const rates = await manager.query<
    { employeeId: string; effectiveFrom: string; annualMinutes: number }[]
  >(
    `SELECT employee_id::text AS "employeeId", ${date('effective_from')} AS "effectiveFrom", annual_minutes AS "annualMinutes"
       FROM leave_rate WHERE employee_id = ANY(CAST($1 AS uuid[])) AND effective_from <= CAST($2 AS date)`,
    [ids, to],
  );
  const entries = await manager.query<
    {
      employeeId: string;
      source: 'ledger' | 'request';
      kind: string;
      date: string;
      minutes: number;
      requestId: string | null;
    }[]
  >(
    `SELECT l.employee_id::text AS "employeeId", 'ledger' AS source, l.entry_kind AS kind,
            ${date('l.effective_on')} AS date, l.minutes, NULL::text AS "requestId"
       FROM leave_ledger l
      WHERE l.employee_id = ANY(CAST($1 AS uuid[])) AND l.effective_on BETWEEN CAST($2 AS date) AND CAST($3 AS date)
     UNION ALL
     SELECT r.employee_id::text, 'request', r.state, ${date('s.work_date')}, s.minutes, r.id::text
       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
      WHERE r.employee_id = ANY(CAST($1 AS uuid[])) AND r.kind = 'annual-leave'
        AND r.state IN ('pending_lead','pending_final')
        AND s.work_date BETWEEN CAST($2 AS date) AND CAST($3 AS date)`,
    [ids, from, to],
  );
  const result = new Map<string, LeaveEmployeeFacts>();
  for (const employee of employees) {
    const mine = entries.filter((e) => e.employeeId === employee.id);

    const ledger = (kinds: readonly string[]) =>
      mine.filter((e) => e.source === 'ledger' && kinds.includes(e.kind));

    result.set(employee.id, {
      accrual: {
        year,
        hiredOn: employee.hiredOn,
        terminatedOn: employee.terminatedOn,
        periods: periods.filter((p) => p.employeeId === employee.id),
        rates: rates.filter((r) => r.employeeId === employee.id),
      },
      adjustments: ledger(['opening', 'adjustment']),
      approved: [
        ...ledger(['debit']),
        ...ledger(['reversal']).map((e) => ({ date: e.date, minutes: -e.minutes })),
      ],
      pending: mine
        .filter((e) => e.source === 'request' && e.requestId !== null)
        .map((e) => ({ date: e.date, minutes: e.minutes, requestId: e.requestId as string })),
    });
  }
  return result;
}

export const entitlement = (facts: LeaveEmployeeFacts) =>
  entitledByMonth(accruedByMonth(facts.accrual), facts.adjustments, facts.accrual.year);
