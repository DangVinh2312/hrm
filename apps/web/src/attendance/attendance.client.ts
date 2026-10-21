import { z } from 'zod';
import type { HttpClient } from '../infrastructure/http.client';

const minutes = z.number().int().min(0).max(1_000_000);

/**
 * `GET /api/hr/employees/:id/attendance` (T8, D05): the monthly sheet in minutes, computed on the
 * server from approved requests only. An unexpected shape is a broken contract, never shown.
 */
const sheetSchema = z.object({
  employeeId: z.uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  periodState: z.enum(['open', 'closed']),
  scheduledMinutes: minutes,
  paidHolidayMinutes: minutes,
  unpaidMinutes: minutes,
  annualLeaveMinutes: minutes,
  paidMinutes: minutes,
  wfhDays: z.number().int().min(0).max(31),
  lateCount: z.number().int().min(0).max(31),
  lateMinutes: minutes,
  earlyCount: z.number().int().min(0).max(31),
  earlyMinutes: minutes,
});
export type AttendanceSheet = z.infer<typeof sheetSchema>;

export interface AttendanceClient {
  /** `month`: `YYYY-MM`, or `null` for the current month. */
  sheet(employeeId: string, month: string | null, signal?: AbortSignal): Promise<AttendanceSheet>;
}

export function createAttendanceClient(http: HttpClient): AttendanceClient {
  return {
    sheet: (employeeId, month, signal) =>
      http.request(
        `/api/hr/employees/${encodeURIComponent(employeeId)}/attendance${
          month === null ? '' : `?month=${encodeURIComponent(month)}`
        }`,
        sheetSchema,
        signal ? { signal } : {},
      ),
  };
}
