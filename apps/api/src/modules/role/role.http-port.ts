import type { AppConfig } from '../../config/app.config.js';
import type { RoleService } from './role.service.js';

export const ROLE_HTTP_PORT = Symbol('ROLE_HTTP_PORT');

/** Bound role matrix operations. */
export interface RoleHttpPort extends Pick<
  RoleService,
  'list' | 'accountPermissions' | 'create' | 'update' | 'remove'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
