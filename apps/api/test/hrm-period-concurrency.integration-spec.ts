// T8 part B: the D07 close of a month against every writer that can change its numbers, on
// PostgreSQL (design §7.3, ADR 0017 §2, ADR 0018; acceptance B-22, F-10, F-14): creating or
// terminating an employee in a closed month is refused (409 `error.periodClosed`), a close racing
// a submit, an employee create or an employee termination leaves the stored snapshot equal to the
// live sheet, and submit / calendar change / close started together neither deadlock nor lose
// one another. Barriers are superuser transactions holding rows the attempts need, released once
// the attempts wait on a lock in the data login's backends. Past months are fixed (employees are
// hired 2026-01-05); the month under close in the submit race is the one of the latest weekday on
// or before the DB date (inside the submit window), so no test depends on the calendar date.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { after, before, test } from 'node:test';
import { openClient } from './setup-postgres.ts';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { attendanceFixture, raced, refused, waitForLocks } from './hrm-attendance.helper.ts';

let stack: ModuleStack;
let f: ReturnType<typeof attendanceFixture>;
let sequence = 0;

before(async () => {
  stack = await startModuleStack();
  f = attendanceFixture(stack);
  await f.setup();
});

after(() => stack?.stop());

const hrCompany = async (client: Client) => {
  await client.query('SELECT 1 FROM hr_company FOR UPDATE');
};

/** Profile input of a synthetic employee hired `hiredOn` (no account, no team). */
const newEmployee = (hiredOn: string) => ({
  code: `Q${String(++sequence).padStart(3, '0')}`,
  fullName: `Nhân viên kỳ giả ${sequence}`,
  hiredOn,
  status: 'official' as const,
  annualLeaveMinutes: 5760,
  identity: {
    dateOfBirth: null,
    documentKind: null,
    documentNumber: null,
    taxCode: null,
    gender: null,
    phone: null,
    workEmail: null,
  },
  position: null,
  classification: null,
});

const snapshotOf = async (month: string, employeeId: string) =>
  (
    await stack.migration.query<{ scheduled: number; paid: number }[]>(
      `SELECT (e->>'scheduledMinutes')::int AS scheduled, (e->>'paidMinutes')::int AS paid
         FROM attendance_period p, jsonb_array_elements(p.snapshot->'employees') e
        WHERE p.month = CAST($1 AS date) AND e->>'employeeId' = $2`,
      [`${month}-01`, employeeId],
    )
  )[0];

const employeeCount = (code: string) =>
  f.count('SELECT count(*)::text AS n FROM employee WHERE code = $1', [code]);

test('B-22/D07: creating or terminating an employee in a closed month is refused; other months are not affected; reopened, both go through', async () => {
  const ids: string[] = [];
  for (const name of ['Z1', 'Z2', 'Z3']) {
    await f.hire(name, ['hr.employee'], { inTeam: false });
    ids.push(f.employeeOf(name));
  }
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-02' });
  const root = await stack.freshRoot();
  const hr = f.p('H').secret;

  // A hire dated in or before a closed month would change its sheet: refused, nothing created.
  for (const hiredOn of ['2026-02-10', '2026-01-26']) {
    const input = newEmployee(hiredOn);
    await assert.rejects(stack.employees.create(root, input), refused('error.periodClosed', 409));
    assert.equal(await employeeCount(input.code), 0);
  }
  // A leaving date in a closed month, or before one, would change it too.
  const before = await stack.migration.query<unknown[]>(
    'SELECT terminated_on, version FROM employee WHERE id = $1',
    [ids[0]],
  );
  for (const terminatedOn of ['2026-02-20', '2026-02-02', '2026-01-30'])
    await assert.rejects(
      stack.employees.terminate(hr, { employeeId: ids[0]!, terminatedOn }),
      refused('error.periodClosed', 409),
    );
  assert.deepEqual(
    await stack.migration.query('SELECT terminated_on, version FROM employee WHERE id = $1', [
      ids[0],
    ]),
    before,
  );
  const snapshot = await snapshotOf('2026-02', ids[0]!);
  assert.equal((await f.sheet('Z1', '2026-02'))?.scheduledMinutes, snapshot?.scheduled);

  // Months after the closed one are open: a hire and a termination there change nothing closed.
  const open = newEmployee('2026-03-02');
  assert.ok(await stack.employees.create(root, open));
  assert.ok(
    await stack.employees.terminate(hr, { employeeId: ids[1]!, terminatedOn: '2026-03-13' }),
  );
  assert.equal((await f.sheet('Z1', '2026-02'))?.scheduledMinutes, snapshot?.scheduled);

  await stack.attendance.reopenPeriod(f.p('H').fresh, { month: '2026-02', reason: 'Sửa hồ sơ' });
  assert.ok(await stack.employees.create(root, newEmployee('2026-02-10')));
  assert.ok(
    await stack.employees.terminate(hr, { employeeId: ids[2]!, terminatedOn: '2026-02-20' }),
  );
});

