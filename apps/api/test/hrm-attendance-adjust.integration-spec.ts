// T8 `attendance.adjust` on PostgreSQL (design §5.2, §7.3, §9, D07, ADR 0017/0018 bổ sung 2026-10-22;
// acceptance F-18..F-32): the HR writer of audited attendance adjustments (a signed number of paid
// minutes for one employee and one day, mandatory reason, optional reference, fresh session, open
// month, idempotent), their place in the monthly sheet, in the snapshot of a closed month and in
// the T9 attendance report. Past months are fixed (employees are hired 2026-01-05; March 2026 has
// 22 weekdays = 10560 scheduled minutes) so nothing depends on the run date, except the races of
// the last block, which use the month of the latest weekday on or before the DB date.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { after, before, test } from 'node:test';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { verifiedSnapshot } from '../dist/modules/attendance/helpers/attendance-snapshot.helper.js';
import { openClient, withClient } from './setup-postgres.ts';
import { type HrStack, startHrStack } from './hrm-stack.helper.ts';
import {
  attendanceFixture,
  failures,
  fulfilled,
  raced,
  refused,
  rejected,
  waitForLocks,
} from './hrm-attendance.helper.ts';

let stack: HrStack;
let f: ReturnType<typeof attendanceFixture>;

before(async () => {
  stack = await startHrStack();
  f = attendanceFixture(stack);
  await f.setup();
});

after(() => stack?.stop());

const MARCH = '2026-03';
const MARCH_BASE = 22 * 480;

const adjust = (
  secret: string,
  name: string,
  options: {
    workDate?: string;
    minutes?: number;
    reason?: string;
    reference?: string | null;
    key?: string;
  } = {},
) =>
  stack.attendance.adjust(secret, {
    employeeId: f.employeeOf(name),
    workDate: options.workDate ?? '2026-03-10',
    minutes: options.minutes ?? 120,
    reason: options.reason ?? 'Quên chấm công',
    reference: options.reference === undefined ? null : options.reference,
    idempotencyKey: options.key ?? randomUUID(),
  });

const rows = (name: string) =>
  stack.migration.query<
    {
      id: string;
      date: string;
      minutes: number;
      reason: string;
      reference: string | null;
      actor: string;
    }[]
  >(
    `SELECT id::text AS id, to_char(work_date,'YYYY-MM-DD') AS date, minutes, reason, reference,
            actor_account_id::text AS actor
       FROM attendance_adjustment WHERE employee_id = $1 ORDER BY created_at, id`,
    [f.employeeOf(name)],
  );

/** Everything an adjustment may write; a refused one leaves it unchanged. */
const everything = async (name: string) => ({
  entries: await rows(name),
  periods: await f.count('SELECT count(*)::text AS n FROM attendance_period'),
  claims: await f.count(
    `SELECT count(*)::text AS n FROM hr_idempotency WHERE operation = 'attendance.adjust'`,
  ),
  audits: await f.count(
    `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') = 'hr.attendance.adjust'`,
  ),
});

const paid = async (name: string, month = MARCH) => (await f.sheet(name, month, 'H'))?.paidMinutes;

