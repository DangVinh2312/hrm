// T9 part B without a database: the XLSX renderer and the export flow of ReportService (design
// §5.2 "Export dùng cùng scope", §11 budgets; acceptance R-04, R-08, ADR 0018 bổ sung T9B).
// Files are read back with ExcelJS and with the raw zip XML; people are synthetic. Stub
// authorization stands in for the database: what is tested is the order of the steps (query, render
// outside it, re-authorize, deliver), the budgets and the cell types.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { ApiRejection } from '../dist/infrastructure/helpers/api-error.helper.js';
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
  ExcelExportService,
  XLSX_MIME,
  exportFileName,
} from '../dist/modules/report/services/excel-export.service.js';
import { createProductModuleRepositories } from '../dist/infrastructure/product-modules.factory.js';
import { ReportService } from '../dist/modules/report/services/report.service.js';
import { parseReportExportQuery } from '../dist/modules/report/report.validator.js';
import type { ReportKind, ReportResult } from '../dist/modules/report/report.types.js';

const who = (n: number, name = `Nhân viên ${n}`) => ({
  employeeId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  employeeCode: `NV${String(n).padStart(3, '0')}`,
  employeeName: name,
});

const totals = {
  scheduledMinutes: 10560,
  paidHolidayMinutes: 480,
  unpaidMinutes: 240,
  annualLeaveMinutes: 600,
  paidMinutes: 10320,
  wfhDays: 2,
  lateCount: 1,
  lateMinutes: 60,
  earlyCount: 1,
  earlyMinutes: 30,
  // Signed, and already inside the paid total.
  adjustmentMinutes: -60,
};

const results: Record<ReportKind, ReportResult> = {
  attendance: {
    kind: 'attendance',
    total: '2',
    rows: [
      { ...who(1), month: '2026-03', periodState: 'closed', ...totals },
      { ...who(1), month: '2026-04', periodState: 'open', ...totals, wfhDays: 0 },
    ],
  },
  'late-early': {
    kind: 'late-early',
    total: '1',
    rows: [
      {
        ...who(2),
        month: '2026-03',
        periodState: 'open',
        lateCount: 3,
        lateMinutes: 90,
        earlyCount: 0,
        earlyMinutes: 0,
      },
    ],
  },
  wfh: {
    kind: 'wfh',
    total: '2',
    rows: [
      { ...who(3), month: '2026-05', periodState: 'open', wfhDays: 5, overLimit: true },
      { ...who(4), month: '2026-05', periodState: 'open', wfhDays: 1, overLimit: false },
    ],
  },
  leave: {
    kind: 'leave',
    total: '1',
    rows: [
      {
        ...who(5),
        year: 2026,
        asOn: '2026-06-30',
        annualMinutes: 5760,
        entitledMinutes: 2880,
        usedMinutes: 1080,
        futureApprovedMinutes: 480,
        pendingMinutes: 480,
        availableMinutes: 840,
      },
    ],
  },
  seniority: {
    kind: 'seniority',
    total: '1',
    rows: [
      {
        ...who(6),
        hiredOn: '2025-01-01',
        asOn: '2026-12-31',
        years: 2,
        months: 0,
        days: 0,
        totalDays: 730,
      },
    ],
  },
  birthday: {
    kind: 'birthday',
    total: '1',
    rows: [{ ...who(7), month: '2027-02', birthdayOn: '2027-02-28' }],
  },
};

const load = async (buffer: Buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
};

const cells = (sheet: ExcelJS.Worksheet) =>
  sheet.getRows(1, sheet.rowCount)!.map((row) => (row.values as unknown[]).slice(1));

test('each report is one sheet with Vietnamese headers and one row per employee and period', async () => {
  const exporter = new ExcelExportService();
  for (const [kind, result] of Object.entries(results)) {
    const workbook = await load(await exporter.render(result));
    assert.equal(workbook.worksheets.length, 1, kind);
    const sheet = workbook.worksheets[0]!;
    assert.equal(sheet.rowCount, result.rows.length + 1, `${kind}: header + rows`);
    const [header] = cells(sheet);
    assert.equal(header![0], 'Mã NV', kind);
    assert.equal(header![1], 'Họ tên', kind);
    assert.ok(
      header!.every((h) => typeof h === 'string' && h.length > 0 && !/^[a-z]+[A-Z]/.test(h)),
    );
    assert.equal(
      sheet.rowCount > 1 && sheet.getRow(2).getCell(1).value,
      result.rows[0]!.employeeCode,
    );
  }
});

