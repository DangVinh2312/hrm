// T8 part B: cancelling a request on PostgreSQL (design §6.2 `cancel`/`cancel_approved`, D06, D07,
// ADR 0017; acceptance B-23, D-09, E-12): the owner cancels a pending request, HR (fresh) cancels
// an approved one with a reason, the owner cannot cancel an approved one (409), annual leave is
// reversed in the ledger exactly once (UNIQUE per debit, replay included), the WFH counter goes
// down once, the sheet follows the request state (no second copy), a closed month refuses (409
// `error.periodClosed`), audit failure rolls everything back. Past months are fixed (hire
// 2026-01-05); the rest is relative to the DB clock. Synthetic people only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { withClient } from './setup-postgres.ts';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { attendanceFixture, refused, rejected } from './hrm-attendance.helper.ts';

let stack: ModuleStack;
let f: ReturnType<typeof attendanceFixture>;

before(async () => {
  stack = await startModuleStack();
  f = attendanceFixture(stack);
  await f.setup();
});

after(() => stack?.stop());

const ledger = (requestId: string) =>
  stack.migration.query<
    { kind: string; minutes: number; reverses: string | null; id: string; date: string }[]
  >(
    `SELECT l.entry_kind AS kind, l.minutes, l.reverses_entry_id::text AS reverses, l.id::text AS id,
            to_char(l.effective_on,'YYYY-MM-DD') AS date
       FROM leave_ledger l
      WHERE l.source_request_id = $1
         OR l.reverses_entry_id IN (SELECT id FROM leave_ledger WHERE source_request_id = $1)
      ORDER BY l.effective_on, l.entry_kind`,
    [requestId],
  );

const state = async (requestId: string) =>
  (
    await stack.migration.query<{ state: string; version: string }[]>(
      'SELECT state, version::text AS version FROM work_request WHERE id = $1',
      [requestId],
    )
  )[0];

test('B-23: the owner cancels a pending request; a lead gets 404, HR gets 404; nothing is written for the others', async () => {
  const [date] = await f.days(1);
  await f.hire('B1', ['hr.employee']);
  const waiting = await f.submit('B1', f.wfh(date!));
  assert.equal(waiting.state, 'pending_lead');
  // L1 (lead of the team) reads the request but has no cancel right: not found, nothing written.
  const before = await f.cancelSnapshot(waiting.id);
  assert.equal(await f.cancel(waiting, { as: 'L1', reason: null }), undefined);
  assert.equal(
    await f.cancel(waiting, { as: 'H' }),
    undefined,
    'HR cancels approved requests only',
  );
  assert.deepEqual(await f.cancelSnapshot(waiting.id), before);

  const key = randomUUID();
  const cancelled = await f.cancel(waiting, { as: 'B1', reason: null, key });
  assert.deepEqual(cancelled, { id: waiting.id, state: 'cancelled', version: '2' });
  assert.deepEqual(await state(waiting.id), { state: 'cancelled', version: '2' });
  const [decision] = await stack.migration.query<
    { stage: string; decision: string; kind: string; reason: string | null }[]
  >(
    `SELECT stage, decision, actor_kind AS kind, reason FROM request_decision
      WHERE request_id = $1 AND stage = 'cancel'`,
    [waiting.id],
  );
  assert.deepEqual(decision, { stage: 'cancel', decision: 'cancel', kind: 'user', reason: null });
  assert.equal(
    await f.count(
      `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') = 'hr.request.cancel'`,
    ),
    1,
  );
  // Replay with the same key: the stored answer, no second decision.
  assert.deepEqual(await f.cancel(waiting, { as: 'B1', reason: null, key }), cancelled);
  assert.equal((await f.cancelSnapshot(waiting.id)).decisions, before.decisions + 1);
  // A terminal request cannot be cancelled again, nor decided.
  await assert.rejects(f.cancel(waiting, { as: 'B1', reason: null }), rejected('stale_version'));
  await assert.rejects(
    f.cancel({ id: waiting.id, version: '2' }, { as: 'B1', reason: null }),
    rejected('invalid_transition'),
  );
  await assert.rejects(
    stack.approvals.decide(f.p('L1').secret, f.input({ id: waiting.id, version: '2' }, 'approve')),
    rejected('invalid_transition'),
  );
});