test('F-18: HR adds an adjustment: one row, the sheet moves by the delta, one audit without the reason or the person', async () => {
  await f.hire('A1', ['hr.employee']);
  assert.equal(await paid('A1'), MARCH_BASE);
  const result = await adjust(f.p('H').fresh, 'A1', {
    minutes: 120,
    workDate: '2026-03-10',
    reason: 'Quên chấm công buổi chiều',
    reference: 'QĐ-2026/03 #7',
  });
  assert.ok(result);
  assert.deepEqual(await rows('A1'), [
    {
      id: result.id,
      date: '2026-03-10',
      minutes: 120,
      reason: 'Quên chấm công buổi chiều',
      reference: 'QĐ-2026/03 #7',
      actor: f.p('H').id,
    },
  ]);
  const sheet = await f.sheet('A1', MARCH, 'H');
  assert.equal(sheet?.paidMinutes, MARCH_BASE + 120);
  assert.equal(sheet?.adjustmentMinutes, 120);
  assert.equal(sheet?.scheduledMinutes, MARCH_BASE, 'the calendar and the leave kinds do not move');
  // The employee reads the same number on their own sheet; other months are untouched.
  assert.equal((await f.sheet('A1', MARCH))?.adjustmentMinutes, 120);
  assert.equal((await f.sheet('A1', '2026-04', 'H'))?.adjustmentMinutes, 0);
  // A negative entry lowers it; both stay in the table (append-only).
  await adjust(f.p('H').fresh, 'A1', { minutes: -60, workDate: '2026-03-11' });
  assert.equal(await paid('A1'), MARCH_BASE + 60);
  assert.equal((await rows('A1')).length, 2);
  const [audit] = await stack.migration.query<
    { kind: string; metadata: unknown; reason: string | null }[]
  >(
    `SELECT convert_from(event_kind,'UTF8') AS kind, safe_metadata AS metadata, reason FROM audit_outbox
      WHERE convert_from(event_kind,'UTF8') = 'hr.attendance.adjust' ORDER BY occurred_at LIMIT 1`,
  );
  assert.equal(audit?.kind, 'hr.attendance.adjust');
  assert.equal(audit?.reason, null);
  const text = JSON.stringify(audit);
  for (const secret of ['Quên chấm công', 'QĐ-2026', 'Nhân viên công giả'])
    assert.ok(!text.includes(secret), `audit must not carry "${secret}"`);
});

test('F-32: the list shows the entries of one month, newest first, with the total and a page budget', async () => {
  await f.hire('A2', ['hr.employee']);
  const first = await adjust(f.p('H').fresh, 'A2', { workDate: '2026-03-03', minutes: 30 });
  const second = await adjust(f.p('H').fresh, 'A2', {
    workDate: '2026-03-04',
    minutes: -10,
    reference: 'R-1',
  });
  await adjust(f.p('H').fresh, 'A2', { workDate: '2026-04-06', minutes: 5 });
  const query = { employeeId: f.employeeOf('A2'), month: MARCH, limit: 20, offset: 0 };
  const list = await stack.attendance.adjustments(f.p('H').secret, query);
  assert.ok(list && first && second);
  assert.equal(list.total, '2');
  assert.equal(list.adjustmentMinutes, 20);
  assert.deepEqual(
    list.items.map((item) => [item.id, item.workDate, item.minutes, item.reference]),
    [
      [second.id, '2026-03-04', -10, 'R-1'],
      [first.id, '2026-03-03', 30, null],
    ],
  );
  for (const item of list.items) {
    assert.deepEqual(Object.keys(item).sort(), [
      'createdAt',
      'id',
      'minutes',
      'reason',
      'reference',
      'workDate',
    ]);
  }
  const page = await stack.attendance.adjustments(f.p('H').secret, {
    ...query,
    limit: 1,
    offset: 1,
  });
  assert.equal(page?.total, '2');
  assert.deepEqual(
    page?.items.map((item) => item.id),
    [first.id],
  );
  // Reading needs the HR read grant, not a fresh session; nobody else reads the reasons.
  assert.equal(await stack.attendance.adjustments(f.p('A2').secret, query), undefined);
  assert.equal(await stack.attendance.adjustments(f.p('L1').secret, query), undefined);
  assert.equal(await stack.attendance.adjustments(f.p('C').secret, query), undefined);
});

test('F-19: only HR with a fresh session adjusts; everyone else is refused or sees 404, and nothing is written', async () => {
  await f.hire('A3', ['hr.employee']);
  const before = await everything('A3');
  await assert.rejects(adjust(f.p('H').secret, 'A3'), ProductAccessDenied);
  assert.equal(await adjust(f.p('A3').fresh, 'A3'), undefined, 'not even for oneself');
  assert.equal(await adjust(f.p('L1').fresh, 'A3'), undefined, 'a lead has no such right');
  assert.equal(await adjust(f.p('C').fresh, 'A3'), undefined, 'the COO has no such right');
  const stranger = await stack.person([]);
  assert.equal(await adjust(stranger.fresh, 'A3'), undefined);
  assert.deepEqual(await everything('A3'), before);
  // An employee that does not exist is the same 404 as one outside the caller's scope.
  assert.equal(
    await stack.attendance.adjust(f.p('H').fresh, {
      employeeId: randomUUID(),
      workDate: '2026-03-10',
      minutes: 60,
      reason: 'Không có',
      reference: null,
      idempotencyKey: randomUUID(),
    }),
    undefined,
  );
});

