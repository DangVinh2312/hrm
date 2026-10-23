// Measurement, not a CI check (T9 part B item 2, ADR 0018 bổ sung T9B): latency of the six export
// queries and of the XLSX render at the 5000-row budget on a disposable PostgreSQL, against the
// runner deadline. It asserts NO timing (a loaded machine would make it flaky); it only fails if a
// query is refused, e.g. by the runner deadline. Off unless HRM_EXPORT_MEASURE=1; prints one JSON
// document to stdout. Synthetic people only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { after, before, test } from 'node:test';
import { ExcelExportService } from '../dist/modules/report/services/excel-export.service.js';
import type { ReportQuery } from '../dist/modules/report/report.types.js';
import { type HrStack, startHrStack } from './hrm-stack.helper.ts';
import { insertApprovedHistory, insertEmployees } from './hrm-report-http.helper.ts';

const ROWS = 5000;
const RUNS = Number(process.env.HRM_EXPORT_MEASURE_RUNS ?? 5);
const enabled = process.env.HRM_EXPORT_MEASURE === '1';

let stack: HrStack;

before(
  async () => {
    if (!enabled) return;
    // Own container: the deadline measurement must not share the cluster with other files.
    stack = await startHrStack({ isolated: true });
    await insertEmployees(stack, 1, ROWS);
    const team = (await stack.teams.create(await stack.freshRoot(), { name: 'T1' })).id;
    await insertApprovedHistory(stack, stack.rootId, team, 1, ROWS);
    // Planner statistics as autovacuum would have them shortly after a bulk load.
    await stack.migration.query('ANALYZE');
  },
  { timeout: 300_000 },
);

after(async () => {
  await stack?.stop();
});

const page = { limit: ROWS, offset: 0 } as const;
const cases: { name: string; query: ReportQuery }[] = [
  {
    name: 'attendance 1 month',
    query: { kind: 'attendance', from: '2026-03', to: '2026-03', ...page },
  },
  {
    name: 'late-early 1 month',
    query: { kind: 'late-early', from: '2026-03', to: '2026-03', ...page },
  },
  { name: 'wfh 1 month', query: { kind: 'wfh', from: '2026-03', to: '2026-03', ...page } },
  { name: 'leave', query: { kind: 'leave', asOn: '2026-06-30', ...page } },
  { name: 'seniority', query: { kind: 'seniority', asOn: '2026-06-30', ...page } },
  {
    name: 'birthday 12 months',
    query: { kind: 'birthday', from: '2026-01', to: '2026-12', ...page },
  },
  // Over budget on purpose: the export still runs the whole query (count over 60000) before the 422.
  {
    name: 'attendance 12 months (60000 in scope, page 5000)',
    query: { kind: 'attendance', from: '2026-01', to: '2026-12', ...page },
  },
];

const ms = (value: number) => Math.round(value * 10) / 10;

const stats = (values: number[]) => ({
  min: ms(Math.min(...values)),
  median: ms([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!),
  max: ms(Math.max(...values)),
});

test(
  'export query and render latency at 5000 rows',
  { skip: !enabled, timeout: 1_800_000 },
  async () => {
    const coo = (await stack.person(['hr.employee', 'hr.coo'])).secret;
    const exporter = new ExcelExportService();
    // The history is really folded into the sheets being measured (not a table of zeros).
    const sample = await stack.reports.query(coo, {
      kind: 'attendance',
      from: '2026-03',
      to: '2026-03',
      limit: 1,
      offset: 0,
    });
    assert.ok(sample.kind === 'attendance');
    assert.deepEqual(
      [sample.rows[0]?.wfhDays, sample.rows[0]?.annualLeaveMinutes, sample.rows[0]?.lateMinutes],
      [2, 480, 60],
    );
    const [pg] = await stack.migration.query<{ version: string }[]>('SELECT version() AS version');
    const results: unknown[] = [];
    for (const as of ['coo', 'root'] as const) {
      for (const { name, query } of cases) {
        const queryMs: number[] = [];
        const renderMs: number[] = [];
        let bytes = 0;
        let total = '';
        let rows = 0;
        let first: number | undefined;
        for (let run = 0; run <= RUNS; run++) {
          const secret = as === 'root' ? await stack.root() : coo;
          const t0 = performance.now();
          const result = await stack.reports.query(secret, query);
          const t1 = performance.now();
          total = result.total;
          rows = result.rows.length;
          if (rows > 0 && BigInt(total) <= BigInt(ROWS)) {
            const file = await exporter.render(result);
            bytes = file.length;
            renderMs.push(performance.now() - t1);
          }
          if (run === 0) first = t1 - t0;
          else queryMs.push(t1 - t0);
        }
        results.push({
          as,
          name,
          total,
          rows,
          fileBytes: bytes || null,
          firstRunQueryMs: first === undefined ? null : ms(first),
          queryMs: stats(queryMs),
          renderMs: renderMs.length ? stats(renderMs.slice(1)) : null,
        });
      }
    }
    const docker = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'])
      .toString()
      .trim();
    console.log(
      'EXPORT_MEASURE ' +
        JSON.stringify({
          env: {
            cpu: cpus()[0]?.model,
            cores: cpus().length,
            memGiB: Math.round(totalmem() / 2 ** 30),
            node: process.version,
            docker,
            postgres: pg?.version.split(' on ')[0],
            employees: ROWS,
            approvedRequests: ROWS * 5,
            approvedSegments: ROWS * 6,
            runsPerCase: RUNS,
            warmupDiscarded: 1,
          },
          results,
        }),
    );
    assert.ok(results.length === cases.length * 2);
  },
);
