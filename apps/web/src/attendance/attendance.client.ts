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

/** `GET /api/hr/attendance/periods/:month` (D07): state of a month and its close/reopen history. */
const periodSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  state: z.enum(['open', 'closed']),
  version: z.string().regex(/^[1-9][0-9]{0,17}$/),
  events: z
    .array(
      z.object({
        event: z.enum(['close', 'reopen']),
        version: z.string().regex(/^[1-9][0-9]{0,17}$/),
        reason: z.string().nullable(),
        occurredAt: z.string(),
      }),
    )
    .max(50),
});
export type AttendancePeriod = z.infer<typeof periodSchema>;

const periodResultSchema = z.object({
  month: z.string(),
  state: z.enum(['open', 'closed']),
  version: z.string(),
});
export type PeriodResult = z.infer<typeof periodResultSchema>;

export interface AttendanceClient {
  /** `month`: `YYYY-MM`, or `null` for the current month. */
  sheet(employeeId: string, month: string | null, signal?: AbortSignal): Promise<AttendanceSheet>;

  period(month: string, signal?: AbortSignal): Promise<AttendancePeriod>;

  /** HR, fresh session: snapshot and close the month. */
  closePeriod(month: string): Promise<PeriodResult>;

  /** HR, fresh session: reopen a closed month; the reason is mandatory and audited. */
  reopenPeriod(month: string, reason: string): Promise<PeriodResult>;
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
    period: (month, signal) =>
      http.request(
        `/api/hr/attendance/periods/${encodeURIComponent(month)}`,
        periodSchema,
        signal ? { signal } : {},
      ),
    closePeriod: (month) =>
      http.request(
        `/api/hr/attendance/periods/${encodeURIComponent(month)}/close`,
        periodResultSchema,
        { method: 'POST', body: {} },
      ),
    reopenPeriod: (month, reason) =>
      http.request(
        `/api/hr/attendance/periods/${encodeURIComponent(month)}/reopen`,
        periodResultSchema,
        { method: 'POST', body: { reason } },
      ),
  };
}
