import type {
  ProductQuery,
  ProductQueryContext,
} from '../../../authorization/services/product-authority.service.js';
import type { SettingReadRepository } from '../../setting/repositories/setting-read.repository.js';
import { SettingKey } from '../../setting/setting.registry.js';
import type { ReportExportQuery, ReportKind, ReportQuery, ReportResult } from '../report.types.js';
import type { ReportBirthdayRepository } from './report-birthday.repository.js';
import type { ReportLeaveRepository } from './report-leave.repository.js';
import type { ReportSeniorityRepository } from './report-seniority.repository.js';
import type { ReportSheetRepository } from './report-sheet.repository.js';

/** The report repositories an export reads through (the same queries as the JSON reports). */
export interface ReportSources {
  readonly sheet: ReportSheetRepository;
  readonly leave: ReportLeaveRepository;
  readonly seniority: ReportSeniorityRepository;
  readonly birthday: ReportBirthdayRepository;
}

/** The scoped rows of an export with the budget in force when they were read. */
export interface ReportExportData {
  readonly result: ReportResult;
  readonly maxRows: number;
  readonly maxBytes: number;
}

/** Permission action of each report; an export has no action of its own (ADR 0018 T9B). */
export const reportExportActions: Readonly<Record<ReportKind, string>> = {
  attendance: 'reportAttendance',
  'late-early': 'reportLateEarly',
  wfh: 'reportWfh',
  leave: 'reportLeave',
  seniority: 'reportSeniority',
  birthday: 'reportBirthday',
};

/**
 * Export reads (T9 part B, ADR 0041 §5): for each report one registered query on the SAME action as
 * the JSON report, so the plan scope is the report's own. It reads `export.maxRows` and
 * `export.maxBytes` in the same read transaction, then runs the report's own query with the page
 * set to the row budget: no second statement for the data, no second authorization.
 */
export class ReportExportRepository {
  readonly #sources: ReportSources;
  readonly #settings: SettingReadRepository;

  constructor(sources: ReportSources, settings: SettingReadRepository) {
    this.#sources = sources;
    this.#settings = settings;
  }

  readonly queries: Readonly<
    Record<ReportKind, ProductQuery<ReportExportQuery, ReportExportData>>
  > = Object.fromEntries(
    (Object.keys(reportExportActions) as ReportKind[]).map((kind) => [
      kind,
      {
        resource: 'employee',
        action: reportExportActions[kind],
        run: (context: ProductQueryContext, input: ReportExportQuery) =>
          this.#export(context, input),
      },
    ]),
  ) as Record<ReportKind, ProductQuery<ReportExportQuery, ReportExportData>>;

  async #export(context: ProductQueryContext, input: ReportExportQuery): Promise<ReportExportData> {
    const budget = await this.#settings.read(context.tx.manager, [
      SettingKey.ExportMaxRows,
      SettingKey.ExportMaxBytes,
    ]);
    const maxRows = budget[SettingKey.ExportMaxRows];
    const result = await this.#run(context, { ...input, limit: maxRows, offset: 0 });
    return { result, maxRows, maxBytes: budget[SettingKey.ExportMaxBytes] };
  }

  #run(context: ProductQueryContext, query: ReportQuery): Promise<ReportResult> {
    switch (query.kind) {
      case 'attendance':
        return this.#sources.sheet.attendanceReport.run(context, query);
      case 'late-early':
        return this.#sources.sheet.lateEarlyReport.run(context, query);
      case 'wfh':
        return this.#sources.sheet.wfhReport.run(context, query);
      case 'leave':
        return this.#sources.leave.leaveReport.run(context, query);
      case 'seniority':
        return this.#sources.seniority.seniorityReport.run(context, query);
      case 'birthday':
        return this.#sources.birthday.birthdayReport.run(context, query);
    }
  }
}
