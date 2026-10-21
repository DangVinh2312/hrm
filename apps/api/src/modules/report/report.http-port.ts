import type { AppConfig } from '../../config/app.config.js';
import type { ReportService } from './report.service.js';

export const REPORT_HTTP_PORT = Symbol('REPORT_HTTP_PORT');

/** Bound report operation (T9 part A); a caller outside every scope gets an empty page. */
export interface ReportHttpPort extends Pick<ReportService, 'query'> {
  readonly config: Pick<AppConfig, 'origin'>;
}
