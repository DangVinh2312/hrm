// Equivalence of the SET-BASED approved effects with the correlated formulation they replaced
// (ADR 0018 bổ sung 2026-10-22; acceptance F-34): on a mixed dataset (approved, pending, rejected
// and cancelled requests, overlaps, half days, duplicated segments, WFH across a month edge, hire
// and leaving inside the month, calendar versions, signed adjustments, a closed month) the new
// facts, the new report and the close produce the SAME numbers, order, total, pages, snapshot JSON
// and hash and XLSX cells as the oracle in `hrm-attendance-effects-oracle.helper.ts`
// (the statements of 6ea1062). Synthetic people and fixed past months only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import {
  attendanceTotals,
  type AttendanceTotals,
} from '../dist/modules/attendance/helpers/attendance-calculation.helper.js';
import {
  buildSnapshot,
  canonicalSnapshot,
  parseSnapshot,
  snapshotHash,
} from '../dist/modules/attendance/helpers/attendance-snapshot.helper.js';
import {
  EFFECTS_SET_BASED_MIN_ROWS,
  approvedEffectsBySql,
  loadAttendanceFacts,
  totalsOf,
} from '../dist/modules/attendance/repositories/attendance-facts.repository.js';
import type { ReportResult } from '../dist/modules/report/report.types.js';
import { ExcelExportService } from '../dist/modules/report/services/excel-export.service.js';
import { insertApprovedHistory, insertEmployees } from './hrm-report-http.helper.ts';
import { startHrStack, type HrStack } from './hrm-stack.helper.ts';
import { attendanceFixture } from './hrm-attendance.helper.ts';
import {
  oracleApprovedEffectsSql,
  oracleAttendanceReport,
  oracleAuthorization,
  oracleLoadAttendanceFacts,
} from './hrm-attendance-effects-oracle.helper.ts';

let stack: HrStack;
let f: ReturnType<typeof attendanceFixture>;
let oracle: ReturnType<typeof oracleAuthorization>;
const everyone: string[] = [];

const MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05'];

const adjustment = (name: string, day: string, minutes: number) =>
  stack.migration.query(
    `INSERT INTO attendance_adjustment(id, employee_id, work_date, minutes, reason, actor_account_id)
     VALUES ($1, $2, CAST($3 AS date), $4, 'Điều chỉnh thử', $5)`,
    [randomUUID(), f.employeeOf(name), day, minutes, f.p('H').id],
  );

