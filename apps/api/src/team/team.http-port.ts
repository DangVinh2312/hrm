import type { AppConfig } from '../config/app.config.js';
import type { TeamService } from './team.service.js';

export const TEAM_HTTP_PORT = Symbol('TEAM_HTTP_PORT');

/** Bound team operations (T3); membership/lead changes run under the exclusive fence. */
export interface TeamHttpPort extends Pick<
  TeamService,
  | 'list'
  | 'detail'
  | 'create'
  | 'rename'
  | 'addMember'
  | 'setPrimary'
  | 'endMembership'
  | 'assignLead'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
