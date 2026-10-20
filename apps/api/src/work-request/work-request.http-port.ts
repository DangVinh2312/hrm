import type { AppConfig } from '../config/app.config.js';
import type { RequestApprovalService } from './services/request-approval.service.js';
import type { WorkRequestService } from './services/work-request.service.js';

export const WORK_REQUEST_HTTP_PORT = Symbol('WORK_REQUEST_HTTP_PORT');

/**
 * Bound work request operations (T5; T6 decisions, queues and decided history); `undefined` is
 * absent or not visible (404).
 */
export interface WorkRequestHttpPort
  extends
    Pick<WorkRequestService, 'submit' | 'list' | 'detail'>,
    Pick<RequestApprovalService, 'decide' | 'leadQueue' | 'finalQueue' | 'decided'> {
  readonly config: Pick<AppConfig, 'origin'>;
}