test('B-23: the owner cannot cancel an approved request (409), and a mismatched version is stale', async () => {
  const [date] = await f.days(1);
  await f.hire('B2', ['hr.employee']);
  const approved = await f.approve('B2', f.wfh(date!));
  const before = await f.cancelSnapshot(approved.id);
  await assert.rejects(
    f.cancel(approved, { as: 'B2', reason: 'Tôi đổi ý' }),
    rejected('invalid_transition'),
  );
  // Not the owner and no right to cancel approved requests: the same 404 as a stranger gets.
  assert.equal(await f.cancel(approved, { as: 'L1', reason: 'Lead' }), undefined);
  await assert.rejects(
    f.cancel(approved, { version: '1', plain: false }),
    rejected('stale_version'),
  );
  assert.deepEqual(await f.cancelSnapshot(approved.id), before);
  assert.equal((await state(approved.id))?.state, 'approved');
});

test('cancelling an approved request needs HR, a fresh session and a reason; a person with no HR role sees 404', async () => {
  const [date] = await f.days(1);
  await f.hire('B3', ['hr.employee']);
  const approved = await f.approve('B3', f.wfh(date!));
  const before = await f.cancelSnapshot(approved.id);
  await assert.rejects(f.cancel(approved, { plain: true }), ProductAccessDenied);
  await assert.rejects(f.cancel(approved, { reason: null }), ProductInvalidRequest);
  assert.equal(await f.cancel(approved, { as: 'C' }), undefined, 'the COO has no cancel right');
  assert.deepEqual(await f.cancelSnapshot(approved.id), before);
  const outsider = await stack.person([]);
  assert.equal(
    await stack.cancellations.cancel(outsider.fresh, {
      requestId: approved.id,
      expectedVersion: approved.version,
      idempotencyKey: randomUUID(),
      reason: 'Không có quyền',
    }),
    undefined,
  );
  assert.deepEqual(await f.cancelSnapshot(approved.id), before);
  const done = await f.cancel(approved);
  assert.deepEqual(done, { id: approved.id, state: 'cancelled', version: '4' });
  assert.equal(
    await f.count(
      `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') = 'hr.request.cancel-approved'`,
    ),
    1,
  );
  const [row] = await stack.migration.query<{ reason: string | null; actor: string | null }[]>(
    `SELECT reason, actor_account_id::text AS actor FROM request_decision
      WHERE request_id = $1 AND stage = 'cancel'`,
    [approved.id],
  );
  assert.deepEqual(row, { reason: 'HR đảo quyết định', actor: f.p('H').id });
});

test('E-12: cancelling approved annual leave reverses every debit once; a retry with the same key reverses nothing more', async () => {
  const [d1, d2] = await f.days(2);
  await f.hire('B4', ['hr.employee']);
  await f.available('B4', d1!, 5760);
  const before = await stack.leave.balance(f.p('B4').secret, {
    employeeId: f.employeeOf('B4'),
    asOn: d1!,
  });
  const approved = await f.approve('B4', {
    kind: 'annual-leave',
    teamId: null,
    reason: 'Nghỉ phép',
    segments: [
      { date: d1!, startMinute: 540, endMinute: 1080 },
      { date: d2!, startMinute: 540, endMinute: 780 },
    ],
  });
  assert.equal((await ledger(approved.id)).filter((e) => e.kind === 'debit').length, 2);
  const sheet = await f.sheet('B4', d1!.slice(0, 7));
  assert.equal(sheet?.annualLeaveMinutes, 720);

  const key = randomUUID();
  const done = await f.cancel(approved, { key });
  assert.equal(done?.state, 'cancelled');
  const entries = await ledger(approved.id);
  assert.equal(entries.filter((e) => e.kind === 'reversal').length, 2);
  for (const debit of entries.filter((e) => e.kind === 'debit')) {
    const reversal = entries.find((e) => e.reverses === debit.id);
    assert.equal(reversal?.minutes, debit.minutes);
    assert.equal(reversal?.date, debit.date);
  }
  const after = await stack.leave.balance(f.p('B4').secret, {
    employeeId: f.employeeOf('B4'),
    asOn: d1!,
  });
  assert.deepEqual(after, before, 'the balance is back to what it was before the request');
  assert.equal((await f.sheet('B4', d1!.slice(0, 7)))?.annualLeaveMinutes, 0);

  // Retry (the client lost the answer): same result, no third entry.
  assert.deepEqual(await f.cancel(approved, { key }), done);
  assert.equal((await ledger(approved.id)).length, 4);
  // The same days can be booked again with a new request: its debits do not collide.
  const again = await f.approve('B4', {
    kind: 'annual-leave',
    teamId: null,
    reason: 'Nghỉ lại',
    segments: [{ date: d1!, startMinute: 540, endMinute: 1080 }],
  });
  assert.equal(again.state, 'approved');
  // The ledger rejects a second reversal of one debit whatever the application did.
  const [debit] = (await ledger(approved.id)).filter((e) => e.kind === 'debit');
  await assert.rejects(
    stack.migration.query(
      `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reverses_entry_id)
       VALUES (gen_random_uuid(), $1, 'reversal', CAST($2 AS date), $3, $4)`,
      [f.employeeOf('B4'), debit!.date, debit!.minutes, debit!.id],
    ),
    (error: unknown) => (error as { code?: string }).code === '23505',
  );
});

