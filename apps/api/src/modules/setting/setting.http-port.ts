import type { AppConfig } from '../../config/app.config.js';
import type { SettingService } from './setting.service.js';

export const SETTING_HTTP_PORT = Symbol('SETTING_HTTP_PORT');

/** Bound setting operations. */
export interface SettingHttpPort extends Pick<
  SettingService,
  'list' | 'profile' | 'history' | 'security' | 'update'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