before(async () => {
  stack = await startHrStack();
  oracle = oracleAuthorization(stack);
  f = attendanceFixture(stack);
  await f.setup();
  for (const name of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) await f.hire(name, ['hr.employee']);
  for (const name of ['B1', 'B2']) await f.hire(name, ['hr.employee'], { inTeam: false });
  await f.hire('NEW', ['hr.employee'], { hiredOn: '2026-03-16' });
  await f.hire('GONE', ['hr.employee'], { hiredOn: '2025-01-06' });
  await f.hire('IDLE', ['hr.employee']);
  await stack.migration.query(
    `UPDATE employee SET terminated_on = DATE '2026-03-20' WHERE id = $1`,
    [f.employeeOf('GONE')],
  );
  for (const name of [
    'L1',
    'C',
    'H',
    'A1',
    'A2',
    'A3',
    'A4',
    'A5',
    'A6',
    'B1',
    'B2',
    'NEW',
    'GONE',
    'IDLE',
  ])
    everyone.push(f.employeeOf(name));

  // Every state of the request lifecycle; only `approved` is an effect.
  await f.fixtureRequest('A1', 'annual-leave', 'approved', ['2026-03-04']);
  await f.fixtureRequest('A1', 'annual-leave', 'approved', ['2026-03-05'], [540, 660]);
  await f.fixtureRequest('A1', 'unpaid-leave', 'approved', ['2026-03-05'], [540, 780]);
  await f.fixtureRequest('A1', 'wfh', 'approved', ['2026-03-31', '2026-04-01']);
  await f.fixtureRequest('A1', 'late-arrival', 'approved', ['2026-03-10'], [540, 600]);
  await f.fixtureRequest('A1', 'early-departure', 'approved', ['2026-03-12'], [1020, 1080]);
  await f.fixtureRequest('A1', 'unpaid-leave', 'pending_lead', ['2026-03-18']);
  await f.fixtureRequest('A1', 'annual-leave', 'pending_final', ['2026-03-19']);
  await f.fixtureRequest('A1', 'annual-leave', 'rejected', ['2026-03-20']);
  await f.fixtureRequest('A1', 'wfh', 'cancelled', ['2026-03-23', '2026-03-24']);
  // Two approved requests with identical segments (a tie in the aggregate's ORDER BY).
  await f.fixtureRequest('A2', 'late-arrival', 'approved', ['2026-03-10'], [540, 600]);
  await f.fixtureRequest('A2', 'late-arrival', 'approved', ['2026-03-10'], [540, 600]);
  await f.fixtureRequest('A2', 'wfh', 'approved', [
    '2026-03-02',
    '2026-03-03',
    '2026-03-04',
    '2026-03-05',
    '2026-03-06',
  ]);
  // A decision reversed (approved, then cancelled by HR) and one that stayed.
  await f.fixtureRequest('A3', 'unpaid-leave', 'cancelled', ['2026-03-06']);
  await f.fixtureRequest('A3', 'unpaid-leave', 'approved', ['2026-03-09'], [540, 780]);
  await f.fixtureRequest('A3', 'annual-leave', 'approved', ['2026-04-14']);
  await f.fixtureRequest('A4', 'annual-leave', 'rejected', ['2026-03-17']);
  await f.fixtureRequest('A4', 'wfh', 'pending_lead', ['2026-03-17']);
  await f.fixtureRequest(
    'B1',
    'annual-leave',
    'approved',
    ['2026-03-25', '2026-03-26'],
    [540, 780],
  );
  await f.fixtureRequest('B1', 'early-departure', 'approved', ['2026-04-02'], [1020, 1080]);
  await f.fixtureRequest('B2', 'late-arrival', 'approved', ['2026-05-04'], [540, 570]);
  await f.fixtureRequest('NEW', 'annual-leave', 'approved', ['2026-03-17']);
  await f.fixtureRequest('NEW', 'unpaid-leave', 'approved', ['2026-03-10']); // before hiring
  await f.fixtureRequest('GONE', 'unpaid-leave', 'approved', ['2026-03-23']); // after leaving
  await f.fixtureRequest('GONE', 'wfh', 'approved', ['2026-03-18']);
  await f.fixtureRequest('A5', 'annual-leave', 'approved', ['2026-02-27']);
  await f.fixtureRequest('A5', 'unpaid-leave', 'pending_final', ['2026-04-06']);

  // Signed adjustments, some months with none.
  await adjustment('A1', '2026-03-10', 120);
  await adjustment('A1', '2026-03-11', -60);
  await adjustment('A1', '2026-04-03', 30);
  await adjustment('A3', '2026-03-09', -30);
  await adjustment('B1', '2026-03-25', 45);
  await adjustment('NEW', '2026-03-18', 15);
  await adjustment('A5', '2026-02-27', -15);

  // Calendar versions: a holiday set, another added, the first reverted, plus a makeup Saturday.
  const set = async (
    day: { date: string } & ({ holiday: string | null } | { makeup: boolean }),
  ) => {
    const calendar = await stack.workCalendar.year(f.p('H').secret, 2026);
    assert.ok(calendar);
    await stack.workCalendar.setDay(f.p('H').fresh, { expectedVersion: calendar.version, ...day });
  };

  await set({ date: '2026-03-12', holiday: 'Ngày lễ thử' });
  await set({ date: '2026-03-19', holiday: 'Ngày lễ thử 2' });
  await set({ date: '2026-03-12', holiday: null });
  await set({ date: '2026-03-14', makeup: true });
  await set({ date: '2026-04-30', holiday: 'Ngày lễ thử 3' });
});

after(() => stack?.stop());

const secretOf = async (who: string) => (who === 'root' ? stack.root() : f.p(who).secret);

