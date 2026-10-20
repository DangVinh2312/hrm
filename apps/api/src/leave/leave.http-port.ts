import type { AppConfig } from '../config/app.config.js';
import type { LeaveService } from './leave.service.js';

export const LEAVE_HTTP_PORT = Symbol('LEAVE_HTTP_PORT');

/** Bound leave reads (T7); `undefined` is absent or not visible (404). */
export interface LeaveHttpPort extends Pick<LeaveService, 'balance' | 'reconciliation'> {
  readonly config: Pick<AppConfig, 'origin'>;
}
