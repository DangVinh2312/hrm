import type { AttendanceTotals } from './attendance-calculation.helper.js';

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
