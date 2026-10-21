// T8 attendance on PostgreSQL (design §6.2, §6.3 invariant 5, §9, ADR 0017/0018; acceptance
// D-01..D-09, F-01..F-12, B-22): the monthly sheet computed from approved requests only, every
// kind reaching `approved` in the PRODUCTION composition (leave debit, WFH counter and the
// attendance period lock in the deciding transaction), the D04 WFH warning/acknowledgement and the
// D07 close/reopen of a month with its history. Synthetic people only. Months are either fixed
// PAST months (2026-03: fixtures written as the owner, so no result depends on the date the suite
// runs on) or the month of dates taken relative to today by the DB clock.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { approvedEffects } from '../dist/work-request/services/request-approval.service.js';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { sqlState } from './setup-postgres.ts';
import { type HrStack, startHrStack } from './hrm-stack.helper.ts';
import { attendanceFixture, refused, rejected } from './hrm-attendance.helper.ts';

let stack: HrStack;
let f: ReturnType<typeof attendanceFixture>;

before(async () => {
  // Production composition: no stand-in effects.
  stack = await startHrStack();
  f = attendanceFixture(stack);
  await f.setup();
});

after(() => stack?.stop());

/** March 2026: Sunday the 1st, 22 weekdays; a fixed month in the past of every run. */
const MARCH = '2026-03';

test('the production composition registers every effect part, so no kind is closed', () => {
  assert.deepEqual(Object.keys(approvedEffects).sort(), ['attendance', 'leave', 'wfh']);
});

test('the sheet is the calendar by default and counts approved requests only (F-01, F-03..F-08)', async () => {
  await f.hire('S1', ['hr.employee']);
  const full = await f.sheet('S1', MARCH);
  assert.deepEqual(full, {
    employeeId: f.employeeOf('S1'),
    month: MARCH,
    periodState: 'open',
    scheduledMinutes: 22 * 480,
    paidHolidayMinutes: 0,
    unpaidMinutes: 0,
    annualLeaveMinutes: 0,
    paidMinutes: 22 * 480,
    wfhDays: 0,
    lateCount: 0,
    lateMinutes: 0,
    earlyCount: 0,
    earlyMinutes: 0,
  });
  // Waiting and refused requests change nothing (F-04).
  await f.fixtureRequest('S1', 'unpaid-leave', 'pending_lead', ['2026-03-04']);
  await f.fixtureRequest('S1', 'unpaid-leave', 'pending_final', ['2026-03-04']);
  await f.fixtureRequest('S1', 'unpaid-leave', 'rejected', ['2026-03-05']);
  await f.fixtureRequest('S1', 'wfh', 'cancelled', ['2026-03-05']);
  assert.deepEqual(await f.sheet('S1', MARCH), full);
  // Approved ones count (F-03, F-05, F-07, WFH, early departure).
  await f.fixtureRequest('S1', 'unpaid-leave', 'approved', ['2026-03-03'], [540, 660]);
  await f.fixtureRequest('S1', 'annual-leave', 'approved', ['2026-03-06']);
  await f.fixtureRequest('S1', 'late-arrival', 'approved', ['2026-03-09'], [540, 600]);
  await f.fixtureRequest('S1', 'wfh', 'approved', ['2026-03-10', '2026-03-11']);
  await f.fixtureRequest('S1', 'early-departure', 'approved', ['2026-03-13'], [1020, 1080]);
  const counted = await f.sheet('S1', MARCH);
  assert.ok(counted);
  assert.deepEqual(
    [
      counted.unpaidMinutes,
      counted.annualLeaveMinutes,
      counted.paidMinutes,
      counted.wfhDays,
      [counted.lateCount, counted.lateMinutes],
      [counted.earlyCount, counted.earlyMinutes],
    ],
    [120, 480, 22 * 480 - 120, 2, [1, 60], [1, 60]],
  );
  // A paid holiday on a weekday: paid time off, not working time, nothing deducted (F-06).
  const calendar = await stack.workCalendar.year(f.p('H').secret, 2026);
  assert.ok(calendar);
  await stack.workCalendar.setDay(f.p('H').fresh, {
    expectedVersion: calendar.version,
    date: '2026-03-12',
    holiday: 'Ngày lễ thử',
  });
  const holiday = await f.sheet('S1', MARCH);
  assert.ok(holiday);
  assert.deepEqual(
    [holiday.scheduledMinutes, holiday.paidHolidayMinutes, holiday.paidMinutes],
    [21 * 480, 480, 21 * 480 - 120 + 480],
  );
  // Recomputing with unchanged inputs is byte-identical (F-08).
  assert.equal(JSON.stringify(await f.sheet('S1', MARCH)), JSON.stringify(holiday));
  // Two approved requests on the same working minutes are never counted twice.
  await f.fixtureRequest('S1', 'annual-leave', 'approved', ['2026-03-17'], [540, 660]);
  await f.fixtureRequest('S1', 'unpaid-leave', 'approved', ['2026-03-17'], [540, 780]);
  const overlap = await f.sheet('S1', MARCH);
  assert.ok(overlap);
  assert.equal(overlap.annualLeaveMinutes + overlap.unpaidMinutes, 480 + 120 + 120 + 120);
  assert.equal(overlap.paidMinutes, 21 * 480 - overlap.unpaidMinutes + 480);
});