test('the set-based reader returns, per employee and month, the correlated fragment (text-identical)', async () => {
  const rows = MONTHS.map((m) => `(DATE '${m}-01', DATE '${m}-01' + interval '1 month')`).join(',');
  const window = { first: `DATE '${MONTHS[0]}-01'`, next: `DATE '2026-06-01'` };
  const source = `SELECT e.id, m.first, CAST(m.next AS date) AS next FROM employee e, (VALUES ${rows}) m(first, next)`;
  const [fast, slow] = await Promise.all([
    stack.migration.query<{ k: string; effects: string }[]>(
      `WITH k AS (${source}), fx AS (${approvedEffectsBySql('(SELECT DISTINCT id FROM k)', window)})
       SELECT k.id::text || k.first::text AS k, COALESCE(fx.effects, '[]'::json)::text AS effects
         FROM k LEFT JOIN fx ON fx.id = k.id AND fx.first = k.first ORDER BY k.id, k.first`,
    ),
    stack.migration.query<{ k: string; effects: string }[]>(
      `WITH k AS (${source})
       SELECT k.id::text || k.first::text AS k, ${oracleApprovedEffectsSql('k.id', 'k.first', 'k.next')}::text AS effects
         FROM k ORDER BY k.id, k.first`,
    ),
  ]);
  assert.equal(slow.length, everyone.length * MONTHS.length);
  assert.ok(slow.some((row) => row.effects !== '[]'));
  assert.deepEqual(fast, slow);
  // The reader is bounded by the employees handed to it: nobody else's effects are read.
  const [one] = await stack.migration.query<{ groups: string }[]>(
    `WITH k AS (SELECT CAST($1 AS uuid) AS id), fx AS (${approvedEffectsBySql('k', window)})
     SELECT count(DISTINCT id)::text AS groups FROM fx`,
    [f.employeeOf('A1')],
  );
  assert.equal(one!.groups, '1');
});

test('only approved requests are effects: pending, rejected and cancelled ones add nothing', async () => {
  const [a1] = await loadAttendanceFacts(stack.migration.manager, '2026-03', [f.employeeOf('A1')]);
  assert.deepEqual(
    a1!.effects.map((e) => `${e.date} ${e.kind}`),
    [
      '2026-03-04 annual-leave',
      '2026-03-05 annual-leave',
      '2026-03-05 unpaid-leave',
      '2026-03-10 late-arrival',
      '2026-03-12 early-departure',
      '2026-03-31 wfh',
    ],
  );
  assert.equal(a1!.adjustmentMinutes, 60);
  const [idle] = await loadAttendanceFacts(stack.migration.manager, '2026-03', [
    f.employeeOf('IDLE'),
  ]);
  assert.deepEqual([idle!.effects, idle!.adjustmentMinutes], [[], 0]);
});

test('loadAttendanceFacts equals the correlated facts for every month and every id set', async () => {
  const manager = stack.migration.manager;
  const sets: (string[] | null)[] = [
    null,
    [],
    [f.employeeOf('A1')],
    [f.employeeOf('IDLE')],
    [f.employeeOf('A2'), f.employeeOf('NEW'), f.employeeOf('GONE'), f.employeeOf('B1')],
    [...everyone].reverse(),
    [randomUUID()],
  ];
  for (const month of MONTHS)
    for (const ids of sets)
      assert.deepEqual(
        await loadAttendanceFacts(manager, month, ids),
        await oracleLoadAttendanceFacts(manager, month, ids),
        `facts ${month} ids=${ids === null ? 'all' : ids.length}`,
      );
});

test('the attendance sheet of an employee equals the totals of the correlated facts', async () => {
  for (const name of ['A1', 'A2', 'A3', 'NEW', 'GONE', 'IDLE', 'B1'])
    for (const month of MONTHS.slice(0, 3)) {
      const sheet = await f.sheet(name, month, 'H');
      assert.ok(sheet);
      const [facts] = await oracleLoadAttendanceFacts(stack.migration.manager, month, [
        f.employeeOf(name),
      ]);
      const expected: AttendanceTotals = totalsOf(month, facts!);
      assert.deepEqual({ ...sheet }, { ...sheet, ...expected }, `${name} ${month}`);
    }
});

type Persona = string;
const personas: Persona[] = ['root', 'C', 'H', 'L1', 'A1', 'B1', 'NEW', 'N'];
const ranges = [
  ['2026-03', '2026-03'],
  ['2026-02', '2026-05'],
  ['2026-04', '2026-04'],
  ['2026-01', '2026-01'],
] as const;
const pages = [
  [100, 0],
  [3, 0],
  [3, 3],
  [4, 8],
  [1, 11],
  [5, 1000],
  [EFFECTS_SET_BASED_MIN_ROWS + 200, 0],
  [5000, 0],
] as const;