test('a close racing an employee create: the snapshot holds the new employee exactly when the create committed', async () => {
  const month = '2026-07';
  for (const [index, hiredOn] of [
    '2026-07-06',
    '2026-07-07',
    '2026-07-08',
    '2026-07-09',
  ].entries()) {
    const input = newEmployee(hiredOn);
    const root = await stack.freshRoot();
    const [created, closed] = await raced<unknown>(stack, hrCompany, 2, () => [
      stack.employees.create(root, input),
      stack.attendance.closePeriod(f.p('H').fresh, { month }),
    ]);
    assert.equal(closed?.status, 'fulfilled', 'the close never fails here');
    const [{ id } = { id: undefined }] = await stack.migration.query<{ id: string }[]>(
      'SELECT id::text AS id FROM employee WHERE code = $1',
      [input.code],
    );
    const inSnapshot = id === undefined ? undefined : await snapshotOf(month, id);
    if (created?.status === 'fulfilled') {
      assert.ok(id, 'the create committed');
      assert.ok(inSnapshot, 'a committed hire is in the snapshot of the month it was hired in');
    } else {
      assert.ok(refused('error.periodClosed', 409)(created?.reason));
      assert.equal(id, undefined, 'a refused hire left nothing behind');
    }
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: `Vòng ${index}` });
  }
});

test('a close racing an employee termination: the stored snapshot equals the live sheet whichever commits first', async () => {
  const month = '2026-08';
  for (const [index, terminatedOn] of ['2026-08-12', '2026-08-13', '2026-08-14'].entries()) {
    const name = `Z4${index}`;
    await f.hire(name, ['hr.employee'], { inTeam: false });
    const employeeId = f.employeeOf(name);
    const [ended, closed] = await raced<unknown>(
      stack,
      async (client) => {
        await client.query('SELECT 1 FROM employee WHERE id = $1 FOR UPDATE', [employeeId]);
        await hrCompany(client);
      },
      2,
      () => [
        stack.employees.terminate(f.p('H').secret, { employeeId, terminatedOn }),
        stack.attendance.closePeriod(f.p('H').fresh, { month }),
      ],
    );
    assert.equal(closed?.status, 'fulfilled');
    const live = await stack.attendance.period(f.p('H').secret, { employeeId, month });
    const stored = await snapshotOf(month, employeeId);
    assert.deepEqual(
      { scheduled: live?.scheduledMinutes, paid: live?.paidMinutes },
      stored,
      'no drift between what was closed and what the sheet says now',
    );
    if (ended?.status !== 'fulfilled')
      assert.ok(refused('error.periodClosed', 409)(ended?.reason), String(ended?.reason));
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: `Vòng ${index}` });
  }
});

