// T8 races of the final approval on PostgreSQL (design §6.2, §6.3, §7.3, ADR 0017; acceptance D-03,
// D-05, E-07, F-09, F-10, F-11): approve/approve, approve/reject, approve/revoke, two requests
// racing for the fourth/fifth WFH day, a counter that does not exist yet, a retry after a lock
// timeout, an audit or effect failure rolling back the decision AND the leave debit, and a close of
// a month racing an approval or a calendar change. Barriers are superuser transactions holding
// the rows both attempts need, released once the attempts wait on a lock in the data login's
// backends (the pattern of hrm-leave-concurrency). The production composition, no stand-ins. Past
// months are fixed (2026-02, 2026-04: employees are hired 2026-01-05), the rest is relative to the
// DB clock.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { after, before, test } from 'node:test';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { openClient, withClient } from './setup-postgres.ts';
import { type HrStack, startHrStack } from './hrm-stack.helper.ts';
import { attendanceFixture, refused, rejected } from './hrm-attendance.helper.ts';

let stack: HrStack;
let f: ReturnType<typeof attendanceFixture>;

before(async () => {
  stack = await startHrStack();
  f = attendanceFixture(stack);
  await f.setup();
});

after(() => stack?.stop());

/**
 * `hold` runs in an open superuser transaction; `attempts` start; the transaction commits once
 * `waiting` data-login backends wait on a lock (inside the runner's 1 s lock timeout).
 */