test('nothing is counted before the hire date (F-02)', async () => {
  await f.hire('S2', ['hr.employee'], { hiredOn: '2026-03-16' });
  const view = await f.sheet('S2', MARCH);
  assert.ok(view);
  // 16..20, 23..27, 30..31 = 12 working days.
  assert.deepEqual([view.scheduledMinutes, view.paidMinutes], [12 * 480, 12 * 480]);
  assert.equal((await f.sheet('S2', '2026-02'))?.paidMinutes, 0);
});

test('who reads a sheet: the owner and HR; a lead, the COO and strangers do not read it (matrix §5.2)', async () => {
  await f.hire('S3', ['hr.employee']);
  await f.hire('N', [], { inTeam: false });
  assert.ok(await f.sheet('S3', MARCH));
  assert.ok(await f.sheet('S3', MARCH, 'H'));
  assert.ok(
    await stack.attendance.period(await stack.root(), {
      employeeId: f.employeeOf('S3'),
      month: MARCH,
    }),
  );
  assert.equal(await f.sheet('S3', MARCH, 'L1'), undefined);
  assert.equal(await f.sheet('S3', MARCH, 'C'), undefined);
  assert.equal(await f.sheet('S3', MARCH, 'S1'), undefined);
  assert.equal(await f.sheet('S3', MARCH, 'N'), undefined);
  // The lead and the COO read their own sheet.
  assert.ok(await f.sheet('L1', MARCH));
  assert.ok(await f.sheet('C', MARCH));
  // The default month is the current one by the DB clock.
  const today = await stack.day(0);
  const current = await stack.attendance.period(f.p('S3').secret, {
    employeeId: f.employeeOf('S3'),
    month: null,
  });
  assert.equal(current?.month, today.slice(0, 7));
});

test('menu `attendance` follows the readable own sheet (display only)', async () => {
  const menus = async (name: string) => (await stack.employees.me(f.p(name).secret)).menus;

  assert.ok((await menus('S3')).includes('attendance'));
  assert.ok((await menus('L1')).includes('attendance'));
  assert.ok(!(await menus('N')).includes('attendance'));
});

test('every kind reaches approved in production and shows in the sheet of its month (D05, D-01)', async () => {
  const [d1, d2, d3, d4, d5] = await f.days(5);
  const month = d1!.slice(0, 7);
  await f.hire('K1', ['hr.employee']);
  await f.available('K1', d1!, 480);
  const annual = await f.leadApprove('K1', f.leave('annual-leave', d1!));
  assert.equal(annual.state, 'pending_final');
  assert.equal((await f.finalDecide(annual))?.state, 'approved');
  const unpaid = await f.leadApprove('K1', f.leave('unpaid-leave', d2!, 540, 660));
  assert.equal((await f.finalDecide(unpaid))?.state, 'approved');
  const wfh = await f.leadApprove('K1', f.wfh(d3!));
  assert.equal((await f.finalDecide(wfh))?.state, 'approved');
  // Late and early arrival need the lead only (§6.4.1): the lead's approval is the final one.
  const late = await f.submit('K1', f.late(d4!, 600));
  assert.equal(
    (await stack.approvals.decide(f.p('L1').secret, f.input(late, 'approve')))?.state,
    'approved',
  );
  const early = await f.submit('K1', f.early(d5!, 1020));
  assert.equal(
    (await stack.approvals.decide(f.p('L1').secret, f.input(early, 'approve')))?.state,
    'approved',
  );
  const view = await f.sheet('K1', month);
  assert.ok(view);
  assert.deepEqual(
    [
      view.annualLeaveMinutes,
      view.unpaidMinutes,
      view.wfhDays,
      [view.lateCount, view.lateMinutes],
      [view.earlyCount, view.earlyMinutes],
    ],
    [480, 120, 1, [1, 60], [1, 60]],
  );
  // The annual-leave debit and the WFH counter were written by the same approvals.
  assert.equal(
    await f.count('SELECT count(*)::text AS n FROM leave_ledger WHERE source_request_id = $1', [
      annual.id,
    ]),
    1,
  );
  assert.equal(await f.counter('K1', month), 1);
  // Root approves a final stage too (spec §6.3 invariant 4).
  const [r1] = await f.days(1);
  await f.hire('K2', ['hr.employee']);
  const rootRequest = await f.leadApprove('K2', f.wfh(r1!));
  assert.equal(
    (await stack.approvals.decide(await stack.root(), f.input(rootRequest, 'approve')))?.state,
    'approved',
  );
});

