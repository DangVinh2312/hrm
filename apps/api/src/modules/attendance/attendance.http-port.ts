import type { AppConfig } from '../../config/app.config.js';
import type { AttendanceService } from './attendance.service.js';

export const ATTENDANCE_HTTP_PORT = Symbol('ATTENDANCE_HTTP_PORT');

/** Bound attendance operations (T8); `period` is `undefined` when absent or not visible (404). */
export interface AttendanceHttpPort extends Pick<
  AttendanceService,
  'period' | 'periodState' | 'closePeriod' | 'reopenPeriod'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