test('D-09: cancelling an approved WFH request lowers the counter by its days, once, and the sheet follows', async () => {
  const [d1, d2, d3] = await f.days(3);
  const month = d1!.slice(0, 7);
  await f.hire('B5', ['hr.employee']);
  const approved = await f.approve('B5', f.wfh(d1!, d2!));
  const other = await f.approve('B5', f.wfh(d3!));
  assert.equal(await f.counter('B5', month), 3);
  assert.equal((await f.sheet('B5', month))?.wfhDays, 3);
  const key = randomUUID();
  const done = await f.cancel(approved, { key });
  assert.equal(done?.state, 'cancelled');
  assert.equal(await f.counter('B5', month), 1);
  assert.equal(await f.approvedWfhDays('B5', month), 1);
  assert.deepEqual(await f.cancel(approved, { key }), done);
  assert.equal(await f.counter('B5', month), 1, 'a retry does not lower it twice');
  assert.equal((await f.sheet('B5', month))?.wfhDays, 1);
  assert.equal((await state(other.id))?.state, 'approved');
});

test('cancelling unpaid, late and early requests removes their effect on the sheet', async () => {
  const [d1, d2, d3] = await f.days(3);
  const month = d1!.slice(0, 7);
  await f.hire('B6', ['hr.employee']);
  const before = await f.sheet('B6', month);
  const unpaid = await f.approve('B6', f.leave('unpaid-leave', d1!, 540, 780));
  const late = await f.approve('B6', f.late(d2!));
  const early = await f.approve('B6', f.early(d3!));
  const during = await f.sheet('B6', month);
  assert.equal(during?.unpaidMinutes, 240);
  assert.equal(during?.lateCount, 1);
  assert.equal(during?.earlyCount, 1);
  for (const request of [unpaid, late, early])
    assert.equal((await f.cancel(request))?.state, 'cancelled');
  assert.deepEqual(
    await f.sheet('B6', month),
    before,
    'recomputed from the same inputs as before the requests',
  );
});

test('F-11: a closed month refuses the cancellation (409 error.periodClosed) and nothing changes; reopened, it goes through', async () => {
  await f.hire('B7', ['hr.employee']);
  await f.available('B7', '2026-02-10', 5760);
  const request = await f.fixtureRequest('B7', 'annual-leave', 'pending_final', ['2026-02-10']);
  const approved = await f.finalDecide(request);
  assert.equal(approved?.state, 'approved');
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-02' });
  const before = await f.cancelSnapshot(request.id);
  await assert.rejects(f.cancel(approved), refused('error.periodClosed', 409));
  assert.deepEqual(await f.cancelSnapshot(request.id), before);
  assert.equal((await ledger(request.id)).length, 1, 'the debit stands, no reversal');
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month: '2026-02', reason: 'Sửa đơn' });
  assert.equal((await f.cancel(approved))?.state, 'cancelled');
  assert.equal((await ledger(request.id)).length, 2);
});

