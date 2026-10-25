import ExcelJS from 'exceljs';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import type {
  AttendanceReportRow,
  BirthdayReportRow,
  LateEarlyReportRow,
  LeaveReportRow,
  ReportEmployee,
  ReportExportQuery,
  ReportResult,
  SeniorityReportRow,
  WfhReportRow,
} from '../report.types.js';

/**
 * Export budgets (design §11) [P]: a file is the whole scoped set or a refusal, never a cut one.
 * 5000 rows is 50 employees × 12 months with a wide margin (the §11 workload is 50 × 24); the file
 * limit keeps the in-memory render bounded (a 5000-row sheet is well under 1 MiB).
 */
export const EXPORT_MAX_ROWS = 5000;

export const EXPORT_MAX_BYTES = 5 * 1024 * 1024;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Fixed name from the report and its validated range (`YYYY-MM`/`YYYY-MM-DD` only), so nothing the
 * caller typed beyond those parts reaches the header.
 */
export function exportFileName(query: ReportExportQuery): string {
  const range = 'asOn' in query ? query.asOn : `${query.from}_${query.to}`;
  return `hrm-report-${query.kind}-${range}.xlsx`;
}

type CellValue = string | number | Date | null;

interface Column<R> {
  readonly header: string;
  readonly width: number;

  readonly value: (row: R) => CellValue;

  readonly numFmt?: string;
}

const DAY_FORMAT = 'dd/mm/yyyy';
const MONTH_FORMAT = 'mm/yyyy';

/** Business dates are calendar days: the cell holds UTC midnight, so no time zone shifts the day. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const text = <R>(header: string, width: number, value: (row: R) => string): Column<R> => ({
  header,
  width,
  value,
});

const count = <R>(header: string, value: (row: R) => number | null): Column<R> => ({
  header,
  width: 16,
  value,
});

const employee = <R extends ReportEmployee>(): Column<R>[] => [
  text('Mã NV', 12, (row) => row.employeeCode),
  text('Họ tên', 28, (row) => row.employeeName),
];

const monthColumn = <R extends { readonly month: string }>(): Column<R> => ({
  header: 'Tháng',
  width: 10,
  value: (row) => day(`${row.month}-01`),
  numFmt: MONTH_FORMAT,
});

const state = <R extends { readonly periodState: 'open' | 'closed' }>(): Column<R> =>
  text('Kỳ công', 12, (row) => (row.periodState === 'closed' ? 'Đã chốt' : 'Đang mở'));

const dateColumn = <R>(
  header: string,
  value: (row: R) => string,
  numFmt = DAY_FORMAT,
): Column<R> => ({
  header,
  width: 14,
  value: (row) => day(value(row)),
  numFmt,
});

const lateEarly = <R extends LateEarlyReportRow | AttendanceReportRow>(): Column<R>[] => [
  count('Số lần đi muộn', (row) => row.lateCount),
  count('Phút đi muộn', (row) => row.lateMinutes),
  count('Số lần về sớm', (row) => row.earlyCount),
  count('Phút về sớm', (row) => row.earlyMinutes),
];

const attendance: Column<AttendanceReportRow>[] = [
  ...employee<AttendanceReportRow>(),
  monthColumn(),
  state(),
  count('Phút theo lịch', (row) => row.scheduledMinutes),
  count('Phút nghỉ lễ hưởng lương', (row) => row.paidHolidayMinutes),
  count('Phút nghỉ không lương', (row) => row.unpaidMinutes),
  count('Phút phép năm', (row) => row.annualLeaveMinutes),
  count('Phút được trả lương', (row) => row.paidMinutes),
  count('Ngày WFH', (row) => row.wfhDays),
  ...lateEarly<AttendanceReportRow>(),
  // Signed; already part of 'Phút được trả lương' (attendance.adjust).
  count('Phút điều chỉnh công', (row) => row.adjustmentMinutes),
];

const lateEarlySheet: Column<LateEarlyReportRow>[] = [
  ...employee<LateEarlyReportRow>(),
  monthColumn(),
  state(),
  ...lateEarly<LateEarlyReportRow>(),
];

const wfh: Column<WfhReportRow>[] = [
  ...employee<WfhReportRow>(),
  monthColumn(),
  state(),
  count('Số ngày WFH', (row) => row.wfhDays),
  text('Vượt 4 ngày/tháng', 18, (row) => (row.overLimit ? 'Có' : 'Không')),
];

const leave: Column<LeaveReportRow>[] = [
  ...employee<LeaveReportRow>(),
  count('Năm', (row) => row.year),
  dateColumn('Ngày cắt', (row) => row.asOn),
  count('Định mức năm (phút)', (row) => row.annualMinutes),
  count('Phút đã tích lũy', (row) => row.entitledMinutes),
  count('Phút đã dùng', (row) => row.usedMinutes),
  count('Phút đã duyệt sau ngày cắt', (row) => row.futureApprovedMinutes),
  count('Phút đang chờ', (row) => row.pendingMinutes),
  count('Phút khả dụng', (row) => row.availableMinutes),
];

const seniority: Column<SeniorityReportRow>[] = [
  ...employee<SeniorityReportRow>(),
  dateColumn('Ngày vào làm', (row) => row.hiredOn),
  dateColumn('Ngày cắt', (row) => row.asOn),
  count('Số năm', (row) => row.years),
  count('Số tháng', (row) => row.months),
  count('Số ngày', (row) => row.days),
  count('Tổng số ngày', (row) => row.totalDays),
];

/** The date is the one celebrated in the report's year, shown as day/month: no birth year. */
const birthday: Column<BirthdayReportRow>[] = [
  ...employee<BirthdayReportRow>(),
  monthColumn(),
  dateColumn('Ngày sinh nhật', (row) => row.birthdayOn, 'dd/mm'),
];