test('WFH: the fifth day of a month needs the approver’s acknowledgement; counters follow the days of the request (D-01, D-02, D-06, D-07, D-08)', async () => {
  const dates = await f.days(6);
  const month = dates[0]!.slice(0, 7);
  await f.hire('W1', ['hr.employee']);
  // D-06: waiting and rejected WFH do not count.
  const rejectedOne = await f.leadApprove('W1', f.wfh(dates[5]!));
  assert.equal((await f.finalDecide(rejectedOne, 'reject'))?.state, 'rejected');
  assert.equal(await f.counter('W1', month), undefined);
  // D-01: the first four days are approved without a warning, one request each.
  for (const date of dates.slice(0, 4)) {
    const created = await f.submit('W1', f.wfh(date));
    assert.equal(created.wfhLimitExceeded, false);
    const waiting = await stack.approvals.decide(f.p('L1').secret, f.input(created, 'approve'));
    assert.ok(waiting);
    assert.equal((await f.finalDecide(waiting))?.state, 'approved');
  }
  assert.equal(await f.counter('W1', month), 4);
  assert.equal(await f.approvedWfhDays('W1', month), 4);
  // D-07: the fifth is accepted with a warning at submit (4 approved + 1 > 4); a replay says the same.
  const key = randomUUID();
  const fifth = await f.submit('W1', f.wfh(dates[4]!), key);
  assert.equal(fifth.wfhLimitExceeded, true);
  assert.deepEqual(await f.submit('W1', f.wfh(dates[4]!), key), fifth);
  const waiting = await stack.approvals.decide(f.p('L1').secret, f.input(fifth, 'approve'));
  assert.ok(waiting);
  // D-02: refused without the acknowledgement, with nothing written.
  const before = await f.snapshot(waiting.id);
  await assert.rejects(f.finalDecide(waiting), refused('error.wfhLimitAckRequired', 409));
  await assert.rejects(
    f.finalDecide(waiting, 'approve', { ack: false }),
    refused('error.wfhLimitAckRequired', 409),
  );
  assert.deepEqual(await f.snapshot(waiting.id), before);
  // An approval with it works and the counter is 5; a replay answers the same.
  const approvalKey = randomUUID();
  const done = await f.finalDecide(waiting, 'approve', { ack: true, key: approvalKey });
  assert.deepEqual(done, { id: waiting.id, state: 'approved', version: '3' });
  assert.equal(await f.counter('W1', month), 5);
  assert.equal(await f.approvedWfhDays('W1', month), 5);
  assert.deepEqual(await f.finalDecide(waiting, 'approve', { ack: true, key: approvalKey }), done);
  assert.equal(await f.counter('W1', month), 5);
  // The acknowledgement is part of the payload: the same key without it is a reused key.
  await assert.rejects(
    f.finalDecide(waiting, 'approve', { ack: false, key: approvalKey }),
    refused('error.idempotencyKeyReused', 422),
  );
});

