import {
  ProductAccessDenied,
  type ProductAuthorization,
} from '../../authorization/services/product-authority.service.js';
import type {
  AttendancePeriodHistory,
  AttendancePeriodView,
  AttendanceQuery,
  PeriodCloseInput,
  PeriodReopenInput,
  PeriodResult,
} from './attendance.types.js';
import {
  attendancePeriod,
  attendancePeriodState,
  closePeriod,
  reopenPeriod,
} from './attendance-period.repository.js';

export const attendanceCommands = [closePeriod, reopenPeriod] as const;

export const attendanceQueries = [attendancePeriod, attendancePeriodState] as const;

/** Attendance operations bound to the registered commands/queries (T8). */
export class AttendanceService {
  constructor(private readonly authorization: ProductAuthorization) {}

  /** `undefined`: absent or outside the caller's scope (404). */
  period(secret: string, query: AttendanceQuery): Promise<AttendancePeriodView | undefined> {
    return this.authorization.query(secret, attendancePeriod, query);
  }

  /** `undefined`: the caller does not read the company row (404). */
  periodState(secret: string, month: string): Promise<AttendancePeriodHistory | undefined> {
    return this.authorization.query(secret, attendancePeriodState, { month });
  }

  async closePeriod(secret: string, input: PeriodCloseInput): Promise<PeriodResult> {
    const result = await this.authorization.execute(secret, closePeriod, input);
    // The company anchor always exists, so "not visible" means no grant (403), as for the calendar.
    if (!result) throw new ProductAccessDenied();
    return result;
  }

  async reopenPeriod(secret: string, input: PeriodReopenInput): Promise<PeriodResult> {
    const result = await this.authorization.execute(secret, reopenPeriod, input);
    if (!result) throw new ProductAccessDenied();
    return result;
  }
}
