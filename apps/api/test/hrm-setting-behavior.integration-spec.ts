// ADR 0041 §5 / ADR 0045: the business rules that read a setting follow the value in force and only
// from the change on (WFH month limit, request window and size, report span, export budget, default
// leave rate), and every business transaction pays at most the settings reads counted here.
// Synthetic people; dates are relative to the DB clock or fixed past months.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { EntityManager } from 'typeorm';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { SettingKey } from '../dist/modules/setting/setting.registry.js';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { attendanceFixture, refused } from './hrm-attendance.helper.ts';

let stack: ModuleStack;
let f: ReturnType<typeof attendanceFixture>;
let admin = '';

before(async () => {
  stack = await startModuleStack();
  f = attendanceFixture(stack);
  await f.setup();
  admin = f.p('H').secret;
});

after(() => stack?.stop());

const one = async (sql: string, params: unknown[] = []) =>
  (await stack.migration.query<{ v: string | null }[]>(sql, params))[0]?.v ?? null;

const versionOf = async (key: string) =>
  (await stack.settings.list(admin))?.settings.find((setting) => setting.key === key)?.version ??
  '';

const set = async (key: string, value: unknown) =>
  stack.settings.update(admin, { key, value, expectedVersion: await versionOf(key) } as never);

/** Days from today (DB clock, business timezone) to a business date. */
const offsetOf = async (date: string) =>
  Number(
    await one(
      `SELECT (CAST($1 AS date) - (statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)::text AS v`,
      [date],
    ),
  );

/** Runs `work`, counting the statements that went through a transaction manager. */
async function counted<T>(work: () => Promise<T>) {
  // Read through the descriptor: the method is wrapped and put back, never called unbound.
  const original = Object.getOwnPropertyDescriptor(EntityManager.prototype, 'query')
    ?.value as typeof EntityManager.prototype.query;
  let settingReads = 0;
  let statements = 0;
  EntityManager.prototype.query = function (this: EntityManager, ...args: unknown[]) {
    statements++;
    if (typeof args[0] === 'string' && args[0].includes('system_setting')) settingReads++;
    return Reflect.apply(original, this, args) as never;
  } as typeof original;
  try {
    const result = await work();
    return { result, settingReads, statements };
  } finally {
    EntityManager.prototype.query = original;
  }
}

test('WFH month limit: the value in force at submit and at the final decision, from the change on only', async () => {
  const dates = await f.days(5);
  await f.hire('W1', ['hr.employee']);
  await set(SettingKey.WfhMonthLimit, 2);
  for (const date of dates.slice(0, 2)) {
    const created = await f.submit('W1', f.wfh(date));
    assert.equal(created.wfhLimitExceeded, false);
    const next = await stack.approvals.decide(f.p('L1').secret, f.input(created, 'approve'));
    assert.ok(next);
    assert.equal((await f.finalDecide(next))?.state, 'approved');
  }
  const third = await f.submit('W1', f.wfh(dates[2]!));
  assert.equal(third.wfhLimitExceeded, true, '2 approved + 1 > 2');
  const thirdWaiting = await stack.approvals.decide(f.p('L1').secret, f.input(third, 'approve'));
  assert.ok(thirdWaiting);
  await assert.rejects(f.finalDecide(thirdWaiting), refused('error.wfhLimitAckRequired', 409));
  // Raising the limit lets the same request through without the acknowledgement.
  await set(SettingKey.WfhMonthLimit, 3);
  assert.equal((await f.finalDecide(thirdWaiting))?.state, 'approved');
  // Lowering it changes nothing already approved, only the next decisions.
  await set(SettingKey.WfhMonthLimit, 1);
  assert.equal(await f.counter('W1', dates[0]!.slice(0, 7)), 3);
  assert.equal(await f.approvedWfhDays('W1', dates[0]!.slice(0, 7)), 3);
  assert.equal((await f.submit('W1', f.wfh(dates[3]!))).wfhLimitExceeded, true);
  // Zero is legal: every WFH day then needs the acknowledgement.
  await set(SettingKey.WfhMonthLimit, 0);
  await f.hire('W0', ['hr.employee']);
  assert.equal((await f.submit('W0', f.wfh(dates[4]!))).wfhLimitExceeded, true);
  await set(SettingKey.WfhMonthLimit, 4);
  assert.equal((await f.submit('W0', f.wfh(dates[0]!))).wfhLimitExceeded, false);
});