test('a submit racing the close of its month: the request exists only if it committed before the close (B-22)', async () => {
  const date = await stack.latestWeekday();
  const month = date.slice(0, 7);
  for (const index of [0, 1, 2]) {
    const name = `Z5${index}`;
    await f.hire(name, ['hr.employee']);
    const employeeId = f.employeeOf(name);
    const [submitted, closed] = await raced<unknown>(
      stack,
      async (client) => {
        await client.query('SELECT 1 FROM employee WHERE id = $1 FOR UPDATE', [employeeId]);
        await hrCompany(client);
      },
      2,
      () => [
        stack.workRequests.submit(f.p(name).secret, randomUUID(), f.wfh(date)),
        stack.attendance.closePeriod(f.p('H').fresh, { month }),
      ],
    );
    assert.equal(closed?.status, 'fulfilled', 'the close never fails here');
    const requests = await stack.migration.query<{ created: Date }[]>(
      'SELECT created_at AS created FROM work_request WHERE employee_id = $1',
      [employeeId],
    );
    if (submitted?.status === 'fulfilled') {
      assert.equal(requests.length, 1);
      const [event] = await stack.migration.query<{ at: Date }[]>(
        `SELECT occurred_at AS at FROM attendance_period_event
          WHERE month = CAST($1 AS date) AND event = 'close' ORDER BY version DESC LIMIT 1`,
        [`${month}-01`],
      );
      assert.ok(
        requests[0]!.created < event!.at,
        'a request in a closed month was written before the close, never after',
      );
    } else {
      assert.ok(refused('error.periodClosed', 409)(submitted?.reason), String(submitted?.reason));
      assert.equal(requests.length, 0);
    }
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: `Vòng ${index}` });
  }
});

test('submit, a calendar change and the close of the same month started together all finish: no deadlock, no lock timeout (spec §7.3 order)', async () => {
  const date = await stack.latestWeekday();
  const month = date.slice(0, 7);
  const day = await stack.otherWeekday(month, date);
  await f.hire('Z6', ['hr.employee']);
  // The month's period row is committed before the race, so every writer finds it (not a
  // speculative insert that would hide the lock order under test).
  await stack.migration.query(
    'INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING',
    [`${month}-01`],
  );
  const calendar = await stack.workCalendar.year(f.p('H').secret, Number(month.slice(0, 4)));
  assert.ok(calendar);
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    // The blocker holds the calendar: the submit takes the employee and the month FOR SHARE and
    // waits at the calendar; the close then waits for the month; the calendar change waits behind
    // the blocker too. When the blocker commits the three are in the order that could deadlock.
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM work_calendar FOR UPDATE');

    const giveUp = async () => {
      await blocker.query('ROLLBACK');
    };

    const submit = Promise.allSettled([
      stack.workRequests.submit(f.p('Z6').secret, randomUUID(), f.wfh(date)),
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
    const [[submitted], [closed], [changed]] = await Promise.all([submit, close, change]);
    assert.equal(
      submitted?.status,
      'fulfilled',
      String(submitted?.status === 'rejected' && submitted.reason),
    );
    assert.equal(
      closed?.status,
      'fulfilled',
      String(closed?.status === 'rejected' && closed.reason),
    );
    if (changed?.status !== 'fulfilled')
      assert.ok(refused('error.periodClosed', 409)(changed?.reason), String(changed?.reason));
    // The snapshot is at the calendar version that was final when the month closed.
    const [row] = await stack.migration.query<{ version: string; state: string }[]>(
      `SELECT snapshot->>'calendarVersion' AS version, state FROM attendance_period
        WHERE month = CAST($1 AS date)`,
      [`${month}-01`],
    );
    assert.equal(row?.state, 'closed');
    assert.equal(
      row?.version,
      (await stack.workCalendar.year(f.p('H').secret, Number(month.slice(0, 4))))?.version,
    );
  } finally {
    await blocker.end().catch(() => undefined);
    await watcher.end();
  }
});