test('numbers are numeric cells and dates are date cells, equal to the JSON of the report', async () => {
  const exporter = new ExcelExportService();
  const attendance = (await load(await exporter.render(results.attendance))).worksheets[0]!;
  const rows = cells(attendance);
  const [head, closed, open] = rows as [string[], unknown[], unknown[]];

  const at = (name: string) => head.indexOf(name);

  assert.ok(closed[at('Tháng')] instanceof Date);
  assert.equal((closed[at('Tháng')] as Date).toISOString().slice(0, 7), '2026-03');
  assert.equal(closed[at('Phút theo lịch')], 10560);
  assert.equal(typeof closed[at('Phút theo lịch')], 'number');
  assert.equal(open[at('Ngày WFH')], 0);
  assert.equal(closed[at('Kỳ công')], 'Đã chốt');
  assert.equal(open[at('Kỳ công')], 'Đang mở');
  assert.deepEqual(
    closed.slice(4),
    Object.values(totals),
    'the eleven totals of the DTO, in order (the signed adjustments last)',
  );

  const leave = cells((await load(await exporter.render(results.leave))).worksheets[0]!);
  assert.deepEqual(
    leave[1]!.slice(2).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
    [2026, '2026-06-30', 5760, 2880, 1080, 480, 480, 840],
  );
  const seniority = cells((await load(await exporter.render(results.seniority))).worksheets[0]!);
  assert.deepEqual(
    seniority[1]!.slice(2).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
    ['2025-01-01', '2026-12-31', 2, 0, 0, 730],
  );
  const wfh = cells((await load(await exporter.render(results.wfh))).worksheets[0]!);
  assert.deepEqual(
    wfh.slice(1).map((r) => [r[4], r[5]]),
    [
      [5, 'Có'],
      [1, 'Không'],
    ],
  );
});

test('a probation row (annualMinutes null, ADR 0039) leaves the rate cell empty, never the word null', async () => {
  const leave = results.leave as Extract<ReportResult, { kind: 'leave' }>;
  const probation: ReportResult = {
    ...leave,
    rows: leave.rows.map((row) => ({ ...row, annualMinutes: null })),
  };
  const sheet = (await load(await new ExcelExportService().render(probation))).worksheets[0]!;
  const [head, row] = cells(sheet) as [string[], unknown[]];
  const cell = row[head.indexOf('Định mức năm (phút)')];
  assert.ok(cell === null || cell === undefined || cell === '', String(cell));
  assert.ok(!row.some((value) => String(value).toLowerCase() === 'null'));
});

test('birthday sheet holds the day and month of the year shown, never a birth year', async () => {
  const exporter = new ExcelExportService();
  const buffer = await exporter.render(results.birthday);
  const sheet = (await load(buffer)).worksheets[0]!;
  const row = cells(sheet)[1]!;
  assert.equal((row[3] as Date).toISOString().slice(0, 10), '2027-02-28');
  // The cell is shown as day/month; the date inside is the displayed year, not a birth year.
  assert.equal(sheet.getRow(2).getCell(4).numFmt, 'dd/mm');
});

test('text that starts with = + - @ tab or CR stays text: no formula cell', async () => {
  const hostile = [
    '=1+1',
    '+SUM(A1:A2)',
    '-2+3',
    '@SUM(1)',
    '\t=1+1',
    '\r=1+1',
    '=HYPERLINK("http://example.invalid","x")',
  ];
  const exporter = new ExcelExportService();
  for (const [kind, base] of Object.entries(results)) {
    const rows = base.rows.map((row, i) => ({
      ...row,
      employeeName: hostile[i % hostile.length]!,
      employeeCode: hostile[(i + 1) % hostile.length]!,
    }));
    const buffer = await exporter.render({ ...base, rows } as ReportResult);
    const sheet = (await load(buffer)).worksheets[0]!;
    for (const [i, row] of rows.entries()) {
      for (const [column, text] of [
        [1, row.employeeCode],
        [2, row.employeeName],
      ] as const) {
        const cell = sheet.getRow(i + 2).getCell(column);
        assert.equal(cell.type, ExcelJS.ValueType.String, `${kind} ${text}`);
        assert.equal(typeof cell.value, 'string');
        assert.equal((cell as { formula?: unknown }).formula, undefined, `${kind}: formula`);
        assert.ok((cell.value as string).endsWith(text.slice(1)), `${kind}: text kept`);
      }
    }
  }
});

