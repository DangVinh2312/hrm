import { z } from 'zod';
import { type HttpClient, ResponseShapeError } from '../../infrastructure/http.client';

export const REPORT_PAGE_SIZE = 20;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const count = z.number().int().min(0).max(1_000_000);
const person = {
  employeeId: z.uuid(),
  employeeCode: z.string().max(32),
  employeeName: z.string().max(200),
};
const periodState = z.enum(['open', 'closed']);
const late = {
  lateCount: count,
  lateMinutes: count,
  earlyCount: count,
  earlyMinutes: count,
};

/** One schema per report (T9, `GET /api/hr/reports/:kind`); a row of another shape is a broken contract. */
const page = <K extends string, R extends z.ZodType>(kind: K, row: R) =>
  z.object({
    kind: z.literal(kind),
    total: z.string().regex(/^\d{1,18}$/),
    rows: z.array(row).max(100),
  });

const reportSchemas = {
  attendance: page(
    'attendance',
    z.object({
      ...person,
      ...late,
      month,
      periodState,
      scheduledMinutes: count,
      paidHolidayMinutes: count,
      unpaidMinutes: count,
      annualLeaveMinutes: count,
      paidMinutes: count,
      wfhDays: count,
    }),
  ),
  'late-early': page('late-early', z.object({ ...person, ...late, month, periodState })),
  wfh: page(
    'wfh',
    z.object({ ...person, month, periodState, wfhDays: count, overLimit: z.boolean() }),
  ),
  leave: page(
    'leave',
    z.object({
      ...person,
      year: z.number().int().min(1900).max(2100),
      asOn: z.iso.date(),
      annualMinutes: z.number().int().min(0).nullable(),
      entitledMinutes: z.number().int(),
      usedMinutes: z.number().int(),
      futureApprovedMinutes: z.number().int(),
      pendingMinutes: count,
      availableMinutes: count,
    }),
  ),
  seniority: page(
    'seniority',
    z.object({
      ...person,
      hiredOn: z.iso.date(),
      asOn: z.iso.date(),
      years: count,
      months: count,
      days: count,
      totalDays: count,
    }),
  ),
  birthday: page('birthday', z.object({ ...person, month, birthdayOn: z.iso.date() })),
} as const;

const reportSchema = z.discriminatedUnion('kind', [
  reportSchemas.attendance,
  reportSchemas['late-early'],
  reportSchemas.wfh,
  reportSchemas.leave,
  reportSchemas.seniority,
  reportSchemas.birthday,
]);

export type ReportKind = keyof typeof reportSchemas;

export type ReportResult = { [K in ReportKind]: z.infer<(typeof reportSchemas)[K]> }[ReportKind];

export type ReportRowOf<K extends ReportKind> = Extract<ReportResult, { kind: K }>['rows'][number];

/** Monthly reports take an inclusive `from..to` of `YYYY-MM`, the others an explicit cutoff `asOn`. */
export type ReportFilter =
  | {
      readonly kind: 'attendance' | 'late-early' | 'wfh' | 'birthday';
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: 'leave' | 'seniority'; readonly asOn: string };

export interface ReportFile {
  readonly blob: Blob;
  /** From the report and its range, never from the response header. */
  readonly fileName: string;
}

export interface ReportClient {
  /** `pageNumber` is 1-based. */
  page(filter: ReportFilter, pageNumber: number, signal?: AbortSignal): Promise<ReportResult>;

  /** XLSX of the whole scoped set (403 without the right or with an empty scope, 422 too large). */
  download(filter: ReportFilter, signal?: AbortSignal): Promise<ReportFile>;
}

const rangeOf = (filter: ReportFilter) =>
  'asOn' in filter ? filter.asOn : `${filter.from}_${filter.to}`;

const queryOf = (filter: ReportFilter) =>
  'asOn' in filter
    ? new URLSearchParams({ asOn: filter.asOn })
    : new URLSearchParams({ from: filter.from, to: filter.to });

export function createReportClient(http: HttpClient): ReportClient {
  return {
    async page(filter, pageNumber, signal) {
      const query = queryOf(filter);
      query.set('limit', String(REPORT_PAGE_SIZE));
      query.set('offset', String((pageNumber - 1) * REPORT_PAGE_SIZE));
      const result = await http.request(
        `/api/hr/reports/${filter.kind}?${query}`,
        reportSchema,
        signal ? { signal } : {},
      );
      // A well-formed body of another report is as broken as a malformed one.
      if (result.kind !== filter.kind) throw new ResponseShapeError();
      return result;
    },
    async download(filter, signal) {
      const blob = await http.download(
        `/api/hr/reports/${filter.kind}/export?${queryOf(filter)}`,
        XLSX_MIME,
        signal,
      );
      return { blob, fileName: `hrm-report-${filter.kind}-${rangeOf(filter)}.xlsx` };
    },
  };
}