test('WFH: a request counts every one of its days in the month of that day, so two months are two counters (D-04, D-08)', async () => {
  const [last, first] = await f.boundary();
  await f.hire('W2', ['hr.employee']);
  const request = await f.leadApprove('W2', f.wfh(last, first));
  assert.equal((await f.finalDecide(request))?.state, 'approved');
  assert.equal(await f.counter('W2', last.slice(0, 7)), 1);
  assert.equal(await f.counter('W2', first.slice(0, 7)), 1);
  // Three days in one month: +3 (D-08); two more would pass 4 in that month.
  const dates = await f.days(5);
  const month = dates[0]!.slice(0, 7);
  await f.hire('W3', ['hr.employee']);
  const three = await f.leadApprove('W3', f.wfh(...dates.slice(0, 3)));
  assert.equal((await f.finalDecide(three))?.state, 'approved');
  assert.equal(await f.counter('W3', month), 3);
  const two = await f.leadApprove('W3', f.wfh(...dates.slice(3, 5)));
  await assert.rejects(f.finalDecide(two), refused('error.wfhLimitAckRequired', 409));
  assert.equal(await f.counter('W3', month), 3);
  assert.equal((await f.finalDecide(two, 'approve', { ack: true }))?.state, 'approved');
  assert.equal(await f.counter('W3', month), 5);
  assert.equal(await f.approvedWfhDays('W3', month), 5);
});

/** The latest weekday on or before today (inside the submit window): its month is closable. */
async function latestWeekday(): Promise<string> {
  for (let offset = 0; ; offset--) {
    const date = await stack.day(offset);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return date;
  }
}

