// T8 part B races of the cancellation on PostgreSQL (design §6.2, §7.3, ADR 0017; acceptance B-23,
// D-09, E-12, F-11): cancel/cancel on one request (different keys: one wins, the other is a stale
// version; the same key: both get the one stored answer), a pending cancel racing the final
// approval, and an approved request's cancel racing the close of its month. Barriers are superuser
// transactions holding the rows the attempts need, released once the attempts wait on a lock in
// the data login's backends (the pattern of hrm-attendance-concurrency). Past months are fixed
// (2026-05: employees are hired 2026-01-05), the rest is relative to the DB clock.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { after, before, test } from 'node:test';
import { type HrStack, startHrStack } from './hrm-stack.helper.ts';
import {
  attendanceFixture,
  failures,
  fulfilled,
  raced,
  refused,
  rejected,
} from './hrm-attendance.helper.ts';

let stack: HrStack;
let f: ReturnType<typeof attendanceFixture>;

before(async () => {
  stack = await startHrStack();
  f = attendanceFixture(stack);
  await f.setup();
});

after(() => stack?.stop());

const lockRequest = (id: string) => async (client: Client) => {
  await client.query('SELECT 1 FROM work_request WHERE id = $1 FOR UPDATE', [id]);
};

const entries = async (requestId: string) =>
  f.count(
    `SELECT count(*)::text AS n FROM leave_ledger
      WHERE source_request_id = $1 OR reverses_entry_id IN
            (SELECT id FROM leave_ledger WHERE source_request_id = $1)`,
    [requestId],
  );

test('two HR cancellations of one approved annual-leave request: one reverses it, the other is a stale version (E-12)', async () => {
  const [date] = await f.days(1);
  await f.hire('K1', ['hr.employee']);
  await f.available('K1', date!, 5760);
  const approved = await f.approve('K1', f.leave('annual-leave', date!));
  assert.equal(await entries(approved.id), 1);
  const results = await raced(stack, lockRequest(approved.id), 2, () => [
    f.cancel(approved),
    f.cancel(approved),
  ]);
  assert.equal(fulfilled(results).length, 1);
  assert.ok(rejected('stale_version')(failures(results)[0]));
  assert.equal(await entries(approved.id), 2, 'one debit and exactly one reversal');
  assert.equal(
    await f.count(
      `SELECT count(*)::text AS n FROM request_decision WHERE request_id = $1 AND stage = 'cancel'`,
      [approved.id],
    ),
    1,
  );
});

test('two cancellations with the same key (a retry racing the original): both get the one stored answer', async () => {
  const [d1] = await f.days(1);
  await f.hire('K2', ['hr.employee']);
  const approved = await f.approve('K2', f.wfh(d1!));
  const key = randomUUID();
  const results = await raced(stack, lockRequest(approved.id), 2, () => [
    f.cancel(approved, { key }),
    f.cancel(approved, { key }),
  ]);
  const done = fulfilled(results).map((r) => r.value);
  assert.equal(done.length, 2, JSON.stringify(failures(results).map(String)));
  assert.deepEqual(done[0], done[1]);
  assert.equal(done[0]?.state, 'cancelled');
  assert.equal(await f.counter('K2', d1!.slice(0, 7)), 0, 'the counter went down once');
});

test('the owner cancelling a pending request racing the final approval: one commits, the other is a stale version; the debit exists only if approved', async () => {
  const [date] = await f.days(1);
  await f.hire('K3', ['hr.employee']);
  await f.available('K3', date!, 5760);
  const waiting = await f.leadApprove('K3', f.leave('annual-leave', date!));
  assert.equal(waiting.state, 'pending_final');
  const results = await raced(stack, lockRequest(waiting.id), 2, () => [
    f.cancel(waiting, { as: 'K3', reason: null }),
    f.finalDecide(waiting),
  ]);
  assert.equal(fulfilled(results).length, 1);
  assert.ok(rejected('stale_version')(failures(results)[0]));
  const [row] = await stack.migration.query<{ state: string }[]>(
    'SELECT state FROM work_request WHERE id = $1',
    [waiting.id],
  );
  assert.ok(row?.state === 'approved' || row?.state === 'cancelled');
  assert.equal(await entries(waiting.id), row?.state === 'approved' ? 1 : 0);
});

test('an approved request’s cancellation racing the close of its month: the snapshot counts it exactly when it was not cancelled (F-11)', async () => {
  const month = '2026-05';

  const lockBoth = (id: string) => async (client: Client) => {
    await client.query('SELECT 1 FROM work_request WHERE id = $1 FOR UPDATE', [id]);
    await client.query('SELECT 1 FROM hr_company FOR UPDATE');
  };

  const outcomes = new Set<string>();
  for (const [index, date] of ['2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15'].entries()) {
    const name = `K4${index}`;
    await f.hire(name, ['hr.employee']);
    const request = await f.fixtureRequest(name, 'wfh', 'pending_final', [date]);
    const approved = await f.finalDecide(request, 'approve', { ack: true });
    assert.equal(approved?.state, 'approved');
    const [cancelled, closed] = await raced<unknown>(stack, lockBoth(request.id), 2, () => [
      f.cancel(approved),
      stack.attendance.closePeriod(f.p('H').fresh, { month }),
    ]);
    assert.equal(closed?.status, 'fulfilled', 'the close never fails here');
    const [snap] = await stack.migration.query<{ wfh: number | null }[]>(
      `SELECT (e->>'wfhDays')::int AS wfh FROM attendance_period p,
              jsonb_array_elements(p.snapshot->'employees') e
        WHERE p.month = CAST($1 AS date) AND e->>'employeeId' = $2`,
      [`${month}-01`, f.employeeOf(name)],
    );
    const [row] = await stack.migration.query<{ state: string }[]>(
      'SELECT state FROM work_request WHERE id = $1',
      [request.id],
    );
    if (cancelled?.status === 'fulfilled') {
      outcomes.add('cancelled first');
      assert.equal(row?.state, 'cancelled');
      assert.equal(snap?.wfh, 0, 'a committed cancellation is not in the snapshot');
      assert.equal(await f.counter(name, month), 0);
    } else {
      outcomes.add('closed first');
      assert.ok(refused('error.periodClosed', 409)(cancelled?.reason));
      assert.equal(row?.state, 'approved');
      assert.equal(snap?.wfh, 1, 'a refused cancellation leaves the effect in the snapshot');
      assert.equal(await f.counter(name, month), 1);
    }
    await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: `Vòng ${index}` });
  }
  assert.ok(outcomes.size >= 1);
});