/**
 * XLSX renderer of the report DTOs (T9 part B). It receives the projection a report already
 * returns (never an entity), so a field outside it cannot reach a file. One flat sheet per report
 * with Vietnamese headers, one row per employee and period, typed cells: counts are numbers, days
 * and months are dates. Text is always written as a string cell; ExcelJS only emits a formula for
 * an object value `{ formula }`, which no column produces, so a name starting with `=`, `+`, `-`
 * or `@` stays text. No company template (acceptance D14 [P]).
 */
export class ExcelExportService {
  private readonly maxBytes: number;

  constructor(options: { readonly maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? EXPORT_MAX_BYTES;
  }

  /**
   * `limits` are the `export.maxRows` / `export.maxBytes` in force when the rows were read (ADR
   * 0041 §5); they can only be lower than the built-in ceilings, which always apply.
   */
  async render(
    result: ReportResult,
    limits: { readonly maxRows: number; readonly maxBytes: number } = {
      maxRows: EXPORT_MAX_ROWS,
      maxBytes: EXPORT_MAX_BYTES,
    },
  ): Promise<Buffer> {
    if (result.rows.length > Math.min(limits.maxRows, EXPORT_MAX_ROWS))
      throw new ApiRejection('error.exportTooLarge');
    const maxBytes = Math.min(limits.maxBytes, this.maxBytes);
    switch (result.kind) {
      case 'attendance':
        return this.write('Chấm công', attendance, result.rows, maxBytes);
      case 'late-early':
        return this.write('Đi muộn - Về sớm', lateEarlySheet, result.rows, maxBytes);
      case 'wfh':
        return this.write('WFH', wfh, result.rows, maxBytes);
      case 'leave':
        return this.write('Phép năm', leave, result.rows, maxBytes);
      case 'seniority':
        return this.write('Thâm niên', seniority, result.rows, maxBytes);
      case 'birthday':
        return this.write('Sinh nhật', birthday, result.rows, maxBytes);
    }
  }

  private async write<R>(
    name: string,
    columns: readonly Column<R>[],
    rows: readonly R[],
    maxBytes: number,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns.map(({ header, width }) => ({ header, width }));
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      const added = sheet.addRow(columns.map((column) => column.value(row)));
      for (const [index, column] of columns.entries())
        if (column.numFmt) added.getCell(index + 1).numFmt = column.numFmt;
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    if (buffer.length > maxBytes) throw new ApiRejection('error.exportTooLarge');
    return buffer;
  }
}