test('report WFH overLimit follows the limit in force, closed months included; wfhDays and the snapshot stay', async () => {
  await f.hire('R1', ['hr.employee'], { hiredOn: '2025-12-01' });
  await f.fixtureRequest('R1', 'wfh', 'approved', ['2026-02-02', '2026-02-03', '2026-02-04']);

  const row = async () => {
    const result = await stack.reports.query(admin, {
      kind: 'wfh',
      from: '2026-02',
      to: '2026-02',
      limit: 100,
      offset: 0,
    });
    assert.equal(result.kind, 'wfh');
    const mine = result.rows.find((r) => r.employeeId === f.employeeOf('R1'));
    assert.ok(mine);
    return mine;
  };

  // The previous test left the limit at 4 (its default value, stored as version N).
  assert.deepEqual([(await row()).wfhDays, (await row()).overLimit], [3, false]);
  await set(SettingKey.WfhMonthLimit, 2);
  assert.deepEqual([(await row()).wfhDays, (await row()).overLimit], [3, true]);
  await set(SettingKey.WfhMonthLimit, 3);
  assert.equal((await row()).overLimit, false, '3 days is not over a limit of 3');
  // A closed month keeps its stored totals and hash; only the label follows the limit (Q4 = a).
  assert.ok(await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-02' }));

  const hash = () =>
    one(`SELECT snapshot_hash AS v FROM attendance_period WHERE month = DATE '2026-02-01'`);

  const closedHash = await hash();
  assert.ok(closedHash);
  await set(SettingKey.WfhMonthLimit, 1);
  assert.deepEqual([(await row()).wfhDays, (await row()).overLimit], [3, true]);
  assert.equal(await hash(), closedHash);
  await set(SettingKey.WfhMonthLimit, 4);
  assert.equal((await row()).overLimit, false);
  assert.equal(await hash(), closedHash);
  // Hiring from January needs every month after it open: leave the stack as it was.
  assert.ok(
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month: '2026-02', reason: 'Dọn dẹp' }),
  );
});

test('the submit window follows the days in force; what was already submitted is not re-judged', async () => {
  await f.hire('V1', ['hr.employee']);
  await f.hire('V2', ['hr.employee']);
  const [future] = await f.days(1);
  const ahead = await offsetOf(future!);
  assert.ok(ahead >= 1);
  await set(SettingKey.RequestWindowFutureDays, ahead - 1);
  await assert.rejects(f.submit('V1', f.wfh(future!)), refused('error.dateOutOfRange', 422));
  await set(SettingKey.RequestWindowFutureDays, ahead);
  const created = await f.submit('V1', f.wfh(future!));
  // Narrowing to 0 afterwards does not touch the request nor stop its approval.
  await set(SettingKey.RequestWindowFutureDays, 0);
  const waiting = await stack.approvals.decide(f.p('L1').secret, f.input(created, 'approve'));
  assert.ok(waiting);
  assert.equal((await f.finalDecide(waiting, 'approve', { ack: true }))?.state, 'approved');
  await set(SettingKey.RequestWindowFutureDays, 90);

  const past = await stack.latestWeekday();
  const back = -(await offsetOf(past));
  assert.ok(back >= 0 && back <= 3);
  if (back > 0) {
    await set(SettingKey.RequestWindowPastDays, back - 1);
    await assert.rejects(f.submit('V2', f.wfh(past)), refused('error.dateOutOfRange', 422));
  }
  await set(SettingKey.RequestWindowPastDays, back);
  assert.ok(await f.submit('V2', f.wfh(past)));
  await set(SettingKey.RequestWindowPastDays, 7);
});

test('one request covers at most the days in force (400 above it); the validator ceiling stays 31', async () => {
  await f.hire('M1', ['hr.employee']);
  const dates = await f.days(7);
  await set(SettingKey.RequestMaxDays, 3);
  await assert.rejects(f.submit('M1', f.wfh(...dates.slice(0, 4))), ProductInvalidRequest);
  assert.ok(await f.submit('M1', f.wfh(...dates.slice(0, 3))));
  await set(SettingKey.RequestMaxDays, 31);
  assert.ok(await f.submit('M1', f.wfh(...dates.slice(3, 7))));
});

