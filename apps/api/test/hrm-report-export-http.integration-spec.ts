// T9 part B, item 2 (design §6.3 T9, ADR 0018 bổ sung T9B, acceptance R-04): the XLSX export
// budgets and the client disconnect, proven over a real HTTP listener (the real ReportController
// and error filter, a real socket) on real PostgreSQL with the six reports' own queries.
//  - exactly 5000 rows in the caller's scope is a file, 5001 is `422 error.exportTooLarge` (never a
//    cut file), a file over the byte budget is the same 422, and the 422 comes only AFTER the
//    caller was authorized (a caller with no grant gets 403, never the size answer);
//  - a client that closes its socket mid-export aborts the work: no further render, no re-check,
//    no listener left on the response, no connection left open.
// Synthetic people only. Dates are fixed past dates, so nothing depends on the day of the run.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import {
  EXPORT_MAX_BYTES,
  EXPORT_MAX_ROWS,
  ExcelExportService,
  XLSX_MIME,
} from '../dist/modules/report/services/excel-export.service.js';
import { ReportService } from '../dist/modules/report/services/report.service.js';
import type { ReportExportQuery } from '../dist/modules/report/report.types.js';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { type ReportHttp, insertEmployees, startReportHttp } from './hrm-report-http.helper.ts';

const ASON = '2026-06-30';
const path = `/api/hr/reports/seniority/export?asOn=${ASON}`;
const exportQuery: ReportExportQuery = { kind: 'seniority', asOn: ASON };

let stack: ModuleStack;
let http: ReportHttp;
let coo: string;
let nobody: string;
let selfOnly: string;
/** The service behind `/export` for the current test (the JSON side always uses the real one). */
let exporting: ReportService;
const exported: { signal?: AbortSignal; outcome?: Promise<unknown> }[] = [];

before(async () => {
  stack = await startModuleStack();
  coo = (await stack.person(['hr.employee', 'hr.coo'])).secret;
  nobody = (await stack.person([])).secret;
  selfOnly = (await stack.person(['hr.employee'])).secret;
  exporting = stack.reports;
  http = await startReportHttp({
    query: (secret, input) => stack.reports.query(secret, input),
    export: (secret, input, signal) => {
      const outcome = exporting.export(secret, input, signal);
      exported.push({ signal, outcome });
      return outcome;
    },
  });
  await insertEmployees(stack, 1, EXPORT_MAX_ROWS);
});

after(async () => {
  await http?.stop();
  await stack?.stop();
});

const get = (target: string, secret: string) =>
  fetch(`${http.url}${target}`, { headers: http.headers(secret) });

async function sheetOf(response: Response) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  return workbook.worksheets[0]!;
}

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

async function until(condition: () => boolean | Promise<boolean>, what: string) {
  const end = Date.now() + 10_000;
  while (!(await condition())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const openConnections = () =>
  new Promise<number>((resolve, reject) =>
    http.server.getConnections((error: Error | null, count: number) =>
      error ? reject(error) : resolve(count),
    ),
  );

test('exactly 5000 rows in scope is a complete file; the JSON report says the same total', async () => {
  const json = (await (await get(`/api/hr/reports/seniority?asOn=${ASON}`, coo)).json()) as {
    total: string;
  };
  assert.equal(json.total, String(EXPORT_MAX_ROWS));
  const response = await get(path, coo);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), XLSX_MIME);
  const sheet = await sheetOf(response);
  assert.equal(sheet.rowCount, EXPORT_MAX_ROWS + 1, 'header + every row, none cut');
  assert.equal(sheet.getRow(2).getCell(1).value, 'B000001');
  assert.equal(sheet.getRow(EXPORT_MAX_ROWS + 1).getCell(1).value, 'B005000');
});

test('a file over the byte budget is 422 with nothing cut; the same data under it is a file', async () => {
  const query = await stack.reports.query(coo, {
    ...exportQuery,
    limit: EXPORT_MAX_ROWS,
    offset: 0,
  });
  const size = (await new ExcelExportService().render(query)).length;
  assert.ok(size < EXPORT_MAX_BYTES, `a real 5000-row file (${size} bytes) is far below 5 MiB`);
  // Real rows can never reach 5 MiB (names are <= 200 characters), so the budget is shown on the
  // same real data with a smaller limit; the literal 5 MiB is covered in hrm-excel.spec.ts.
  const margin = 4096;
  exporting = new ReportService(
    stack.authorization,
    stack.modules.repositories.reports,
    new ExcelExportService({ maxBytes: size - margin }),
  );
  const over = await get(path, coo);
  assert.equal(over.status, 422);
  assert.deepEqual(await over.json(), { statusCode: 422, code: 'error.exportTooLarge' });
  exporting = new ReportService(
    stack.authorization,
    stack.modules.repositories.reports,
    new ExcelExportService({ maxBytes: size + margin }),
  );
  const within = await get(path, coo);
  assert.equal(within.status, 200);
  assert.equal((await sheetOf(within)).rowCount, EXPORT_MAX_ROWS + 1);
  exporting = stack.reports;
});