test('F-20: a retry with the same key writes nothing more; the same key for another payload is refused (422)', async () => {
  await f.hire('A4', ['hr.employee']);
  const key = randomUUID();
  const first = await adjust(f.p('H').fresh, 'A4', { key });
  assert.deepEqual(await adjust(f.p('H').fresh, 'A4', { key }), first);
  assert.equal((await rows('A4')).length, 1);
  const audited = (await everything('A4')).audits;
  assert.deepEqual(await adjust(f.p('H').fresh, 'A4', { key }), first);
  assert.equal((await everything('A4')).audits, audited, 'a replay does not audit again');
  for (const changed of [
    { minutes: 121 },
    { workDate: '2026-03-11' },
    { reason: 'Lý do khác' },
    { reference: 'R-2' },
  ])
    await assert.rejects(
      adjust(f.p('H').fresh, 'A4', { key, ...changed }),
      refused('error.idempotencyKeyReused', 422),
    );
  assert.equal((await rows('A4')).length, 1);
  assert.ok(await adjust(f.p('H').fresh, 'A4'), 'a new key is a new adjustment');
  assert.equal((await rows('A4')).length, 2);
});

test('F-21/D07: a closed month refuses the adjustment (409 error.periodClosed); an open month and a reopened one accept it', async () => {
  await f.hire('A5', ['hr.employee']);
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-04' });
  const before = await everything('A5');
  await assert.rejects(
    adjust(f.p('H').fresh, 'A5', { workDate: '2026-04-15' }),
    refused('error.periodClosed', 409),
  );
  assert.deepEqual(await everything('A5'), before);
  assert.ok(await adjust(f.p('H').fresh, 'A5', { workDate: '2026-05-04' }));
  await stack.attendance.reopenPeriod(f.p('H').fresh, {
    month: '2026-04',
    reason: 'Điều chỉnh công',
  });
  assert.ok(await adjust(f.p('H').fresh, 'A5', { workDate: '2026-04-15' }));
  assert.equal((await rows('A5')).length, 2);
});

test('F-28: the day must be inside the employment period', async () => {
  await f.hire('A6', ['hr.employee'], { hiredOn: '2026-02-02' });
  const before = await everything('A6');
  await assert.rejects(
    adjust(f.p('H').fresh, 'A6', { workDate: '2026-01-15' }),
    rejected('outside_employment'),
  );
  await stack.migration.query(
    `UPDATE employee SET terminated_on = DATE '2026-03-13' WHERE id = $1`,
    [f.employeeOf('A6')],
  );
  await assert.rejects(
    adjust(f.p('H').fresh, 'A6', { workDate: '2026-03-16' }),
    rejected('outside_employment'),
  );
  assert.deepEqual(await everything('A6'), before);
  assert.ok(await adjust(f.p('H').fresh, 'A6', { workDate: '2026-03-13' }), 'the last day counts');
  assert.ok(await adjust(f.p('H').fresh, 'A6', { workDate: '2026-02-02' }), 'so does the first');
});

