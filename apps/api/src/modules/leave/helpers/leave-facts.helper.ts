import {
  type AccrualFacts,
  type RatePeriod,
  type StatusPeriod,
  accruedByMonth,
  entitledByMonth,
} from './leave-balance.helper.js';
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

/** The stored shape of the facts columns of {@link leaveFactsColumns} (one employee, one year). */
export interface LeaveFactsRow {
  readonly hiredOn: string;
  readonly terminatedOn: string | null;
  readonly periods: readonly StatusPeriod[];
  readonly rates: readonly RatePeriod[];
  readonly ledger: readonly { kind: string; date: string; minutes: number }[];
  readonly pending: readonly PendingMinutes[];
}

/**
 * SQL columns (a fragment of a SELECT list) with everything the balance of employee row `e` in
 * the year `year` (an SQL int expression) depends on, as correlated subselects, so ONE statement
 * reads the profile, the ledger and the pending segments from one snapshot: a decision commits the
 * request state and its debits together, so this never counts a request as pending and approved,
 * nor as neither (spec §7.3 step 6 argument). Shared by the balance, the reconciliation,
 * the approval effects and the T9 leave report, so there is one reader of leave facts.
 */
export const leaveFactsColumns = (e: string, year: string) => `
  ${date(`${e}.hired_on`)} AS "hiredOn", ${date(`${e}.terminated_on`)} AS "terminatedOn",
  COALESCE((SELECT json_agg(json_build_object('status', p.status, 'startsOn', ${date('p.starts_on')},
              'endsOn', ${date('p.ends_on')}) ORDER BY p.starts_on)
              FROM employment_status_period p
             WHERE p.employee_id = ${e}.id AND p.starts_on <= make_date(${year}, 12, 31)), '[]'::json) AS periods,
  COALESCE((SELECT json_agg(json_build_object('effectiveFrom', ${date('l.effective_from')},
              'annualMinutes', l.annual_minutes) ORDER BY l.effective_from)
              FROM leave_rate l
             WHERE l.employee_id = ${e}.id AND l.effective_from <= make_date(${year}, 12, 31)), '[]'::json) AS rates,
  COALESCE((SELECT json_agg(json_build_object('kind', l.entry_kind, 'date', ${date('l.effective_on')},
              'minutes', l.minutes) ORDER BY l.effective_on, l.id)
              FROM leave_ledger l
             WHERE l.employee_id = ${e}.id
               AND l.effective_on BETWEEN make_date(${year}, 1, 1) AND make_date(${year}, 12, 31)), '[]'::json) AS ledger,
  COALESCE((SELECT json_agg(json_build_object('requestId', r.id::text, 'date', ${date('s.work_date')},
              'minutes', s.minutes) ORDER BY s.work_date, r.id)
              FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
             WHERE r.employee_id = ${e}.id AND r.kind = 'annual-leave'
               AND r.state IN ('pending_lead','pending_final')
               AND s.work_date BETWEEN make_date(${year}, 1, 1) AND make_date(${year}, 12, 31)), '[]'::json) AS pending`;

/** The facts of one employee and year from their stored columns; pure. */
export function leaveFactsOf(row: LeaveFactsRow, year: number): LeaveEmployeeFacts {
  const ledger = (kinds: readonly string[]) => row.ledger.filter((e) => kinds.includes(e.kind));

  return {
    accrual: {
      year,
      hiredOn: row.hiredOn,
      terminatedOn: row.terminatedOn,
      periods: row.periods,
      rates: row.rates,
    },
    adjustments: ledger(['opening', 'adjustment']),
    approved: [
      ...ledger(['debit']),
      ...ledger(['reversal']).map((e) => ({ date: e.date, minutes: -e.minutes })),
    ],
    pending: row.pending,
  };
}

export const entitlement = (facts: LeaveEmployeeFacts) =>
  entitledByMonth(accruedByMonth(facts.accrual), facts.adjustments, facts.accrual.year);
