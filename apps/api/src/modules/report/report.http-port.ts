import type { AppConfig } from '../../config/app.config.js';
import type { ReportService } from './services/report.service.js';

export const REPORT_HTTP_PORT = Symbol('REPORT_HTTP_PORT');

/** Bound report operations (T9); a caller outside every scope gets an empty page. */
export interface ReportHttpPort extends Pick<ReportService, 'query' | 'export'> {
  readonly config: Pick<AppConfig, 'origin'>;
}