test('file name is fixed by report and range, ASCII only, from validated parts', () => {
  const name = (kind: ReportKind, query: unknown) =>
    exportFileName(parseReportExportQuery(kind, query));

  assert.equal(
    name('attendance', { from: '2026-03', to: '2026-04' }),
    'hrm-report-attendance-2026-03_2026-04.xlsx',
  );
  assert.equal(name('seniority', { asOn: '2026-12-31' }), 'hrm-report-seniority-2026-12-31.xlsx');
  assert.equal(
    name('birthday', { from: '2027-02', to: '2027-02' }),
    'hrm-report-birthday-2027-02_2027-02.xlsx',
  );
  assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('export query takes the report keys only: no limit/offset, same ranges as the JSON report', () => {
  const refused = (kind: ReportKind, query: unknown) =>
    assert.throws(() => parseReportExportQuery(kind, query), ProductInvalidRequest);

  assert.deepEqual(parseReportExportQuery('wfh', { from: '2026-01', to: '2026-12' }), {
    kind: 'wfh',
    from: '2026-01',
    to: '2026-12',
  });
  assert.deepEqual(parseReportExportQuery('leave', { asOn: '2026-06-30' }), {
    kind: 'leave',
    asOn: '2026-06-30',
  });
  for (const kind of ['attendance', 'late-early', 'wfh', 'birthday'] as const) {
    refused(kind, { from: '2025-11', to: '2026-11' });
    refused(kind, { from: '2026-11', to: '2026-10' });
    refused(kind, { from: '2026-11', to: '2026-11', limit: '5' });
    refused(kind, { from: '2026-11', to: '2026-11', offset: '0' });
    refused(kind, { from: '2026-11' });
    refused(kind, {});
  }
  for (const kind of ['leave', 'seniority'] as const) {
    refused(kind, { asOn: '2026-02-30' });
    refused(kind, { asOn: '2026-06-30', limit: '5' });
    refused(kind, undefined);
  }
});

/** Stub authorization: the order of calls is the behaviour under test. */
function stub(
  options: {
    readonly total?: string;
    readonly rows?: number;

    /** `export.maxRows` the export query read in its transaction (ADR 0041 §5); default the ceiling. */
    readonly maxRows?: number;

    readonly permitted?: () => boolean;

    /** Runs right after the data was read (inside `query`). */
    readonly afterQuery?: () => void;

    /** Runs right after the file was rendered. */
    readonly afterRender?: () => void;
  } = {},
) {
  const calls: string[] = [];
  const authorization = {
    // The registered export query reads the budget and the rows in one transaction; the service
    // gets both back (the limit and offset are its own concern, tested on PostgreSQL).
    query: (_secret: string, _query: unknown, input: { kind: string }) => {
      calls.push(`query export ${input.kind}`);
      const rows = Array.from({ length: options.rows ?? 1 }, (_, i) => ({
        ...who(i + 1),
        hiredOn: '2025-01-01',
        asOn: '2026-12-31',
        years: 1,
        months: 0,
        days: 0,
        totalDays: 365,
      }));
      options.afterQuery?.();
      return Promise.resolve({
        result: { kind: 'seniority', total: options.total ?? String(rows.length), rows },
        maxRows: options.maxRows ?? EXPORT_MAX_ROWS,
        maxBytes: EXPORT_MAX_BYTES,
      });
    },
    permits: (_secret: string, resource: string, action: string) => {
      calls.push(`permits ${resource}.${action}`);
      return Promise.resolve(options.permitted?.() ?? true);
    },
  };
  const exporter = {
    render: async (result: ReportResult) => {
      calls.push('render');
      const buffer = await new ExcelExportService().render(result);
      options.afterRender?.();
      return buffer;
    },
  };
  const service = new ReportService(
    authorization as never,
    createProductModuleRepositories().reports,
    exporter,
  );
  return { service, calls };
}

const seniorityQuery = { kind: 'seniority', asOn: '2026-12-31' } as const;

test('export: query, render outside it, re-authorize, then deliver (R-04)', async () => {
  const { service, calls } = stub();
  const file = await service.export('secret', seniorityQuery);
  assert.deepEqual(calls, ['query export seniority', 'render', 'permits employee.reportSeniority']);
  assert.equal(file?.fileName, 'hrm-report-seniority-2026-12-31.xlsx');
  assert.equal(file?.contentType, XLSX_MIME);
  assert.equal((await load(file.content)).worksheets[0]!.rowCount, 2);
});

test('export: access revoked while the file is rendered is never delivered', async () => {
  let revoked = false;
  const { service, calls } = stub({
    permitted: () => !revoked,
    afterRender: () => {
      revoked = true; // the grant disappears after the data was read, before delivery
    },
  });
  await assert.rejects(service.export('secret', seniorityQuery), ProductAccessDenied);
  assert.equal(calls.at(-1), 'permits employee.reportSeniority');
});

test('export: more rows than the budget is refused, never truncated (and never rendered)', async () => {
  const { service, calls } = stub({ total: String(EXPORT_MAX_ROWS + 1), rows: 3 });
  await assert.rejects(
    service.export('secret', seniorityQuery),
    (error) =>
      error instanceof ApiRejection &&
      error.code === 'error.exportTooLarge' &&
      error.status === 422,
  );
  assert.ok(!calls.includes('render'));
  // Exactly at the budget passes.
  const ok = stub({ total: String(EXPORT_MAX_ROWS), rows: 3 });
  assert.ok(await ok.service.export('secret', seniorityQuery));
  // The budget is the `export.maxRows` the query read (ADR 0041 §5), not only the ceiling.
  const lowered = stub({ total: '3', rows: 3, maxRows: 2 });
  await assert.rejects(
    lowered.service.export('secret', seniorityQuery),
    (error) => error instanceof ApiRejection && error.code === 'error.exportTooLarge',
  );
  assert.ok(!lowered.calls.includes('render'));
  assert.ok(
    await stub({ total: '3', rows: 3, maxRows: 3 }).service.export('secret', seniorityQuery),
  );
});

test('export: the renderer applies the lowered row and byte budgets, never above the ceilings', async () => {
  const exporter = new ExcelExportService();
  const rows = Array.from({ length: 3 }, (_, i) => ({
    ...who(i + 1),
    hiredOn: '2025-01-01',
    asOn: '2026-12-31',
    years: 1,
    months: 0,
    days: 0,
    totalDays: 365,
  }));
  const result = { kind: 'seniority', total: '3', rows } as const;

  const tooLarge = (error: unknown) =>
    error instanceof ApiRejection && error.code === 'error.exportTooLarge';

  await assert.rejects(
    exporter.render(result, { maxRows: 2, maxBytes: EXPORT_MAX_BYTES }),
    tooLarge,
  );
  await assert.rejects(exporter.render(result, { maxRows: 3, maxBytes: 1000 }), tooLarge);
  assert.ok(await exporter.render(result, { maxRows: 3, maxBytes: EXPORT_MAX_BYTES }));
  // A limit above the ceilings cannot widen them.
  await assert.rejects(
    new ExcelExportService({ maxBytes: 1000 }).render(result, {
      maxRows: EXPORT_MAX_ROWS * 2,
      maxBytes: EXPORT_MAX_BYTES * 2,
    }),
    tooLarge,
  );
});

test('export: a file over the byte budget is refused, not cut', async () => {
  const exporter = new ExcelExportService({ maxBytes: 1000 });
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ...who(i + 1),
    month: '2026-05',
    periodState: 'open' as const,
    wfhDays: 5,
    overLimit: true,
  }));
  await assert.rejects(
    exporter.render({ kind: 'wfh', total: '200', rows }),
    (error) => error instanceof ApiRejection && error.code === 'error.exportTooLarge',
  );
});