test('a request spanning a closed and an open month is refused as a whole', async () => {
  await f.hire('B8', ['hr.employee']);
  const request = await f.fixtureRequest('B8', 'wfh', 'pending_final', [
    '2026-03-31',
    '2026-04-01',
  ]);
  const approved = await f.finalDecide(request, 'approve', { ack: true });
  assert.equal(approved?.state, 'approved');
  assert.equal(await f.counter('B8', '2026-03'), 1);
  assert.equal(await f.counter('B8', '2026-04'), 1);
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-03' });
  const before = await f.cancelSnapshot(request.id);
  await assert.rejects(f.cancel(approved), refused('error.periodClosed', 409));
  assert.deepEqual(await f.cancelSnapshot(request.id), before);
  assert.equal(await f.counter('B8', '2026-04'), 1, 'no month was lowered');
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month: '2026-03', reason: 'Hủy đơn' });
  assert.equal((await f.cancel(approved))?.state, 'cancelled');
  assert.equal(await f.counter('B8', '2026-03'), 0);
  assert.equal(await f.counter('B8', '2026-04'), 0);
});

test('an audit failure rolls back the cancellation: state, claim, ledger reversal and counter; the same key then succeeds once', async () => {
  const [d1] = await f.days(1);
  await f.hire('B9', ['hr.employee']);
  await f.available('B9', d1!, 5760);
  const leave = await f.approve('B9', f.leave('annual-leave', d1!));
  const [d2] = await f.days(1);
  const wfh = await f.approve('B9', f.wfh(d2!));
  const key = randomUUID();
  for (const request of [leave, wfh]) {
    const before = await f.cancelSnapshot(request.id);
    await withClient(stack.postgres.superuser, (client) =>
      client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
    );
    try {
      await assert.rejects(
        f.cancel(request, { key }),
        (error) => !(error instanceof ProductAccessDenied),
      );
    } finally {
      await withClient(stack.postgres.superuser, (client) =>
        client.query('GRANT INSERT ON audit_outbox TO product_data'),
      );
    }
    assert.deepEqual(await f.cancelSnapshot(request.id), before);
    assert.equal((await f.cancel(request, { key: randomUUID() }))?.state, 'cancelled');
  }
  assert.equal(await f.counter('B9', d2!.slice(0, 7)), 0);
});

test('replaying the approval after the cancellation answers the stored result and changes nothing', async () => {
  const [d1] = await f.days(1);
  await f.hire('B10', ['hr.employee']);
  await f.available('B10', d1!, 5760);
  const waiting = await f.leadApprove('B10', f.leave('annual-leave', d1!));
  const approveKey = randomUUID();
  const approved = await f.finalDecide(waiting, 'approve', { key: approveKey });
  assert.equal(approved?.state, 'approved');
  const cancelled = await f.cancel(approved);
  assert.equal(cancelled?.state, 'cancelled');
  const before = await f.cancelSnapshot(waiting.id);
  assert.deepEqual(await f.finalDecide(waiting, 'approve', { key: approveKey }), approved);
  assert.deepEqual(await f.cancelSnapshot(waiting.id), before);
  const entries = await ledger(waiting.id);
  assert.deepEqual(entries.map((e) => e.kind).sort(), ['debit', 'reversal']);
});

test('an employee outside the caller’s scope and an unknown request are the same 404', async () => {
  const [date] = await f.days(1);
  await f.hire('B11', ['hr.employee']);
  const approved = await f.approve('B11', f.wfh(date!));
  const stranger = await stack.person(['hr.employee']);
  assert.equal(
    await stack.cancellations.cancel(stranger.fresh, {
      requestId: approved.id,
      expectedVersion: approved.version,
      idempotencyKey: randomUUID(),
      reason: 'Không phải của tôi',
    }),
    undefined,
  );
  assert.equal(
    await stack.cancellations.cancel(f.p('H').fresh, {
      requestId: randomUUID(),
      expectedVersion: '1',
      idempotencyKey: randomUUID(),
      reason: 'Không tồn tại',
    }),
    undefined,
  );
});
