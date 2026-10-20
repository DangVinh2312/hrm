import type { AppConfig } from '../config/app.config.js';
import type { WorkRequestService } from './work-request.service.js';

export const WORK_REQUEST_HTTP_PORT = Symbol('WORK_REQUEST_HTTP_PORT');

/** Bound work request operations (T5); `undefined` is absent or not visible (404). */
export interface WorkRequestHttpPort extends Pick<
  WorkRequestService,
  'submit' | 'list' | 'detail'
> {
  readonly config: Pick<AppConfig, 'origin'>;
}