test('export: the default budget is 5 MiB; a 5000-row file past it is refused, one under it renders', async () => {
  assert.equal(EXPORT_MAX_BYTES, 5 * 1024 * 1024);
  const exporter = new ExcelExportService();

  // Names of random bytes barely compress, so 5000 rows of 3 KiB are about 11 MiB of XLSX. (Real
  // employee names are <= 200 characters, so no stored data reaches this; the DTO type has no cap.)
  const big = (length: number) =>
    Array.from({ length: EXPORT_MAX_ROWS }, (_, i) => ({
      ...who(i + 1),
      employeeName: randomBytes(length).toString('base64'),
      month: '2026-05',
      periodState: 'open' as const,
      wfhDays: 1,
      overLimit: false,
    }));

  await assert.rejects(
    exporter.render({ kind: 'wfh', total: String(EXPORT_MAX_ROWS), rows: big(3072) }),
    (error) => error instanceof ApiRejection && error.code === 'error.exportTooLarge',
  );
  const file = await exporter.render({
    kind: 'wfh',
    total: String(EXPORT_MAX_ROWS),
    rows: big(256),
  });
  assert.ok(file.length < EXPORT_MAX_BYTES && file.length > 0);
});

test('export: a client that went away gets nothing and nothing is rendered or re-checked', async () => {
  const gone = new AbortController();
  gone.abort();
  const early = stub();
  assert.equal(await early.service.export('secret', seniorityQuery, gone.signal), undefined);
  assert.ok(!early.calls.includes('render'));

  // Gone while the data is read: no render.
  const during = new AbortController();
  const read = stub({ afterQuery: () => during.abort() });
  assert.equal(await read.service.export('secret', seniorityQuery, during.signal), undefined);
  assert.ok(!read.calls.includes('render'));

  // Gone while the file is rendered: no re-check, nothing delivered.
  const rendering = new AbortController();
  const render = stub({ afterRender: () => rendering.abort() });
  assert.equal(await render.service.export('secret', seniorityQuery, rendering.signal), undefined);
  assert.ok(!render.calls.some((call) => call.startsWith('permits')));
});