async function sameReports(label: string) {
  let compared = 0;
  for (const who of personas) {
    if (who === 'N' && !f.people.N) f.people.N = await stack.person([]);
    const secret = await secretOf(who);
    for (const [from, to] of ranges)
      for (const [limit, offset] of pages) {
        const input = { kind: 'attendance', from, to, limit, offset } as const;
        const [fast, slow] = await Promise.all([
          stack.reports.query(secret, input),
          oracle.query(secret, oracleAttendanceReport, input),
        ]);
        assert.deepEqual(
          fast,
          slow,
          `${label} ${who} ${from}..${to} limit ${limit} offset ${offset}`,
        );
        assert.equal(JSON.stringify(fast), JSON.stringify(slow));
        compared += 1;
        if (limit === 100) {
          const [lateEarly, wfh] = (await Promise.all([
            stack.reports.query(secret, { ...input, kind: 'late-early' }),
            stack.reports.query(secret, { ...input, kind: 'wfh' }),
          ])) as [
            Extract<ReportResult, { kind: 'late-early' }>,
            Extract<ReportResult, { kind: 'wfh' }>,
          ];
          assert.equal(lateEarly.total, slow.total);
          assert.equal(wfh.total, slow.total);
          assert.deepEqual(
            lateEarly.rows.map((r) => [r.employeeId, r.month, r.lateCount]),
            slow.rows.map((r) => [r.employeeId, r.month, r.lateCount]),
          );
          assert.deepEqual(
            wfh.rows.map((r) => [r.employeeId, r.month, r.wfhDays]),
            slow.rows.map((r) => [r.employeeId, r.month, r.wfhDays]),
          );
        }
      }
  }
  return compared;
}

test('the attendance report equals the correlated report for every scope, range and page (open months)', async () => {
  assert.equal(await sameReports('open'), personas.length * ranges.length * pages.length);
  // The report is company-wide (COO, HR): a lead and a stranger get an empty page, not a filtered one.
  const input = {
    kind: 'attendance',
    from: '2026-03',
    to: '2026-03',
    limit: 100,
    offset: 0,
  } as const;
  assert.ok(Number((await stack.reports.query(f.p('H').secret, input)).total) > 0);
  for (const who of ['L1', 'N'])
    assert.equal((await stack.reports.query(f.p(who).secret, input)).total, '0');
});

const sheetOf = async (value: unknown) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    (await new ExcelExportService().render(value as never)) as unknown as ArrayBuffer,
  );
  return workbook.worksheets.map((sheet) => JSON.stringify(sheet.getSheetValues()));
};

test('XLSX cells equal; a close writes the snapshot and hash the correlated facts give; closed month reads equal', async () => {
  const input = {
    kind: 'attendance',
    from: '2026-03',
    to: '2026-04',
    limit: 5000,
    offset: 0,
  } as const;
  const hr = f.p('H').secret;
  assert.deepEqual(
    await sheetOf(await stack.reports.query(hr, input)),
    await sheetOf(await oracle.query(hr, oracleAttendanceReport, input)),
  );

  const month = '2026-03';
  const facts = await oracleLoadAttendanceFacts(stack.migration.manager, month, null);
  const [{ version }] = (await stack.migration.query<{ version: string }[]>(
    `SELECT version::text AS version FROM work_calendar`,
  )) as [{ version: string }];
  const expected = buildSnapshot(
    month,
    version,
    facts.map((row) => ({ employeeId: row.id, ...totalsOf(month, row) })),
  );
  await stack.attendance.closePeriod(f.p('H').fresh, { month });
  const [stored] = await stack.migration.query<{ snapshot: unknown; hash: string }[]>(
    `SELECT snapshot, snapshot_hash AS hash FROM attendance_period WHERE month = DATE '2026-03-01'`,
  );
  // jsonb does not keep key order, so compare the canonical form (the form that is hashed).
  assert.equal(canonicalSnapshot(parseSnapshot(stored!.snapshot)), canonicalSnapshot(expected));
  assert.equal(stored!.hash, snapshotHash(expected));

  // March is now read from its snapshot, April still live: reports stay equal to the oracle.
  assert.equal(await sameReports('closed'), personas.length * ranges.length * pages.length);
  assert.deepEqual(
    await sheetOf(await stack.reports.query(hr, input)),
    await sheetOf(await oracle.query(hr, oracleAttendanceReport, input)),
  );
  // And the sheet of a closed month still equals what the facts compute (hash re-verified).
  const closed = await f.sheet('A1', month, 'H');
  assert.ok(closed);
  const [a1] = facts.filter((row) => row.id === f.employeeOf('A1'));
  assert.equal(
    closed.paidMinutes,
    attendanceTotals({
      month,
      hiredOn: a1!.hiredOn,
      terminatedOn: a1!.terminatedOn,
      calendar: { paidHolidays: new Set(a1!.holidays), makeupDays: new Set(a1!.makeupDays) },
      effects: a1!.effects,
      adjustmentMinutes: a1!.adjustmentMinutes,
    }).paidMinutes,
  );
});

