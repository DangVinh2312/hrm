import type { AppConfig } from '../../config/app.config.js';
import type { HrMeView } from '../employee/employee.types.js';

export const HR_HTTP_PORT = Symbol('HR_HTTP_PORT');

/** HR session bootstrap (design §10.2); display only, every operation decides for itself. */
export interface HrHttpPort {
  readonly config: Pick<AppConfig, 'origin'>;

  me(sessionSecret: string): Promise<HrMeView>;
}
