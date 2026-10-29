import type { AttendanceTotals } from './helpers/attendance-calculation.helper.js';

export interface AttendanceQuery {
  readonly employeeId: string;
  /** `YYYY-MM`; `null` = the current month in the business timezone, from the DB clock. */
  readonly month: string | null;
}

export type AttendancePeriodState = 'open' | 'closed';

/** Monthly sheet of one employee (D05), minutes and counts, plus whether HR closed the month. */
export interface AttendancePeriodView extends AttendanceTotals {
  readonly employeeId: string;
  readonly month: string;
  readonly periodState: AttendancePeriodState;
}

/** One close or reopen of a month (D07); a reopen always has its reason. */
export interface AttendancePeriodEvent {
  readonly event: 'close' | 'reopen';
  /** int8 as decimal string: the period version this event produced (unique per month). */
  readonly version: string;
  readonly reason: string | null;
  /** UTC instant. */
  readonly occurredAt: string;
}

/** `GET /api/hr/attendance/periods/:month`: HR's view of a month's close state and history. */
export interface AttendancePeriodHistory {
  readonly month: string;
  readonly state: AttendancePeriodState;
  readonly version: string;
  /** Newest first, at most 50. */
  readonly events: readonly AttendancePeriodEvent[];
}

export interface PeriodCloseInput {
  readonly month: string;
}

export interface PeriodReopenInput extends PeriodCloseInput {
  /** 1..1000 code points (D07). */
  readonly reason: string;
}

export interface PeriodResult {
  readonly month: string;
  readonly state: AttendancePeriodState;
  readonly version: string;
}

/** Input of the internal effects; the request row is already locked by the deciding transaction. */
export interface ApprovedAttendanceEffect {
  readonly requestId: string;
}

export interface ApprovedWfhEffect extends ApprovedAttendanceEffect {
  /** D04: the approver saw that the month goes past 4 WFH days. */
  readonly acknowledgeWfhLimit: boolean;
}

/**
 * POST /api/hr/employees/:id/attendance-adjustments (`attendance.adjust`, user decision
 * 2026-10-22): one signed number of paid minutes for one employee on one day of their employment.
 */
export interface AttendanceAdjustmentInput {
  readonly employeeId: string;
  /** `Idempotency-Key` header (UUID v4). */
  readonly idempotencyKey: string;
  /** Business date `YYYY-MM-DD`; its month must be open. */
  readonly workDate: string;
  /** Signed, non-zero, within one day (±1440). The month's paid total must stay >= 0. */
  readonly minutes: number;
  /** 1..300 code points, mandatory; never audited or logged. */
  readonly reason: string;
  /** Optional source (decision number…): 1..64 characters of letters, digits and `. _ / # : -`. */
  readonly reference: string | null;
}

export interface AttendanceAdjustmentCommand extends AttendanceAdjustmentInput {
  /** SHA-256 hex of the normalized payload, computed outside SQL. */
  readonly hash: string;
}

/** Stored idempotency result and response: the new entry's id only. */
export interface AttendanceAdjustmentResult {
  readonly id: string;
}

/** `GET …/attendance-adjustments?month=YYYY-MM[&limit=&offset=]` (HR). */
export interface AttendanceAdjustmentQuery {
  readonly employeeId: string;
  readonly month: string;
  readonly limit: number;
  readonly offset: number;
}

export interface AttendanceAdjustmentItem {
  readonly id: string;
  readonly workDate: string;
  readonly minutes: number;
  readonly reason: string;
  readonly reference: string | null;
  /** UTC instant. */
  readonly createdAt: string;
}

/** Entries of one month, newest day first; `total` counts them all (decimal string). */
export interface AttendanceAdjustmentList {
  readonly employeeId: string;
  readonly month: string;
  readonly periodState: AttendancePeriodState;
  /** Signed sum of the month's entries, as included in the sheet. */
  readonly adjustmentMinutes: number;
  readonly total: string;
  readonly items: readonly AttendanceAdjustmentItem[];
}
