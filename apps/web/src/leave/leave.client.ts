import { z } from 'zod';
import type { HttpClient } from '../infrastructure/http.client';

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

export interface LeaveClient {
  /** `date`: the report date (`YYYY-MM-DD`), or `null` for today. */
  balance(employeeId: string, date: string | null, signal?: AbortSignal): Promise<LeaveBalance>;
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
  };
}