test('F-22: the paid total of the month never goes below zero; refused entries leave nothing behind', async () => {
  // Hired Monday 2026-03-30: two weekdays in March = 960 scheduled minutes.
  await f.hire('A7', ['hr.employee'], { hiredOn: '2026-03-30' });
  assert.equal(await paid('A7'), 960);

  const date = (workDate: string, minutes: number) =>
    adjust(f.p('H').fresh, 'A7', { workDate, minutes });

  assert.ok(await date('2026-03-30', -600));
  const before = await everything('A7');
  // Entries of one month add up: 960 - 600 leaves 360, so -400 is refused and -360 is exactly zero.
  await assert.rejects(date('2026-03-31', -400), rejected('negative_total'));
  assert.deepEqual(await everything('A7'), before);
  assert.ok(await date('2026-03-31', -360));
  assert.equal(await paid('A7'), 0);
  await assert.rejects(date('2026-03-31', -1), rejected('negative_total'));
  // A positive entry makes room again.
  assert.ok(await date('2026-03-31', 30));
  assert.ok(await date('2026-03-31', -30));
  await assert.rejects(date('2026-03-31', -1), rejected('negative_total'));
  assert.equal(await paid('A7'), 0);
  // Another month is judged on its own total: April is a full month (22 weekdays).
  assert.ok(await date('2026-04-01', -1));
  // Approved unpaid leave is already in the number the entry is judged against.
  await f.fixtureRequest('A7', 'unpaid-leave', 'approved', ['2026-04-02']);
  assert.equal(await paid('A7', '2026-04'), 22 * 480 - 480 - 1);
  await assert.rejects(date('2026-04-03', -(22 * 480 - 480 - 1) - 1), rejected('negative_total'));
  assert.ok(await date('2026-04-03', -1440));
});

test('F-23: the snapshot of a closed month includes the adjustments; reopen, adjust and close again hashes the new total', async () => {
  await f.hire('A8', ['hr.employee']);
  const month = '2026-05';
  assert.ok(await adjust(f.p('H').fresh, 'A8', { workDate: '2026-05-06', minutes: 90 }));
  await stack.attendance.closePeriod(f.p('H').fresh, { month });

  const stored = async () => {
    const [row] = await stack.migration.query<
      { snapshot: unknown; hash: string; version: string }[]
    >(
      `SELECT snapshot, snapshot_hash AS hash, version::text AS version FROM attendance_period WHERE month = CAST($1 AS date)`,
      [`${month}-01`],
    );
    assert.ok(row);
    const verified = verifiedSnapshot(month, row.snapshot, row.hash);
    return {
      hash: row.hash,
      entry: verified.employees.find((e) => e.employeeId === f.employeeOf('A8')),
    };
  };

  const first = await stored();
  assert.equal(first.entry?.adjustmentMinutes, 90);
  const live = await f.sheet('A8', month, 'H');
  assert.equal(first.entry?.paidMinutes, live?.paidMinutes);
  assert.equal(live?.periodState, 'closed');
  // Closed: refused. Reopen: the snapshot goes; closing again with unchanged inputs gives the
  // same hash (F-12 with adjustments), a new adjustment a different one that includes it.
  await assert.rejects(
    adjust(f.p('H').fresh, 'A8', { workDate: '2026-05-07' }),
    refused('error.periodClosed', 409),
  );
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Thêm điều chỉnh' });
  await stack.attendance.closePeriod(f.p('H').fresh, { month });
  assert.equal((await stored()).hash, first.hash, 'unchanged inputs hash the same after a reopen');
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Thêm điều chỉnh' });
  assert.ok(await adjust(f.p('H').fresh, 'A8', { workDate: '2026-05-07', minutes: -30 }));
  await stack.attendance.closePeriod(f.p('H').fresh, { month });
  const third = await stored();
  assert.notEqual(third.hash, first.hash);
  assert.equal(third.entry?.adjustmentMinutes, 60);
  assert.equal(third.entry?.paidMinutes, (await f.sheet('A8', month, 'H'))?.paidMinutes);
  // The history of the month keeps its close/reopen events: adjustments are no events of it.
  assert.equal((await stack.attendance.periodState(f.p('H').secret, month))?.events.length, 5);
  // Later tests hire people from January: leave the month open for them.
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Dọn' });
});