test('the report span follows report.maxMonths, for the monthly reports', async () => {
  const query = (kind: 'attendance' | 'wfh' | 'birthday', to: string) =>
    stack.reports.query(admin, { kind, from: '2026-01', to, limit: 5, offset: 0 });

  await set(SettingKey.ReportMaxMonths, 3);
  for (const kind of ['attendance', 'wfh', 'birthday'] as const) {
    await assert.rejects(query(kind, '2026-04'), ProductInvalidRequest, kind);
    assert.ok(await query(kind, '2026-03'), kind);
  }
  await set(SettingKey.ReportMaxMonths, 12);
  assert.ok(await query('attendance', '2026-04'));
});

test('the export row budget follows export.maxRows: above it is 422, never a cut file', async () => {
  const wfhQuery = { kind: 'wfh', from: '2026-01', to: '2026-03' } as const;
  const total = Number(
    (await stack.reports.query(admin, { ...wfhQuery, limit: 1, offset: 0 })).total,
  );
  assert.ok(total >= 4, 'employees x months');
  await set(SettingKey.ExportMaxRows, total - 1);
  await assert.rejects(stack.reports.export(admin, wfhQuery), refused('error.exportTooLarge', 422));
  await set(SettingKey.ExportMaxRows, total);
  const file = await stack.reports.export(admin, wfhQuery);
  assert.ok(file && file.content.length > 0);
  await set(SettingKey.ExportMaxRows, 5000);
  assert.ok(await stack.reports.export(admin, wfhQuery));
});

test('a business transaction pays at most the settings reads counted here', async (t) => {
  await f.hire('Q1', ['hr.employee']);
  const dates = await f.days(3);

  const record = (label: string, run: { settingReads: number; statements: number }) =>
    t.diagnostic(`${label}: ${run.settingReads} settings read(s) of ${run.statements} statements`);

  const late = await counted(() => f.submit('Q1', f.late(dates[0]!)));
  record('submit late-arrival', late);
  assert.equal(late.settingReads, 1);
  const wfh = await counted(() => f.submit('Q1', f.wfh(dates[1]!)));
  record('submit wfh', wfh);
  assert.equal(wfh.settingReads, 1, 'the WFH limit is read with the window, not in a second query');

  const waiting = await stack.approvals.decide(f.p('L1').secret, f.input(wfh.result, 'approve'));
  assert.ok(waiting);
  const final = await counted(() => f.finalDecide(waiting));
  record('final approval of a WFH request', final);
  assert.equal(final.settingReads, 1);
  const acknowledged = await f.submit('Q1', f.wfh(dates[2]!));
  const again = await stack.approvals.decide(f.p('L1').secret, f.input(acknowledged, 'approve'));
  assert.ok(again);
  const withAck = await counted(() => f.finalDecide(again, 'approve', { ack: true }));
  record('final approval with the acknowledgement', withAck);
  assert.equal(withAck.settingReads, 0);

  const report = await counted(() =>
    stack.reports.query(admin, {
      kind: 'wfh',
      from: '2026-02',
      to: '2026-02',
      limit: 5,
      offset: 0,
    }),
  );
  record('wfh report', report);
  assert.equal(report.settingReads, 1);
  const leaveReport = await counted(() =>
    stack.reports.query(admin, { kind: 'leave', asOn: '2026-06-30', limit: 5, offset: 0 }),
  );
  assert.equal(leaveReport.settingReads, 0);
  const exported = await counted(() =>
    stack.reports.export(admin, { kind: 'wfh', from: '2026-02', to: '2026-02' }),
  );
  record('wfh export', exported);
  assert.equal(exported.settingReads, 2);

  const noIdentity = {
    dateOfBirth: null,
    documentKind: null,
    documentNumber: null,
    taxCode: null,
    gender: null,
    phone: null,
    workEmail: null,
  };

  const create = (annualLeaveMinutes: number | 'default') =>
    counted(async () =>
      stack.employees.create(await stack.freshRoot(), {
        code: `QC${randomUUID().slice(0, 8)}`,
        fullName: 'Nhân viên đếm',
        hiredOn: '2026-01-05',
        status: 'official',
        annualLeaveMinutes,
        identity: noIdentity,
        position: null,
        classification: null,
      }),
    );

  const byDefault = await create('default');
  record('create official employee (default rate)', byDefault);
  const explicit = await create(6000);
  assert.equal(byDefault.settingReads, 1);
  assert.equal(explicit.settingReads, 0, 'an explicit rate needs no setting');
});
