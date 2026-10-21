import {
  ProductAccessDenied,
  type ProductAuthorization,
} from '../../../authorization/services/product-authority.service.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import { birthdayReport } from '../repositories/report-birthday.repository.js';
import { leaveReport } from '../repositories/report-leave.repository.js';
import { seniorityReport } from '../repositories/report-seniority.repository.js';
import {
  attendanceReport,
  lateEarlyReport,
  wfhReport,
} from '../repositories/report-sheet.repository.js';
import type { ReportExportQuery, ReportKind, ReportQuery, ReportResult } from '../report.types.js';
import {
  EXPORT_MAX_ROWS,
  ExcelExportService,
  XLSX_MIME,
  exportFileName,
} from './excel-export.service.js';

/** Queries registered at composition (`ProductAuthorization.query` refuses any other object). */
export const reportQueries = [
  attendanceReport,
  lateEarlyReport,
  wfhReport,
  leaveReport,
  seniorityReport,
  birthdayReport,
] as const;

const exportActions: Readonly<Record<ReportKind, string>> = {
  attendance: 'reportAttendance',
  'late-early': 'reportLateEarly',
  wfh: 'reportWfh',
  leave: 'reportLeave',
  seniority: 'reportSeniority',
  birthday: 'reportBirthday',
};

/** A rendered report ready to deliver; `fileName` is fixed by the report and its range. */
export interface ExportedReport {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Buffer;
}

/**
 * Report operations (T9). Each report is authorized on its own `employee` action and its plan
 * scope is applied inside the read before count and page, so the caller's rows are the only rows
 * ever aggregated. A caller with no grant gets an empty page (total `0`), not a status that tells
 * absent from foreign.
 */
export class ReportService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly exporter: Pick<ExcelExportService, 'render'> = new ExcelExportService(),
  ) {}

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
      case 'birthday':
        return this.authorization.query(secret, birthdayReport, input);
    }
  }

  /**
   * XLSX of one report (T9 part B, acceptance R-04): the SAME registered query as the JSON report
   * (one statement, one snapshot, the plan's scope before count) read with the page set to the
   * export budget, so there is no second query to drift. Then, outside the transaction and fence,
   * the file is rendered and the caller is authorized AGAIN (session, facts, plan) before the
   * bytes are handed over: a grant revoked while the file was built gives a refusal, not a file.
   * More than `EXPORT_MAX_ROWS` rows in the caller's scope is refused (422), never cut. A caller
   * with no grant is refused (403) instead of receiving an empty file. If the client has gone
   * (`signal` aborted) the remaining steps are skipped and nothing is returned; nothing is written
   * to disk, so there is nothing to clean up. shortcut: a revoke between the re-check and the
   * response write cannot be fenced (it is the same window as any delivered HTTP read); the
   * deliberate window is one authorization round trip.
   */
  async export(
    secret: string,
    input: ReportExportQuery,
    signal?: AbortSignal,
  ): Promise<ExportedReport | undefined> {
    const result = await this.query(secret, {
      ...input,
      limit: EXPORT_MAX_ROWS,
      offset: 0,
    });
    if (BigInt(result.total) > BigInt(EXPORT_MAX_ROWS))
      throw new ApiRejection('error.exportTooLarge');
    if (signal?.aborted) return undefined;
    const content = await this.exporter.render(result);
    if (signal?.aborted) return undefined;
    if (!(await this.authorization.permits(secret, 'employee', exportActions[input.kind])))
      throw new ProductAccessDenied();
    if (signal?.aborted) return undefined;
    return { fileName: exportFileName(input), contentType: XLSX_MIME, content };
  }
}