test('closing a month (D07): snapshot and history; new requests, final approvals and calendar changes in it are refused; reopening allows them again (B-22, F-10..F-12)', async () => {
  const date = await latestWeekday();
  const month = date.slice(0, 7);
  for (const name of ['P1', 'P2', 'P3']) await f.hire(name, ['hr.employee']);
  const waiting = await f.leadApprove('P1', f.wfh(date));
  const toReject = await f.leadApprove('P3', f.wfh(date));

  // Only HR with a fresh session closes a month.
  await assert.rejects(
    stack.attendance.closePeriod(f.p('P1').fresh, { month }),
    ProductAccessDenied,
  );
  await assert.rejects(
    stack.attendance.closePeriod(f.p('H').secret, { month }),
    ProductAccessDenied,
  );

  const audits = () =>
    f.count(
      `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'hr.attendance-period.%'`,
    );

  const auditsBefore = await audits();
  const closed = await stack.attendance.closePeriod(f.p('H').fresh, { month });
  assert.deepEqual(closed, { month, state: 'closed', version: '2' });
  assert.equal(await audits(), auditsBefore + 1);

  const stored = async () =>
    (
      await stack.migration.query<
        {
          state: string;
          version: string;
          hash: string | null;
          snapshot: { calendarVersion: string; employees: { employeeId: string }[] } | null;
        }[]
      >(
        `SELECT state, version::text AS version, snapshot_hash AS hash, snapshot FROM attendance_period
          WHERE month = CAST($1 AS date)`,
        [`${month}-01`],
      )
    )[0];

  const first = await stored();
  assert.equal(first?.state, 'closed');
  assert.match(first?.hash ?? '', /^[0-9a-f]{64}$/);
  assert.ok(first?.snapshot?.employees.some((e) => e.employeeId === f.employeeOf('P1')));
  assert.equal((await f.sheet('P1', month))?.periodState, 'closed');
  await assert.rejects(
    stack.attendance.closePeriod(f.p('H').fresh, { month }),
    rejected('invalid_transition'),
  );

  // B-22 (new request), F-11 (final approval), F-10 (calendar change): refused, nothing written.
  const requests = await f.count('SELECT count(*)::text AS n FROM work_request');
  await assert.rejects(
    stack.workRequests.submit(f.p('P2').secret, randomUUID(), f.wfh(date)),
    refused('error.periodClosed', 409),
  );
  assert.equal(await f.count('SELECT count(*)::text AS n FROM work_request'), requests);
  const before = await f.snapshot(waiting.id);
  await assert.rejects(
    f.finalDecide(waiting, 'approve', { ack: true }),
    refused('error.periodClosed', 409),
  );
  assert.deepEqual(await f.snapshot(waiting.id), before);
  const year = Number(month.slice(0, 4));
  const calendar = await stack.workCalendar.year(f.p('H').secret, year);
  assert.ok(calendar);
  const holiday = { expectedVersion: calendar.version, date, holiday: 'Ngày lễ thử' };
  await assert.rejects(
    stack.workCalendar.setDay(f.p('H').fresh, holiday),
    refused('error.periodClosed', 409),
  );
  assert.equal((await stack.workCalendar.year(f.p('H').secret, year))?.version, calendar.version);
  // A rejection is no effect: it still works in a closed month.
  assert.equal((await f.finalDecide(toReject, 'reject'))?.state, 'rejected');

  // Reopen needs HR with a fresh session; the history keeps who and why.
  await assert.rejects(
    stack.attendance.reopenPeriod(f.p('P1').fresh, { month, reason: 'Sửa công' }),
    ProductAccessDenied,
  );
  const reopened = await stack.attendance.reopenPeriod(f.p('H').fresh, {
    month,
    reason: 'Sửa lịch làm bù',
  });
  assert.deepEqual(reopened, { month, state: 'open', version: '3' });
  assert.deepEqual(await stored(), { state: 'open', version: '3', hash: null, snapshot: null });
  await assert.rejects(
    stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Lần hai' }),
    rejected('invalid_transition'),
  );
  // F-12: closed again with unchanged inputs, the snapshot (and its hash) is the same.
  assert.equal((await stack.attendance.closePeriod(f.p('H').fresh, { month })).version, '4');
  const second = await stored();
  assert.equal(second?.hash, first?.hash);
  assert.deepEqual(second?.snapshot, first?.snapshot);
  assert.equal(
    (await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Sửa tiếp' })).version,
    '5',
  );
  assert.deepEqual(
    await stack.migration.query(
      `SELECT version::text AS version, event, reason, actor_account_id::text AS actor, (snapshot_hash IS NOT NULL) AS hashed
         FROM attendance_period_event WHERE month = CAST($1 AS date) ORDER BY version`,
      [`${month}-01`],
    ),
    [
      { version: '2', event: 'close', reason: null, actor: f.p('H').id, hashed: true },
      {
        version: '3',
        event: 'reopen',
        reason: 'Sửa lịch làm bù',
        actor: f.p('H').id,
        hashed: false,
      },
      { version: '4', event: 'close', reason: null, actor: f.p('H').id, hashed: true },
      { version: '5', event: 'reopen', reason: 'Sửa tiếp', actor: f.p('H').id, hashed: false },
    ],
  );

  // Open again: the same operations work.
  assert.equal((await f.finalDecide(waiting, 'approve', { ack: true }))?.state, 'approved');
  assert.ok(await stack.workRequests.submit(f.p('P2').secret, randomUUID(), f.wfh(date)));
  await stack.workCalendar.setDay(f.p('H').fresh, holiday);
});

test('a month cannot be closed before it started; a past month without employees closes and reopens', async () => {
  const future = (await stack.day(70)).slice(0, 7);
  await assert.rejects(
    stack.attendance.closePeriod(f.p('H').fresh, { month: future }),
    rejected('future_period'),
  );
  assert.equal(
    await f.count(
      'SELECT count(*)::text AS n FROM attendance_period WHERE month = CAST($1 AS date) AND state = $2',
      [`${future}-01`, 'closed'],
    ),
    0,
  );
  const closed = await stack.attendance.closePeriod(f.p('H').fresh, { month: '2020-01' });
  assert.equal(closed.state, 'closed');
  const [row] = await stack.migration.query<{ employees: unknown[] }[]>(
    `SELECT snapshot->'employees' AS employees FROM attendance_period WHERE month = DATE '2020-01-01'`,
  );
  assert.deepEqual(row?.employees, []);
  assert.equal(
    (await stack.attendance.reopenPeriod(f.p('H').fresh, { month: '2020-01', reason: 'Thử' }))
      .state,
    'open',
  );
});

test('submit warns with wfhLimitExceeded only for WFH; the warning is read-only (D-07)', async () => {
  const [d1, d2] = await f.days(2);
  await f.hire('V1', ['hr.employee']);
  const unpaid = await f.submit('V1', f.leave('unpaid-leave', d1!, 540, 660));
  assert.equal('wfhLimitExceeded' in unpaid, false);
  const warned = await f.submit('V1', f.wfh(d2!));
  assert.equal(warned.wfhLimitExceeded, false);
  // Four approved days already in the month: the same request would warn.
  await stack.migration.query(
    `INSERT INTO wfh_month_counter(employee_id, month, approved_count) VALUES ($1, CAST($2 AS date), 4)`,
    [f.employeeOf('V1'), `${d1!.slice(0, 7)}-01`],
  );
  const [d3] = await f.days(1);
  if (d3!.slice(0, 7) === d1!.slice(0, 7))
    assert.equal((await f.submit('V1', f.wfh(d3!))).wfhLimitExceeded, true);
  // Submitting never wrote a counter row of its own.
  assert.equal(await f.counter('V1', d1!.slice(0, 7)), 4);
});

test('storage: the runtime logins cannot delete counters/periods or rewrite history; CHECKs refuse impossible rows', async () => {
  for (const statement of [
    'DELETE FROM wfh_month_counter',
    'DELETE FROM attendance_period',
    'DELETE FROM attendance_period_event',
    `UPDATE attendance_period_event SET reason = 'x'`,
    'UPDATE wfh_month_counter SET employee_id = employee_id',
    'UPDATE attendance_period SET month = month',
  ])
    assert.equal(await sqlState(stack.pools.data.query(statement)), '42501', statement);
  for (const login of ['authority', 'identity', 'sync'] as const)
    for (const table of ['wfh_month_counter', 'attendance_period', 'attendance_period_event'])
      assert.equal(
        await sqlState(stack.pools[login].query(`SELECT 1 FROM ${table}`)),
        '42501',
        `${login} ${table}`,
      );

  const check = (statement: string) => sqlState(stack.migration.query(statement));

  assert.equal(
    await check(`INSERT INTO attendance_period(month) VALUES (DATE '2026-03-02')`),
    '23514',
  );
  // A closed month needs its snapshot and hash; an open one has neither.
  assert.equal(
    await check(`INSERT INTO attendance_period(month, state) VALUES (DATE '2025-03-01', 'closed')`),
    '23514',
  );
  assert.equal(
    await check(
      `INSERT INTO attendance_period(month, state, snapshot, snapshot_hash) VALUES (DATE '2025-04-01', 'open', '{}', repeat('a', 64))`,
    ),
    '23514',
  );
  assert.equal(
    await check(
      `INSERT INTO wfh_month_counter(employee_id, month, approved_count)
       SELECT id, DATE '2026-03-01', -1 FROM employee LIMIT 1`,
    ),
    '23514',
  );
  assert.equal(
    await check(
      `INSERT INTO wfh_month_counter(employee_id, month, approved_count) VALUES (gen_random_uuid(), DATE '2026-03-01', 1)`,
    ),
    '23503',
  );
  // A reopen must carry its reason, a close its hash (the history shape).
  assert.equal(
    await check(
      `INSERT INTO attendance_period_event(id, month, version, event, actor_account_id)
       SELECT gen_random_uuid(), month, 9, 'reopen', (SELECT id FROM app_user LIMIT 1) FROM attendance_period LIMIT 1`,
    ),
    '23514',
  );
});

test('the period state read (hrCompany.read): open without a row, then every close and reopen with its reason, newest first (D07, F-12)', async () => {
  const month = '2026-09';

  const read = () => stack.attendance.periodState(f.p('H').secret, month);

  assert.deepEqual(await read(), { month, state: 'open', version: '1', events: [] });
  await stack.attendance.closePeriod(f.p('H').fresh, { month });
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Sửa công tháng 9' });
  await stack.attendance.closePeriod(f.p('H').fresh, { month });
  const view = await read();
  assert.equal(view?.state, 'closed');
  assert.equal(view?.version, '4');
  assert.deepEqual(
    view?.events.map((e) => ({ event: e.event, version: e.version, reason: e.reason })),
    [
      { event: 'close', version: '4', reason: null },
      { event: 'reopen', version: '3', reason: 'Sửa công tháng 9' },
      { event: 'close', version: '2', reason: null },
    ],
  );
  assert.ok(view?.events.every((e) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(e.occurredAt)));
  // Not an actor, hash or snapshot: only what the history screen shows.
  assert.deepEqual(Object.keys(view?.events[0] ?? {}).sort(), [
    'event',
    'occurredAt',
    'reason',
    'version',
  ]);
  // Company data: the COO, a lead and an employee without HR admin read nothing (404).
  for (const name of ['C', 'L1'])
    assert.equal(await stack.attendance.periodState(f.p(name).secret, month), undefined);
  const outsider = await stack.person([]);
  assert.equal(await stack.attendance.periodState(outsider.secret, month), undefined);
});