async function raced<T>(
  hold: (client: Client) => Promise<void>,
  waiting: number,
  attempts: () => readonly Promise<T>[],
): Promise<PromiseSettledResult<T>[]> {
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    await blocker.query('BEGIN');
    await hold(blocker);
    const settled = Promise.allSettled(attempts());
    for (let waited = 0; ; waited += 5) {
      const { rows } = await watcher.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'product_data' AND state = 'active' AND wait_event_type = 'Lock'`,
      );
      if (rows[0]?.n === String(waiting)) break;
      if (waited > 800) {
        await blocker.query('ROLLBACK');
        await settled;
        throw new Error('Barrier not reached: the operations were never in flight together');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await blocker.query('COMMIT');
    return await settled;
  } finally {
    await blocker.end();
    await watcher.end();
  }
}

const fulfilled = <T>(results: PromiseSettledResult<T>[]) =>
  results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled');

const failures = (results: PromiseSettledResult<unknown>[]) =>
  results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r): unknown => r.reason);

/** `n` approved WFH requests, one per date, through the real flow (the counter reaches `n`). */
async function approvedWfh(name: string, dates: readonly string[]) {
  for (const date of dates) {
    const waiting = await f.leadApprove(name, f.wfh(date));
    assert.equal((await f.finalDecide(waiting, 'approve', { ack: true }))?.state, 'approved');
  }
}

test('two requests racing for the fourth/fifth WFH day: one is approved (counter 4), the other needs the acknowledgement (D-03)', async () => {
  const dates = await f.days(6);
  const month = dates[0]!.slice(0, 7);
  await f.hire('A1', ['hr.employee']);
  await approvedWfh('A1', dates.slice(0, 3));
  assert.equal(await f.counter('A1', month), 3);
  const one = await f.leadApprove('A1', f.wfh(dates[3]!));
  const two = await f.leadApprove('A1', f.wfh(dates[4]!));
  const before = await f.snapshot(one.id);
  const results = await raced(
    async (client) => {
      await client.query(
        'SELECT 1 FROM wfh_month_counter WHERE employee_id = $1 AND month = CAST($2 AS date) FOR UPDATE',
        [f.employeeOf('A1'), `${month}-01`],
      );
    },
    2,
    () => [f.finalDecide(one), f.finalDecide(two)],
  );
  assert.equal(fulfilled(results).length, 1);
  const [lost] = failures(results);
  assert.ok(refused('error.wfhLimitAckRequired', 409)(lost), 'the loser is asked to acknowledge');
  assert.equal(await f.counter('A1', month), 4);
  assert.equal(await f.approvedWfhDays('A1', month), 4);
  assert.equal((await f.snapshot(one.id)).claims, before.claims + 1);
  // With the acknowledgement the loser goes through: 5.
  const loser = fulfilled(results)[0]?.value?.id === one.id ? two : one;
  assert.equal((await f.finalDecide(loser, 'approve', { ack: true }))?.state, 'approved');
  assert.equal(await f.counter('A1', month), 5);
  assert.equal(await f.approvedWfhDays('A1', month), 5);
});

test('the first WFH of a month has no counter row: two approvals create one row and count both (D-05)', async () => {
  const dates = await f.days(2);
  const month = dates[0]!.slice(0, 7);
  await f.hire('A2', ['hr.employee']);
  const one = await f.leadApprove('A2', f.wfh(dates[0]!));
  const two = await f.leadApprove('A2', f.wfh(dates[1]!));
  assert.equal(await f.counter('A2', month), undefined);
  // A superuser inserts the row and keeps it uncommitted: both `INSERT … ON CONFLICT DO NOTHING`
  // wait for it, so they are in flight together; after the commit one locks the row, then the other.
  const results = await raced(
    async (client) => {
      await client.query(
        'INSERT INTO wfh_month_counter(employee_id, month) VALUES ($1, CAST($2 AS date))',
        [f.employeeOf('A2'), `${month}-01`],
      );
    },
    2,
    () => [f.finalDecide(one), f.finalDecide(two)],
  );
  assert.equal(fulfilled(results).length, 2, JSON.stringify(failures(results).map(String)));
  assert.equal(await f.counter('A2', month), 2);
  assert.equal(
    await f.count('SELECT count(*)::text AS n FROM wfh_month_counter WHERE employee_id = $1', [
      f.employeeOf('A2'),
    ]),
    1,
  );
  // And with no row at all and no barrier: the same result, one row.
  const [d3, d4] = await f.days(2);
  await f.hire('A3', ['hr.employee']);
  const three = await f.leadApprove('A3', f.wfh(d3!));
  const four = await f.leadApprove('A3', f.wfh(d4!));
  const both = await Promise.allSettled([f.finalDecide(three), f.finalDecide(four)]);
  assert.equal(fulfilled(both).length, 2);
  assert.equal(await f.counter('A3', d3!.slice(0, 7)), 2);
});

test('approve/approve and approve/reject on one request: one decision, one effect; the other is a stale version (E-10)', async () => {
  const [d1, d2] = await f.days(2);
  const month = d1!.slice(0, 7);
  await f.hire('A4', ['hr.employee']);
  const request = await f.leadApprove('A4', f.wfh(d1!));

  const lockRequest = (id: string) => async (client: Client) => {
    await client.query('SELECT 1 FROM work_request WHERE id = $1 FOR UPDATE', [id]);
  };

  const approveTwice = await raced(lockRequest(request.id), 2, () => [
    f.finalDecide(request),
    f.finalDecide(request),
  ]);
  assert.equal(fulfilled(approveTwice).length, 1);
  assert.ok(rejected('stale_version')(failures(approveTwice)[0]));
  assert.equal(await f.counter('A4', month), 1);
  assert.equal(
    await f.count(
      `SELECT count(*)::text AS n FROM request_decision WHERE request_id = $1 AND stage = 'final'`,
      [request.id],
    ),
    1,
  );
  const second = await f.leadApprove('A4', f.wfh(d2!));
  const mixed = await raced(lockRequest(second.id), 2, () => [
    f.finalDecide(second, 'approve'),
    f.finalDecide(second, 'reject'),
  ]);
  assert.equal(fulfilled(mixed).length, 1);
  assert.ok(rejected('stale_version')(failures(mixed)[0]));
  const [row] = await stack.migration.query<{ state: string }[]>(
    'SELECT state FROM work_request WHERE id = $1',
    [second.id],
  );
  // Counter and state agree whichever won: counted once if approved, not at all if rejected.
  assert.equal(await f.counter('A4', month), row?.state === 'approved' ? 2 : 1);
  assert.equal(await f.counter('A4', month), await f.approvedWfhDays('A4', month));
});

test('approve racing the revocation of the approver’s role: the effect exists only if the approval did (404 otherwise)', async () => {
  for (const iteration of [1, 2]) {
    const [date] = await f.days(1);
    const name = `A5${iteration}`;
    const approver = `C5${iteration}`;
    await f.hire(name, ['hr.employee']);
    await f.hire(approver, ['hr.employee', 'hr.coo'], { inTeam: false });
    const request = await f.leadApprove(name, f.wfh(date!));
    const [decided, revoked] = await Promise.allSettled([
      f.finalDecide(request, 'approve', { as: f.p(approver).secret }),
      stack.runner.run('admin', (tx) =>
        tx.manager.query(
          `DELETE FROM user_role WHERE user_id = $1 AND role_key = convert_to('hr.coo','UTF8')`,
          [f.p(approver).id],
        ),
      ),
    ]);
    assert.equal(revoked.status, 'fulfilled');
    assert.equal(decided.status, 'fulfilled', 'a lost race is a 404 (undefined), never an error');
    const state = decided.status === 'fulfilled' ? decided.value?.state : undefined;
    assert.ok(state === 'approved' || state === undefined);
    assert.equal(await f.counter(name, date!.slice(0, 7)), state === 'approved' ? 1 : undefined);
  }
});

test('a retry after a lock timeout is a clean first attempt: nothing was left behind, one effect after the retry', async () => {
  const [date] = await f.days(1);
  const month = date!.slice(0, 7);
  await f.hire('A6', ['hr.employee']);
  const request = await f.leadApprove('A6', f.wfh(date!));
  const key = randomUUID();
  const before = await f.snapshot(request.id);
  const blocker = await openClient(stack.postgres.superuser);
  let attempt: PromiseSettledResult<unknown>[];
  try {
    await blocker.query('BEGIN');
    // An uncommitted counter row: the approval waits for it past the runner's lock timeout.
    await blocker.query(
      'INSERT INTO wfh_month_counter(employee_id, month) VALUES ($1, CAST($2 AS date))',
      [f.employeeOf('A6'), `${month}-01`],
    );
    attempt = await Promise.allSettled([f.finalDecide(request, 'approve', { key })]);
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
  }
  assert.equal(attempt[0]?.status, 'rejected', 'the first attempt timed out');
  assert.deepEqual(await f.snapshot(request.id), before);
  const result = await f.finalDecide(request, 'approve', { key });
  assert.deepEqual(result, { id: request.id, state: 'approved', version: '3' });
  assert.equal(await f.counter('A6', month), 1);
  // A replay after the commit (the client lost the answer): same result, no second effect.
  assert.deepEqual(await f.finalDecide(request, 'approve', { key }), result);
  assert.equal(await f.counter('A6', month), 1);
  assert.equal((await f.snapshot(request.id)).claims, before.claims + 1);
});

test('an audit failure rolls back the decision, the claim and the WFH counter; the same key then succeeds once (E-07, F-09)', async () => {
  const [date] = await f.days(1);
  const month = date!.slice(0, 7);
  await f.hire('A7', ['hr.employee']);
  const waiting = await f.leadApprove('A7', f.wfh(date!));
  const before = await f.snapshot(waiting.id);
  const key = randomUUID();
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      f.finalDecide(waiting, 'approve', { key }),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual(await f.snapshot(waiting.id), before);
  assert.equal(await f.counter('A7', month), undefined, 'no counter row survives the rollback');
  assert.equal((await f.finalDecide(waiting, 'approve', { key }))?.state, 'approved');
  assert.equal(await f.counter('A7', month), 1);
});

test('an effect failing after the leave debit (closed month) rolls back the decision, the debit and the new bucket (F-09, F-11)', async () => {
  await f.hire('A8', ['hr.employee']);
  // February 2026: an entitlement of 960 minutes by the end of the month, nothing taken yet.
  const request = await f.fixtureRequest('A8', 'annual-leave', 'pending_final', ['2026-02-10']);
  const before = await f.snapshot(request.id);
  assert.equal(before.buckets, 0);
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-02' });
  // The leave part ran first (bucket + debit), then the attendance period refused: all undone.
  await assert.rejects(f.finalDecide(request), refused('error.periodClosed', 409));
  assert.deepEqual(await f.snapshot(request.id), before);
  assert.equal(
    await f.count('SELECT count(*)::text AS n FROM leave_ledger WHERE source_request_id = $1', [
      request.id,
    ]),
    0,
  );
  // Reopened, the same approval writes the debit.
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month: '2026-02', reason: 'Thử lại' });
  assert.equal((await f.finalDecide(request))?.state, 'approved');
  assert.equal(
    await f.count('SELECT count(*)::text AS n FROM leave_ledger WHERE source_request_id = $1', [
      request.id,
    ]),
    1,
  );
});

test('a close racing a final approval: the closed snapshot contains the effect exactly when the approval committed (F-11)', async () => {
  const month = '2026-04';

  const lockBoth = (id: string) => async (client: Client) => {
    await client.query('SELECT 1 FROM work_request WHERE id = $1 FOR UPDATE', [id]);
    await client.query('SELECT 1 FROM hr_company FOR UPDATE');
  };

  const outcomes = new Set<string>();
  for (const [index, date] of ['2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17'].entries()) {
    const name = `R${index}`;
    await f.hire(name, ['hr.employee']);
    // The month has no period row yet on the first round; later rounds reopen it.
    const request = await f.fixtureRequest(name, 'wfh', 'pending_final', [date]);
    const [approved, closed] = await raced<unknown>(lockBoth(request.id), 2, () => [
      f.finalDecide(request, 'approve', { ack: true }),
      stack.attendance.closePeriod(f.p('H').fresh, { month }),
    ]);
    assert.equal(closed?.status, 'fulfilled', 'the close never fails here');
    const [row] = await stack.migration.query<{ wfh: number | null }[]>(
      `SELECT (e->>'wfhDays')::int AS wfh FROM attendance_period p,
              jsonb_array_elements(p.snapshot->'employees') e
        WHERE p.month = CAST($1 AS date) AND e->>'employeeId' = $2`,
      [`${month}-01`, f.employeeOf(name)],
    );
    if (approved?.status === 'fulfilled') {
      outcomes.add('approved first');
      assert.equal(row?.wfh, 1, 'an approval that committed is in the snapshot');
    } else {
      outcomes.add('closed first');
      assert.ok(refused('error.periodClosed', 409)(approved?.reason));
      assert.equal(row?.wfh, 0, 'a refused approval is not in the snapshot');
      const [state] = await stack.migration.query<{ state: string }[]>(
        'SELECT state FROM work_request WHERE id = $1',
        [request.id],
      );
      assert.equal(state?.state, 'pending_final');
    }
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: `Vòng ${index}` });
  }
  assert.ok(outcomes.size >= 1);
});

test('a close racing a calendar change: the snapshot is at the final calendar version, or the change is refused (F-10)', async () => {
  const month = '2026-06';

  const lockBoth = async (client: Client) => {
    await client.query(`SELECT 1 FROM work_calendar FOR UPDATE`);
    await client.query('SELECT 1 FROM hr_company FOR UPDATE');
  };

  for (const day of ['2026-06-09', '2026-06-10', '2026-06-11']) {
    const calendar = await stack.workCalendar.year(f.p('H').secret, 2026);
    assert.ok(calendar);
    const [changed, closed] = await raced<unknown>(lockBoth, 2, () => [
      stack.workCalendar.setDay(f.p('H').fresh, {
        expectedVersion: calendar.version,
        date: day,
        holiday: 'Ngày lễ thử',
      }),
      stack.attendance.closePeriod(f.p('H').fresh, { month }),
    ]);
    assert.equal(closed?.status, 'fulfilled');
    const finalVersion = (await stack.workCalendar.year(f.p('H').secret, 2026))?.version;
    const [row] = await stack.migration.query<{ version: string }[]>(
      `SELECT snapshot->>'calendarVersion' AS version FROM attendance_period WHERE month = CAST($1 AS date)`,
      [`${month}-01`],
    );
    assert.equal(row?.version, finalVersion);
    if (changed?.status === 'fulfilled')
      assert.equal(finalVersion, String(Number(calendar.version) + 1));
    else assert.ok(refused('error.periodClosed', 409)(changed?.reason));
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Vòng thử' });
  }
});