test('F-24: the T9 attendance report counts the adjustments exactly as the sheet does, live and from a snapshot', async () => {
  await f.hire('A9', ['hr.employee']);
  assert.ok(await adjust(f.p('H').fresh, 'A9', { workDate: '2026-06-03', minutes: 200 }));

  const read = async () => {
    const page = await stack.reports.query(f.p('H').secret, {
      kind: 'attendance',
      from: '2026-06',
      to: '2026-06',
      limit: 100,
      offset: 0,
    });
    assert.equal(page.kind, 'attendance');
    return page.rows.find((row) => row.employeeId === f.employeeOf('A9'));
  };

  const sheet = await f.sheet('A9', '2026-06', 'H');
  const live = await read();
  assert.equal(live?.periodState, 'open');
  assert.equal(live?.adjustmentMinutes, 200);
  assert.equal(live?.paidMinutes, sheet?.paidMinutes);
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-06' });
  const closed = await read();
  assert.equal(closed?.periodState, 'closed');
  assert.equal(closed?.adjustmentMinutes, 200);
  assert.equal(closed?.paidMinutes, sheet?.paidMinutes);

  // A snapshot closed before adjustments existed (no `adjustmentMinutes` key, hash over that
  // shape) is still served, as zero adjustments.
  const february = async () => {
    const page = await stack.reports.query(f.p('H').secret, {
      kind: 'attendance',
      from: '2026-02',
      to: '2026-02',
      limit: 100,
      offset: 0,
    });
    assert.equal(page.kind, 'attendance');
    return page.rows.find((row) => row.employeeId === f.employeeOf('A6'));
  };

  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-02' });
  assert.equal((await february())?.adjustmentMinutes, 120, 'A6 has an adjustment dated 2026-02-02');
  await legacySnapshot('2026-02');
  assert.equal((await february())?.adjustmentMinutes, 0);
  for (const month of ['2026-06', '2026-02'])
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Dọn' });
});

/** Rewrites the stored snapshot of a closed month into the pre-adjustment shape and hash. */
async function legacySnapshot(month: string) {
  const [row] = await stack.migration.query<
    { snapshot: { calendarVersion: string; employees: Record<string, unknown>[] } }[]
  >(`SELECT snapshot FROM attendance_period WHERE month = CAST($1 AS date)`, [`${month}-01`]);
  assert.ok(row);
  const keys = [
    'scheduledMinutes',
    'paidHolidayMinutes',
    'unpaidMinutes',
    'annualLeaveMinutes',
    'paidMinutes',
    'wfhDays',
    'lateCount',
    'lateMinutes',
    'earlyCount',
    'earlyMinutes',
  ];
  // The array keeps the order the close wrote (employee id order); the keys are written in the
  // order of the T8 literal. The adjustments key is dropped; the stored numbers stay as they are.
  const document = {
    month,
    calendarVersion: row.snapshot.calendarVersion,
    employees: row.snapshot.employees.map((e) => ({
      employeeId: e.employeeId,
      ...Object.fromEntries(keys.map((k) => [k, e[k]])),
    })),
  };
  await stack.migration.query(
    `UPDATE attendance_period SET snapshot = CAST($2 AS jsonb), snapshot_hash = $3 WHERE month = CAST($1 AS date)`,
    [
      `${month}-01`,
      JSON.stringify(document),
      createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    ],
  );
}

test('F-25: an audit failure rolls back the entry and the claim; the same key then succeeds once', async () => {
  await f.hire('B1', ['hr.employee']);
  const before = await everything('B1');
  const key = randomUUID();
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      adjust(f.p('H').fresh, 'B1', { key }),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual(await everything('B1'), before);
  assert.ok(await adjust(f.p('H').fresh, 'B1', { key }));
  assert.equal((await rows('B1')).length, 1);
});

