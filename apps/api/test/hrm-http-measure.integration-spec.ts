// Measurement, not a CI check: transactions, PostgreSQL round trips and latency of one HTTP request
// through the real AppModule (guard, controller, facade, runner) for the hot authenticated routes.
// It asserts NO timing; it only fails if a request is refused. Off unless HRM_HTTP_MEASURE=1;
// prints one JSON document to stdout. Synthetic data only.
//
// Counted per request: `ProductTransactionRunner.run` calls, and every `pg` client query (BEGIN,
// set_config, fence, work, COMMIT) the process sends while the request is in flight. Requests run
// one at a time, so nothing else shares the window.
import assert from 'node:assert/strict';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { type AppHttp, startAppHttp } from './app-http.helper.ts';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { attendanceFixture } from './hrm-attendance.helper.ts';
import { insertEmployees } from './hrm-report-http.helper.ts';

const enabled = process.env.HRM_HTTP_MEASURE === '1';
const RUNS = Number(process.env.HRM_HTTP_MEASURE_RUNS ?? 100);
const WARMUP = Number(process.env.HRM_HTTP_MEASURE_WARMUP ?? 20);
const ROWS = Number(process.env.HRM_HTTP_MEASURE_ROWS ?? 10_000);

let stack: ModuleStack;
let http: AppHttp;

before(
  async () => {
    if (!enabled) return;
    // Own container: the timing must not share the cluster with other files.
    stack = await startModuleStack({ isolated: true });
  },
  { timeout: 300_000 },
);

after(async () => {
  await http?.stop();
  await stack?.stop();
});

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);

  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

  return {
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    max: Number(sorted.at(-1)!.toFixed(2)),
  };
};

test(
  'HTTP cost of the hot authenticated routes (measurement; prints JSON, asserts no timing)',
  { skip: !enabled && 'set HRM_HTTP_MEASURE=1', timeout: 1_800_000 },
  async () => {
    http = await startAppHttp(stack);
    const { origin } = http;

    // HR administrator with a linked profile: the widest menu lookup (17 pairs).
    const f = attendanceFixture(stack);
    const hr = await f.hire('H', ['hr.employee', 'hr.admin'], { inTeam: false });
    await insertEmployees(stack, 1, ROWS);
    const headers = http.headers(hr.secret);
    const detailPath = `/api/hr/employees/${hr.employee}`;
    let flip = 0;

    const routes: Record<string, () => Promise<Response>> = {
      'GET /api/auth/me': () => fetch(`${origin}/api/auth/me`, { headers }),
      'GET /api/hr/employees/me': () => fetch(`${origin}/api/hr/employees/me`, { headers }),
      'GET /api/hr/employees?offset=80': () =>
        fetch(`${origin}/api/hr/employees?limit=20&offset=80`, { headers }),
      'GET /api/hr/employees/:id': () => fetch(origin + detailPath, { headers }),
      'PATCH /api/hr/employees/:id': async () => {
        const current = (await (await fetch(origin + detailPath, { headers })).json()) as {
          version: string;
          code: string;
          fullName: string;
        };
        // The version read above is outside the counted window: only the PATCH is measured.
        return measured(() =>
          fetch(origin + detailPath, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              expectedVersion: current.version,
              code: current.code,
              fullName: `Nhân viên đo ${flip++ % 2}`,
              position: null,
              classification: null,
            }),
          }),
        );
      },
    };

    let queries = 0;
    let transactions = 0;
    let counting = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally; called with `this`.
    const clientQuery = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      if (counting) queries++;
      return (clientQuery as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof clientQuery;
    const run = stack.runner.run.bind(stack.runner);
    stack.runner.run = ((...args: Parameters<typeof run>) => {
      if (counting) transactions++;
      return run(...args);
    }) as typeof stack.runner.run;

    let last = { queries: 0, transactions: 0, ms: 0 };

    async function measured(send: () => Promise<Response>): Promise<Response> {
      queries = 0;
      transactions = 0;
      counting = true;
      const start = performance.now();
      try {
        const response = await send();
        await response.arrayBuffer();
        last = { queries, transactions, ms: performance.now() - start };
        return response;
      } finally {
        counting = false;
      }
    }

    const results: Record<
      string,
      { transactions: number[]; queries: number[]; ms: ReturnType<typeof stats> }
    > = {};
    try {
      const samples: Record<string, { tx: Set<number>; q: Set<number>; ms: number[] }> = {};
      for (let round = 0; round < WARMUP + RUNS; round++)
        // Interleaved so drift hits every route alike.
        for (const [name, send] of Object.entries(routes)) {
          const response = name.startsWith('PATCH') ? await send() : await measured(send);
          assert.ok(response.ok, `${name} answered ${response.status}`);
          if (round < WARMUP) continue;
          const sample = (samples[name] ??= { tx: new Set(), q: new Set(), ms: [] });
          sample.tx.add(last.transactions);
          sample.q.add(last.queries);
          sample.ms.push(last.ms);
        }
      for (const [name, sample] of Object.entries(samples))
        results[name] = {
          transactions: [...sample.tx].sort((a, b) => a - b),
          queries: [...sample.q].sort((a, b) => a - b),
          ms: stats(sample.ms),
        };
    } finally {
      pg.Client.prototype.query = clientQuery;
      stack.runner.run = run;
    }
    const [version] =
      await stack.migration.query<{ server_version: string }[]>('SHOW server_version');
    console.log(
      JSON.stringify(
        {
          environment: {
            node: process.version,
            postgres: version?.server_version,
            cpus: cpus().length,
            cpuModel: cpus()[0]?.model,
            memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
          },
          rows: ROWS,
          warmup: WARMUP,
          runs: RUNS,
          results,
        },
        null,
        2,
      ),
    );
  },
);
