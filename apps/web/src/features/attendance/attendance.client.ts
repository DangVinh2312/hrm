import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';

const minutes = z.number().int().min(0).max(1_000_000);
/** Paid minutes and adjustments are signed: HR may subtract (the API keeps the month's total >= 0). */
const signedMinutes = z.number().int().min(-1_000_000).max(1_000_000);

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
  paidMinutes: signedMinutes,
  wfhDays: z.number().int().min(0).max(31),
  lateCount: z.number().int().min(0).max(31),
  lateMinutes: minutes,
  earlyCount: z.number().int().min(0).max(31),
  earlyMinutes: minutes,
  adjustmentMinutes: signedMinutes,
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

/**
 * `GET /api/hr/employees/:id/attendance-adjustments` (HR): the entries of one month, newest day
 * first, with the signed month total already included in the sheet. No actor (the audit trail has who).
 */
const adjustmentsSchema = z.object({
  employeeId: z.uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  periodState: z.enum(['open', 'closed']),
  adjustmentMinutes: signedMinutes,
  total: z.string().regex(/^\d{1,18}$/),
  items: z
    .array(
      z.object({
        id: z.uuid(),
        workDate: z.iso.date(),
        minutes: z.number().int().min(-1440).max(1440),
        reason: z.string().max(300),
        reference: z.string().max(64).nullable(),
        createdAt: z.string(),
      }),
    )
    .max(100),
});
export type AttendanceAdjustments = z.infer<typeof adjustmentsSchema>;

export const ADJUSTMENT_PAGE_SIZE = 50;

export interface AdjustmentInput {
  readonly workDate: string;
  readonly minutes: number;
  readonly reason: string;
  readonly reference?: string;
}

const adjustmentResultSchema = z.object({ id: z.uuid() });

export interface AttendanceClient {
  /** `month`: `YYYY-MM`, or `null` for the current month. */
  sheet(employeeId: string, month: string | null, signal?: AbortSignal): Promise<AttendanceSheet>;

  period(month: string, signal?: AbortSignal): Promise<AttendancePeriod>;

  /** HR, fresh session: snapshot and close the month. */
  closePeriod(month: string): Promise<PeriodResult>;

  /** HR, fresh session: reopen a closed month; the reason is mandatory and audited. */
  reopenPeriod(month: string, reason: string): Promise<PeriodResult>;

  /** HR: the adjustments of one month of one employee (the newest {@link ADJUSTMENT_PAGE_SIZE}). */
  adjustments(
    employeeId: string,
    month: string,
    signal?: AbortSignal,
  ): Promise<AttendanceAdjustments>;

  /** HR, fresh session: one signed paid-minutes entry. The same key with the same input returns the first result. */
  adjust(
    employeeId: string,
    input: AdjustmentInput,
    idempotencyKey: string,
  ): Promise<{ readonly id: string }>;
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
    adjustments: (employeeId, month, signal) =>
      http.request(
        `/api/hr/employees/${encodeURIComponent(employeeId)}/attendance-adjustments?month=${encodeURIComponent(
          month,
        )}&limit=${ADJUSTMENT_PAGE_SIZE}`,
        adjustmentsSchema,
        signal ? { signal } : {},
      ),
    adjust: (employeeId, input, idempotencyKey) =>
      http.request(
        `/api/hr/employees/${encodeURIComponent(employeeId)}/attendance-adjustments`,
        adjustmentResultSchema,
        { method: 'POST', body: input, headers: { 'idempotency-key': idempotencyKey } },
      ),
  };
}