test('F-29: the table is append-only and its columns are checked by the database itself', async () => {
  await f.hire('B2', ['hr.employee']);
  const result = await adjust(f.p('H').fresh, 'B2');
  assert.ok(result);
  // The data login can neither change nor delete an entry (privilege probe + negative test).
  const data = stack.pools.data;
  await assert.rejects(
    data.query('UPDATE attendance_adjustment SET minutes = 1'),
    /permission denied/,
  );
  await assert.rejects(data.query('DELETE FROM attendance_adjustment'), /permission denied/);

  const insert = (over: Record<string, unknown>) => {
    const value = {
      id: randomUUID(),
      employee: f.employeeOf('B2'),
      day: '2026-03-10',
      minutes: 60,
      reason: 'r',
      reference: null,
      actor: f.p('H').id,
      ...over,
    };
    return stack.migration.query(
      `INSERT INTO attendance_adjustment(id, employee_id, work_date, minutes, reason, reference, actor_account_id)
       VALUES ($1, $2, CAST($3 AS date), $4, $5, $6, $7)`,
      [
        value.id,
        value.employee,
        value.day,
        value.minutes,
        value.reason,
        value.reference,
        value.actor,
      ],
    );
  };

  await insert({});
  for (const bad of [
    { minutes: 0 },
    { minutes: 1441 },
    { minutes: -1441 },
    { reason: '' },
    { reason: 'x'.repeat(301) },
    { reason: 'a\nb' },
    { reference: '' },
    { reference: 'x'.repeat(65) },
    { reference: 'a\nb' },
    { day: '1899-12-31' },
    { day: '2101-01-01' },
  ])
    await assert.rejects(insert(bad), /violates check constraint/, JSON.stringify(bad));
  assert.equal((await rows('B2')).length, 2);
});

test('F-30: two requests with one key racing (a retry beside the original): one entry, both get its id', async () => {
  await f.hire('B3', ['hr.employee']);
  const key = randomUUID();
  const results = await raced(
    stack,
    async (client: Client) => {
      await client.query('SELECT 1 FROM employee WHERE id = $1 FOR UPDATE', [f.employeeOf('B3')]);
    },
    2,
    () => [adjust(f.p('H').fresh, 'B3', { key }), adjust(f.p('H').fresh, 'B3', { key })],
  );
  const done = fulfilled(results).map((r) => r.value);
  assert.equal(done.length, 2, JSON.stringify(failures(results).map(String)));
  assert.deepEqual(done[0], done[1]);
  assert.equal((await rows('B3')).length, 1);
});

test('F-26: two negative adjustments racing for the last minutes of a month: exactly one fits, the total never goes below zero', async () => {
  await f.hire('B4', ['hr.employee'], { hiredOn: '2026-03-30' });
  // 2026-03-30 and 31 are weekdays: 960 scheduled minutes.
  assert.equal(await paid('B4'), 960);
  const results = await raced(
    stack,
    async (client: Client) => {
      await client.query('SELECT 1 FROM employee WHERE id = $1 FOR UPDATE', [f.employeeOf('B4')]);
    },
    2,
    () => [
      adjust(f.p('H').fresh, 'B4', { minutes: -600, workDate: '2026-03-30' }),
      adjust(f.p('H').fresh, 'B4', { minutes: -600, workDate: '2026-03-31' }),
    ],
  );
  assert.equal(fulfilled(results).length, 1, JSON.stringify(failures(results).map(String)));
  assert.ok(failures(results).every((error) => rejected('negative_total')(error)));
  assert.equal(await paid('B4'), 360);
  assert.equal((await rows('B4')).length, 1);
});

const hrCompany = async (client: Client) => {
  await client.query('SELECT 1 FROM hr_company FOR UPDATE');
};

