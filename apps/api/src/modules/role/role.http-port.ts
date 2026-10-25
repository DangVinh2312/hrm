import type { AppConfig } from '../../config/app.config.js';
import type { RoleService } from './role.service.js';

export const ROLE_HTTP_PORT = Symbol('ROLE_HTTP_PORT');

/** Bound role matrix operations (ADR 0041 §3, ADR 0046). */
export interface RoleHttpPort extends Pick<RoleService, 'list' | 'accountPermissions'> {
  readonly config: Pick<AppConfig, 'origin'>;
}
