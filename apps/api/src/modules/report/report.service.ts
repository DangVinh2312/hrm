import type { ProductAuthorization } from '../../authorization/services/product-authority.service.js';
import { leaveReport } from './repositories/report-leave.repository.js';
import { seniorityReport } from './repositories/report-seniority.repository.js';
import {
  attendanceReport,
  lateEarlyReport,
  wfhReport,
} from './repositories/report-sheet.repository.js';
import type { ReportQuery, ReportResult } from './report.types.js';

/** Queries registered at composition (`ProductAuthorization.query` refuses any other object). */
export const reportQueries = [
  attendanceReport,
  lateEarlyReport,
  wfhReport,
  leaveReport,
  seniorityReport,
] as const;

/**
 * Report operations (T9 part A). Each report is authorized on its own `employee` action and its
 * plan scope is applied inside the read before count and page, so the caller's rows are the only
 * rows ever aggregated. A caller with no grant gets an empty page (total `0`), not a status that
 * tells absent from foreign.
 */
export class ReportService {
  constructor(private readonly authorization: ProductAuthorization) {}

  query(secret: string, input: ReportQuery): Promise<ReportResult> {
    switch (input.kind) {
      case 'attendance':
        return this.authorization.query(secret, attendanceReport, input);
      case 'late-early':
        return this.authorization.query(secret, lateEarlyReport, input);
      case 'wfh':
        return this.authorization.query(secret, wfhReport, input);
      case 'leave':
        return this.authorization.query(secret, leaveReport, input);
      case 'seniority':
        return this.authorization.query(secret, seniorityReport, input);
    }
  }
}