test('F-27: an adjustment racing the close of its month is in the snapshot exactly when it committed', async () => {
  const month = '2026-07';
  for (const [index, workDate] of ['2026-07-06', '2026-07-07', '2026-07-08'].entries()) {
    const name = `C${index}`;
    await f.hire(name, ['hr.employee'], { inTeam: false });
    const employeeId = f.employeeOf(name);
    const [adjusted, closed] = await raced<unknown>(
      stack,
      async (client) => {
        await client.query('SELECT 1 FROM employee WHERE id = $1 FOR UPDATE', [employeeId]);
        await hrCompany(client);
      },
      2,
      () => [
        adjust(f.p('H').fresh, name, { workDate, minutes: 45 }),
        stack.attendance.closePeriod(f.p('H').fresh, { month }),
      ],
    );
    assert.equal(closed?.status, 'fulfilled', 'the close never fails here');
    const live = await f.sheet(name, month, 'H');
    const [row] = await stack.migration.query<{ adjustment: number | null; paid: number | null }[]>(
      `SELECT (e->>'adjustmentMinutes')::int AS adjustment, (e->>'paidMinutes')::int AS paid
         FROM attendance_period p, jsonb_array_elements(p.snapshot->'employees') e
        WHERE p.month = CAST($1 AS date) AND e->>'employeeId' = $2`,
      [`${month}-01`, employeeId],
    );
    assert.equal(row?.adjustment, live?.adjustmentMinutes, 'snapshot and live sheet agree');
    assert.equal(row?.paid, live?.paidMinutes);
    if (adjusted?.status === 'fulfilled') {
      assert.equal(row?.adjustment, 45, 'a committed adjustment is in the snapshot');
      assert.equal((await rows(name)).length, 1);
    } else {
      assert.ok(refused('error.periodClosed', 409)(adjusted?.reason), String(adjusted?.reason));
      assert.equal(row?.adjustment, 0);
      assert.equal((await rows(name)).length, 0, 'a refused adjustment left nothing behind');
    }
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: `Vòng ${index}` });
  }
});

test('F-31: an adjustment, a calendar change and the close of the same month started together all finish: no deadlock (spec §7.3 order)', async () => {
  const date = await stack.latestWeekday();
  const month = date.slice(0, 7);
  const day = await stack.otherWeekday(month, date);
  await f.hire('D1', ['hr.employee']);
  await stack.migration.query(
    'INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING',
    [`${month}-01`],
  );
  const calendar = await stack.workCalendar.year(f.p('H').secret, Number(month.slice(0, 4)));
  assert.ok(calendar);
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    // The blocker holds the calendar: the adjustment takes the employee and the month FOR SHARE
    // and waits at the calendar; the close then waits for the month; the calendar change waits
    // behind the blocker too. When it commits the three are in the order that could deadlock.
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM work_calendar FOR UPDATE');

    const giveUp = async () => {
      await blocker.query('ROLLBACK');
    };

    const adjusting = Promise.allSettled([
      adjust(f.p('H').fresh, 'D1', { workDate: date, minutes: 30 }),
    ]);
    await waitForLocks(watcher, 1, giveUp);
    const close = Promise.allSettled([stack.attendance.closePeriod(f.p('H').fresh, { month })]);
    await waitForLocks(watcher, 2, giveUp);
    const change = Promise.allSettled([
      stack.workCalendar.setDay(f.p('H').fresh, {
        expectedVersion: calendar.version,
        date: day,
        holiday: 'Ngày lễ thử',
      }),
    ]);
    await waitForLocks(watcher, 3, giveUp);
    await blocker.query('COMMIT');
    const [[adjusted], [closed], [changed]] = await Promise.all([adjusting, close, change]);
    assert.equal(
      adjusted?.status,
      'fulfilled',
      String(adjusted?.status === 'rejected' && adjusted.reason),
    );
    assert.equal(
      closed?.status,
      'fulfilled',
      String(closed?.status === 'rejected' && closed.reason),
    );
    if (changed?.status !== 'fulfilled')
      assert.ok(refused('error.periodClosed', 409)(changed?.reason), String(changed?.reason));
    const [stored] = await stack.migration.query<{ adjustment: number }[]>(
      `SELECT (e->>'adjustmentMinutes')::int AS adjustment
         FROM attendance_period p, jsonb_array_elements(p.snapshot->'employees') e
        WHERE p.month = CAST($1 AS date) AND e->>'employeeId' = $2`,
      [`${month}-01`, f.employeeOf('D1')],
    );
    assert.equal(stored?.adjustment, 30, 'the adjustment committed before the close is in it');
  } finally {
    await blocker.end().catch(() => undefined);
    await watcher.end();
  }
});
