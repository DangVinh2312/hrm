import { createHash } from 'node:crypto';
import {
  ProductAccessDenied,
  type ProductAuthorization,
} from '../../authorization/services/product-authority.service.js';
import type {
  AttendanceAdjustmentInput,
  AttendanceAdjustmentList,
  AttendanceAdjustmentQuery,
  AttendanceAdjustmentResult,
  AttendancePeriodHistory,
  AttendancePeriodView,
  AttendanceQuery,
  PeriodCloseInput,
  PeriodReopenInput,
  PeriodResult,
} from './attendance.types.js';
import {
  AttendanceAdjustmentReplayed,
  type AttendanceAdjustRepository,
} from './repositories/attendance-adjust.repository.js';
import type { AttendancePeriodRepository } from './repositories/attendance-period.repository.js';

export const attendanceCommands = (
  periods: AttendancePeriodRepository,
  adjustments: AttendanceAdjustRepository,
) => [periods.closePeriod, periods.reopenPeriod, adjustments.adjustAttendance] as const;

export const attendanceQueries = (
  periods: AttendancePeriodRepository,
  adjustments: AttendanceAdjustRepository,
) =>
  [
    periods.attendancePeriod,
    periods.attendancePeriodState,
    adjustments.attendanceAdjustments,
  ] as const;

/** Fixed key order, so the same adjustment hashes the same on retry; the key itself is not hashed. */
const adjustmentHash = (input: AttendanceAdjustmentInput) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.employeeId,
        input.workDate,
        input.minutes,
        input.reason,
        input.reference,
      ]),
    )
    .digest('hex');

/** Attendance operations bound to the registered commands/queries (T8). */
export class AttendanceService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly periods: AttendancePeriodRepository,
    private readonly adjustmentRepository: AttendanceAdjustRepository,
  ) {}

  /** `undefined`: absent or outside the caller's scope (404). */
  period(secret: string, query: AttendanceQuery): Promise<AttendancePeriodView | undefined> {
    return this.authorization.query(secret, this.periods.attendancePeriod, query);
  }

  /** `undefined`: the caller does not read the company row (404). */
  periodState(secret: string, month: string): Promise<AttendancePeriodHistory | undefined> {
    return this.authorization.query(secret, this.periods.attendancePeriodState, { month });
  }

  async closePeriod(secret: string, input: PeriodCloseInput): Promise<PeriodResult> {
    const result = await this.authorization.execute(secret, this.periods.closePeriod, input);
    // The company anchor always exists, so "not visible" means no grant (403), as for the calendar.
    if (!result) throw new ProductAccessDenied();
    return result;
  }

  async reopenPeriod(secret: string, input: PeriodReopenInput): Promise<PeriodResult> {
    const result = await this.authorization.execute(secret, this.periods.reopenPeriod, input);
    if (!result) throw new ProductAccessDenied();
    return result;
  }

  /**
   * `undefined`: absent or outside the caller's scope (404). A replay returns the stored id after
   * the permission was checked again (the command only runs behind the current plan).
   */
  async adjust(
    secret: string,
    input: AttendanceAdjustmentInput,
  ): Promise<AttendanceAdjustmentResult | undefined> {
    try {
      return await this.authorization.execute(secret, this.adjustmentRepository.adjustAttendance, {
        ...input,
        hash: adjustmentHash(input),
      });
    } catch (error) {
      if (error instanceof AttendanceAdjustmentReplayed) return error.result;
      throw error;
    }
  }

  /** `undefined`: absent or outside the caller's scope (404). */
  adjustments(
    secret: string,
    query: AttendanceAdjustmentQuery,
  ): Promise<AttendanceAdjustmentList | undefined> {
    return this.authorization.query(secret, this.adjustmentRepository.attendanceAdjustments, query);
  }
}