test('with thousands of employees the report, facts and snapshot still equal the correlated ones', async () => {
  const bulk = 2100;
  await insertEmployees(stack, 1, bulk);
  const team = (await stack.teams.create(await stack.freshRoot(), { name: 'Bulk' })).id;
  await insertApprovedHistory(stack, stack.rootId, team, 1, bulk);
  await stack.migration.query(
    `INSERT INTO attendance_adjustment(id, employee_id, work_date, minutes, reason, actor_account_id)
     SELECT gen_random_uuid(), ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, DATE '2026-03-10',
            CASE WHEN g % 3 = 0 THEN -30 ELSE 45 END, 'Điều chỉnh khối', $1
       FROM generate_series(1, ${bulk}) g WHERE g % 2 = 0`,
    [f.p('H').id],
  );
  await stack.migration.query('ANALYZE');
  const manager = stack.migration.manager;

  const idsOf = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    );

  for (const month of ['2026-03', '2026-04'])
    for (const ids of [
      null,
      idsOf(EFFECTS_SET_BASED_MIN_ROWS + 50),
      idsOf(EFFECTS_SET_BASED_MIN_ROWS - 1),
    ])
      assert.deepEqual(
        await loadAttendanceFacts(manager, month, ids),
        await oracleLoadAttendanceFacts(manager, month, ids),
        `facts ${month} ids=${ids === null ? 'all' : ids.length}`,
      );
  // March is closed (snapshot of the first sixteen), April open with every employee.
  const hr = f.p('H').secret;
  for (const [from, to, limit, offset] of [
    ['2026-04', '2026-04', 5000, 0],
    ['2026-03', '2026-04', 5000, 0],
    ['2026-04', '2026-04', 700, 1500],
    ['2026-04', '2026-04', 50, 0],
  ] as const) {
    const input = { kind: 'attendance', from, to, limit, offset } as const;
    // One after the other: both are bounded by the runner's 3 s deadline and a loaded machine
    // must not make the comparison itself the thing that times out.
    const t0 = Date.now();
    const fast = await stack.reports.query(hr, input).catch((e: unknown) => {
      throw new Error(
        `new ${from}..${to} ${limit}/${offset} after ${Date.now() - t0} ms: ${String(e)}`,
      );
    });
    const t1 = Date.now();
    const slow = await oracle.query(hr, oracleAttendanceReport, input).catch((e: unknown) => {
      throw new Error(
        `old ${from}..${to} ${limit}/${offset} after ${Date.now() - t1} ms (new took ${t1 - t0}): ${String(e)}`,
      );
    });
    assert.ok(Number(fast.total) >= bulk);
    assert.equal(JSON.stringify(fast), JSON.stringify(slow), `${from}..${to} ${limit}/${offset}`);
  }
  // Closing April writes the snapshot and hash the correlated facts give.
  const facts = await oracleLoadAttendanceFacts(manager, '2026-04', null);
  const [{ version }] = (await stack.migration.query<{ version: string }[]>(
    `SELECT version::text AS version FROM work_calendar`,
  )) as [{ version: string }];
  const expected = buildSnapshot(
    '2026-04',
    version,
    facts.map((row) => ({ employeeId: row.id, ...totalsOf('2026-04', row) })),
  );
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-04' });
  const [stored] = await stack.migration.query<{ snapshot: unknown; hash: string }[]>(
    `SELECT snapshot, snapshot_hash AS hash FROM attendance_period WHERE month = DATE '2026-04-01'`,
  );
  assert.equal(canonicalSnapshot(parseSnapshot(stored!.snapshot)), canonicalSnapshot(expected));
  assert.equal(stored!.hash, snapshotHash(expected));
});
