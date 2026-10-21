import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';

/**
 * `GET /api/hr/employees/:id/leave-balance` (T7, D09): annual leave of the report date's year in
 * minutes. `entitledMinutes` can be negative (an adjustment taking leave back); `availableMinutes`
 * never is. An unexpected shape is a broken contract, never shown.
 */
const balanceSchema = z.object({
  employeeId: z.uuid(),
  year: z.number().int().min(1900).max(2100),
  asOn: z.iso.date(),
  annualMinutes: z.number().int().min(0).nullable(),
  entitledMinutes: z.number().int(),
  usedMinutes: z.number().int(),
  futureApprovedMinutes: z.number().int(),
  pendingMinutes: z.number().int().min(0),
  availableMinutes: z.number().int().min(0),
});
export type LeaveBalance = z.infer<typeof balanceSchema>;

/**
 * `GET /api/hr/leave/reconciliation` (T7, E-17): months where approved + pending annual leave
 * exceeds the accrual, per employee; information for HR, nothing is changed by it.
 */
const reconciliationSchema = z.object({
  year: z.number().int().min(1900).max(2100),
  total: z.string(),
  items: z
    .array(
      z.object({
        employeeId: z.uuid(),
        employeeCode: z.string(),
        employeeName: z.string(),
        month: z.number().int().min(1).max(12),
        accruedMinutes: z.number().int(),
        approvedMinutes: z.number().int(),
        pendingMinutes: z.number().int(),
        excessMinutes: z.number().int(),
        requestIds: z.array(z.uuid()).max(1000),
      }),
    )
    .max(1200),
});
export type LeaveReconciliation = z.infer<typeof reconciliationSchema>;

export const RECONCILIATION_PAGE_SIZE = 20;

export interface LeaveClient {
  /** `date`: the report date (`YYYY-MM-DD`), or `null` for today. */
  balance(employeeId: string, date: string | null, signal?: AbortSignal): Promise<LeaveBalance>;

  /** `year`: `null` for the current year; `page` is 1-based over employees. */
  reconciliation(
    query: { year: number | null; page: number },
    signal?: AbortSignal,
  ): Promise<LeaveReconciliation>;
}

export function createLeaveClient(http: HttpClient): LeaveClient {
  return {
    balance: (employeeId, date, signal) =>
      http.request(
        `/api/hr/employees/${encodeURIComponent(employeeId)}/leave-balance${
          date === null ? '' : `?date=${encodeURIComponent(date)}`
        }`,
        balanceSchema,
        signal ? { signal } : {},
      ),
    reconciliation: ({ year, page }, signal) => {
      const query = new URLSearchParams();
      if (year !== null) query.set('year', String(year));
      query.set('limit', String(RECONCILIATION_PAGE_SIZE));
      query.set('offset', String((page - 1) * RECONCILIATION_PAGE_SIZE));
      return http.request(
        `/api/hr/leave/reconciliation?${query}`,
        reconciliationSchema,
        signal ? { signal } : {},
      );
    },
  };
}
