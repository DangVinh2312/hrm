import type { AppConfig } from '../../config/app.config.js';
import type { EmployeeService } from './employee.service.js';

export const EMPLOYEE_HTTP_PORT = Symbol('EMPLOYEE_HTTP_PORT');

/**
 * Bound employee operations (T3): each rechecks session, plan and business guards in its own
 * transaction; `undefined` is absent or not visible (404). No runtime, pool or plan is reachable.
 */
export interface EmployeeHttpPort extends Pick<
  EmployeeService,
  | 'list'
  | 'detail'
  | 'profile'
  | 'create'
  | 'update'
  | 'confirmOfficial'
  | 'terminate'
  | 'identity'
  | 'updateIdentity'
  | 'leaveRates'
  | 'adjustLeaveRate'
  | 'linkAccount'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