test('5001 rows in scope is 422 error.exportTooLarge, never a cut file; JSON still pages all of them', async () => {
  await insertEmployees(stack, EXPORT_MAX_ROWS + 1, EXPORT_MAX_ROWS + 1);
  const response = await get(path, coo);
  assert.equal(response.status, 422);
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true);
  assert.deepEqual(await response.json(), { statusCode: 422, code: 'error.exportTooLarge' });
  const json = (await (
    await get(`/api/hr/reports/seniority?asOn=${ASON}&limit=100&offset=4950`, coo)
  ).json()) as {
    total: string;
    rows: unknown[];
  };
  assert.equal(json.total, String(EXPORT_MAX_ROWS + 1));
  assert.equal(json.rows.length, 51, 'the JSON report is not capped by the export budget');
});

test('422 comes only after authorization: a caller with no grant gets the access error, not the size', async () => {
  for (const secret of [nobody, selfOnly]) {
    const response = await get(path, secret);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { statusCode: 403, code: 'error.accessDenied' });
  }
  // The caller with the grant still gets the size answer on the very same data.
  assert.equal((await get(path, coo)).status, 422);
});

/** After a cut: the work was aborted, nothing is left open and the response has no extra listener. */
async function assertNothingLeaks(index: number, before: number) {
  const record = exported[index]!;
  await until(() => record.signal?.aborted === true, 'the abort signal after the socket closed');
  assert.equal(await record.outcome, undefined, 'a cut client gets nothing');
  await until(async () => (await openConnections()) === 0, 'the server to drop the connection');
  const { res, listenersAtStart } = http.responses[before]!;
  await until(() => res.listenerCount('close') === listenersAtStart, 'the close listener to go');
}

test('client closes the socket while the file renders: no re-check, no leak', async () => {
  const entered = gate();
  const release = gate();
  let renders = 0;
  let permitsCalls = 0;
  exporting = new ReportService(
    {
      query: (...args: Parameters<typeof stack.authorization.query>) =>
        stack.authorization.query(...args),
      permits: (...args: Parameters<typeof stack.authorization.permits>) => {
        permitsCalls++;
        return stack.authorization.permits(...args);
      },
    } as never,
    stack.modules.repositories.reports,
    {
      render: async () => {
        renders++;
        entered.open();
        await release.opened;
        return Buffer.from('never delivered');
      },
    },
  );
  // 5001 employees by now: a one-month birthday report stays well under the 5000-row budget.
  const index = exported.length;
  const responses = http.responses.length;
  const request = httpRequest(
    `${http.url}/api/hr/reports/birthday/export?from=2026-02&to=2026-02`,
    { headers: http.headers(coo), agent: false },
  );
  request.on('error', () => undefined);
  request.end();
  await entered.opened;
  request.destroy();
  await until(() => exported[index]?.signal?.aborted === true, 'the abort signal');
  release.open();
  await assertNothingLeaks(index, responses);
  assert.equal(renders, 1);
  assert.equal(permitsCalls, 0, 'the grant is not re-checked for a client that is gone');
  exporting = stack.reports;
});

test('client closes the socket while the data is read: the file is never rendered', async () => {
  const reading = gate();
  const release = gate();
  let renders = 0;
  let permitsCalls = 0;
  exporting = new ReportService(
    {
      query: async (...args: Parameters<typeof stack.authorization.query>) => {
        const result = await stack.authorization.query(...args);
        reading.open();
        await release.opened;
        return result;
      },
      permits: (...args: Parameters<typeof stack.authorization.permits>) => {
        permitsCalls++;
        return stack.authorization.permits(...args);
      },
    } as never,
    stack.modules.repositories.reports,
    {
      render: () => {
        renders++;
        return Promise.resolve(Buffer.from('never delivered'));
      },
    },
  );
  const index = exported.length;
  const responses = http.responses.length;
  const request = httpRequest(
    `${http.url}/api/hr/reports/birthday/export?from=2026-02&to=2026-02`,
    { headers: http.headers(coo), agent: false },
  );
  request.on('error', () => undefined);
  request.end();
  await reading.opened;
  request.destroy();
  await until(() => exported[index]?.signal?.aborted === true, 'the abort signal');
  release.open();
  await assertNothingLeaks(index, responses);
  assert.equal(renders, 0, 'no render after the client left');
  assert.equal(permitsCalls, 0);
  exporting = stack.reports;
});

test('control: a client that stays gets the file and the grant is re-checked once', async () => {
  let permitsCalls = 0;
  exporting = new ReportService(
    {
      query: (...args: Parameters<typeof stack.authorization.query>) =>
        stack.authorization.query(...args),
      permits: (...args: Parameters<typeof stack.authorization.permits>) => {
        permitsCalls++;
        return stack.authorization.permits(...args);
      },
    } as never,
    stack.modules.repositories.reports,
  );
  const response = await get('/api/hr/reports/birthday/export?from=2026-02&to=2026-02', coo);
  assert.equal(response.status, 200);
  assert.ok((await sheetOf(response)).rowCount > 1);
  assert.equal(permitsCalls, 1);
  exporting = stack.reports;
});
