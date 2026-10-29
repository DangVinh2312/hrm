// T8 part B: the COO's own request is approved at submit (design §6.4 (1), acceptance C-26, D-10):
// the effects of a final approval run in the submit transaction after the insert, a system
// decision `coo_self_approved` is written, the WFH cap only warns, the leave balance, a closed
// month and a missing effect handler refuse with nothing written, and an audit failure rolls the
// request, the effect and the claim back together. Past months are fixed (hire 2026-01-05), the
// rest is relative to the DB clock. Synthetic people only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { withClient } from './setup-postgres.ts';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import { attendanceFixture, refused, rejected } from './hrm-attendance.helper.ts';

let stack: ModuleStack;
let f: ReturnType<typeof attendanceFixture>;
let closed: ModuleStack;
let cf: ReturnType<typeof attendanceFixture>;

before(async () => {
  stack = await startModuleStack();
  f = attendanceFixture(stack);
  await f.setup();
  // A composition without any effect handler: every kind stays closed (fail closed).
  closed = await startModuleStack({ effects: {} });
  cf = attendanceFixture(closed);
  await cf.setup();
});

after(async () => {
  await stack?.stop();
  await closed?.stop();
});

const requests = (name: string) =>
  stack.migration.query<{ id: string; state: string; version: string; kind: string }[]>(
    'SELECT id::text AS id, state, version::text AS version, kind FROM work_request WHERE employee_id = $1 ORDER BY created_at, id',
    [f.employeeOf(name)],
  );

const everything = async (name: string) => ({
  requests: await requests(name),
  decisions: await f.count('SELECT count(*)::text AS n FROM request_decision'),
  claims: await f.count(
    `SELECT count(*)::text AS n FROM hr_idempotency WHERE operation = 'workRequest.submit'`,
  ),
  audits: await f.count('SELECT count(*)::text AS n FROM audit_outbox'),
  ledger: await f.count('SELECT count(*)::text AS n FROM leave_ledger'),
  buckets: await f.count('SELECT count(*)::text AS n FROM leave_bucket'),
  counters: await f.count(
    'SELECT coalesce(sum(approved_count),0)::text AS n FROM wfh_month_counter',
  ),
});

test('C-26: the COO’s late request is approved at submit with a system decision, version 1, and counts on the sheet', async () => {
  const [date] = await f.days(1);
  await f.hire('O1', ['hr.employee', 'hr.coo']);
  const result = await f.submit('O1', f.late(date!));
  assert.deepEqual(result, { id: result.id, state: 'approved', version: '1' });
  const detail = await stack.workRequests.detail(f.p('O1').secret, result.id);
  assert.deepEqual(
    detail?.decisions.map((d) => ({
      stage: d.stage,
      decision: d.decision,
      actorKind: d.actorKind,
      systemReason: d.systemReason,
      reason: d.reason,
    })),
    [
      {
        stage: 'final',
        decision: 'approve',
        actorKind: 'system',
        systemReason: 'coo_self_approved',
        reason: null,
      },
    ],
  );
  assert.equal((await f.sheet('O1', date!.slice(0, 7)))?.lateCount, 1);
  // The system decision is no user decision: nobody becomes a decider of it.
  assert.equal(
    await f.count('SELECT count(*)::text AS n FROM hr_request_decider WHERE request_id = $1', [
      result.id,
    ]),
    0,
  );
  assert.equal(
    await f.count(
      `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') = 'hr.request.self-approve'`,
    ),
    1,
  );
});

test('D-10: the COO’s fifth WFH day of a month is approved at submit with the warning, and the counter reads 5', async () => {
  const dates = await f.days(5);
  const month = dates[0]!.slice(0, 7);
  await f.hire('O2', ['hr.employee', 'hr.coo']);
  const results = [];
  for (const date of dates) results.push(await f.submit('O2', f.wfh(date)));
  assert.deepEqual(
    results.map((r) => r.state),
    ['approved', 'approved', 'approved', 'approved', 'approved'],
  );
  assert.deepEqual(
    results.map((r) => r.wfhLimitExceeded),
    [false, false, false, false, true],
  );
  assert.equal(await f.counter('O2', month), 5);
  assert.equal(await f.approvedWfhDays('O2', month), 5);
});

test('annual leave: approved at submit with its debits when the balance covers it, refused (422) otherwise; a retry debits once', async () => {
  const [d1, d2] = await f.days(2);
  await f.hire('O3', ['hr.employee', 'hr.coo']);
  await f.available('O3', d1!, 480);
  const before = await everything('O3');
  // 2 days against 1: refused by the submit balance check, nothing written.
  await assert.rejects(
    f.submit('O3', {
      kind: 'annual-leave',
      teamId: null,
      reason: 'Nghỉ',
      segments: [
        { date: d1!, startMinute: 540, endMinute: 1080 },
        { date: d2!, startMinute: 540, endMinute: 1080 },
      ],
    }),
    refused('error.insufficientLeave', 422),
  );
  assert.deepEqual(await everything('O3'), before);
  const key = randomUUID();
  const approved = await f.submit('O3', f.leave('annual-leave', d1!), key);
  assert.equal(approved.state, 'approved');

  const debit = () =>
    f.count(
      `SELECT count(*)::text AS n FROM leave_ledger WHERE source_request_id = $1 AND entry_kind = 'debit'`,
      [approved.id],
    );

  assert.equal(await debit(), 1);
  assert.deepEqual(await f.submit('O3', f.leave('annual-leave', d1!), key), approved);
  assert.equal(await debit(), 1);
  assert.equal((await requests('O3')).length, 1);
  const balance = await stack.leave.balance(f.p('O3').secret, {
    employeeId: f.employeeOf('O3'),
    asOn: d1!,
  });
  assert.equal(balance?.availableMinutes, 0);
});

test('B-22: a closed month refuses the COO’s request; nothing is written; reopened, it is approved', async () => {
  await f.hire('O4', ['hr.employee', 'hr.coo']);
  // The submit window is [today − 7, today + 90]: use the latest weekday on or before today.
  const date = await stack.latestWeekday();
  const month = date.slice(0, 7);
  await stack.attendance.closePeriod(f.p('H').fresh, { month });
  const before = await everything('O4');
  await assert.rejects(f.submit('O4', f.wfh(date)), refused('error.periodClosed', 409));
  assert.deepEqual(await everything('O4'), before);
  await stack.attendance.reopenPeriod(f.p('H').fresh, { month, reason: 'Gửi đơn COO' });
  assert.equal((await f.submit('O4', f.wfh(date))).state, 'approved');
});

test('an audit failure rolls back the request, its effect and the claim; the same key then succeeds once', async () => {
  const [d1, d2] = await f.days(2);
  await f.hire('O5', ['hr.employee', 'hr.coo']);
  await f.available('O5', d1!, 5760);
  const key = randomUUID();
  for (const input of [f.wfh(d1!), f.leave('annual-leave', d2!)]) {
    const before = await everything('O5');
    await withClient(stack.postgres.superuser, (client) =>
      client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
    );
    try {
      await assert.rejects(
        stack.workRequests.submit(f.p('O5').secret, key, input),
        (error) => !(error instanceof ProductAccessDenied),
      );
    } finally {
      await withClient(stack.postgres.superuser, (client) =>
        client.query('GRANT INSERT ON audit_outbox TO product_data'),
      );
    }
    assert.deepEqual(await everything('O5'), before);
    assert.equal(
      (await stack.workRequests.submit(f.p('O5').secret, randomUUID(), input))?.state,
      'approved',
    );
  }
  assert.equal(await f.counter('O5', d1!.slice(0, 7)), 1);
});

test('C-26: without the effect handlers of its kind the COO cannot submit (fail closed) and nothing is created', async () => {
  const [date] = await cf.days(1);
  await cf.hire('O6', ['hr.employee', 'hr.coo']);

  const count = () =>
    cf.count('SELECT count(*)::text AS n FROM work_request WHERE employee_id = $1', [
      cf.employeeOf('O6'),
    ]);

  for (const input of [cf.late(date!), cf.wfh(date!), cf.leave('unpaid-leave', date!)])
    await assert.rejects(
      closed.workRequests.submit(cf.p('O6').secret, randomUUID(), input),
      rejected('final_approval_unavailable'),
    );
  assert.equal(await count(), 0);
  assert.equal(
    await cf.count('SELECT count(*)::text AS n FROM hr_idempotency WHERE operation = $1', [
      'workRequest.submit',
    ]),
    0,
  );
  // An ordinary employee is unaffected by the missing handlers: the request waits for the lead.
  await cf.hire('O7', ['hr.employee']);
  assert.equal((await cf.submit('O7', cf.wfh(date!))).state, 'pending_lead');
});

test('M1: the self-approval needs the real decideFinal right: a deny rule refuses it (409, nothing written) and lifting it restores it', async () => {
  const [d1, d2] = await f.days(2);
  await f.hire('O8', ['hr.employee', 'hr.coo']);
  const before = await everything('O8');
  const rule = randomUUID();
  await stack.migration.query(
    `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
       VALUES ($1, convert_to('workRequest.decideFinal','UTF8'), $2, 'deny', convert_to('allRequests','UTF8'), 1, '{}', 'runtime')`,
    [rule, f.p('O8').id],
  );
  try {
    for (const input of [f.wfh(d1!), f.late(d2!), f.leave('unpaid-leave', d1!)])
      await assert.rejects(
        stack.workRequests.submit(f.p('O8').secret, randomUUID(), input),
        rejected('final_approval_unavailable'),
      );
    assert.deepEqual(await everything('O8'), before);
  } finally {
    await stack.runner.run('admin', (tx) =>
      tx.manager.query('DELETE FROM policy_rule WHERE rule_id = $1', [rule]),
    );
  }
  assert.equal((await f.submit('O8', f.wfh(d1!))).state, 'approved');
});

test('M1: once the hr.coo role is revoked the next submit is an ordinary one (no self-approval)', async () => {
  const [date] = await f.days(1);
  await f.hire('O9', ['hr.employee', 'hr.coo']);
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `DELETE FROM user_role WHERE user_id = $1 AND role_key = convert_to('hr.coo','UTF8')`,
      [f.p('O9').id],
    ),
  );
  // No hr.coo role any more: an ordinary employee, the request waits for the lead.
  assert.equal((await f.submit('O9', f.wfh(date!))).state, 'pending_lead');
});

test('M1: a lead and an employee with no COO role have no self-approval path', async () => {
  const [d1, d2] = await f.days(2);
  const month = d1!.slice(0, 7);
  const before = await f.count(
    'SELECT coalesce(sum(approved_count),0)::text AS n FROM wfh_month_counter',
  );
  const lead = await f.submit('L1', f.wfh(d1!));
  assert.equal(lead.state, 'pending_final', 'the lead skips only the lead step');
  await f.hire('O10', ['hr.employee']);
  assert.equal((await f.submit('O10', f.wfh(d2!))).state, 'pending_lead');
  assert.equal(
    await f.count('SELECT coalesce(sum(approved_count),0)::text AS n FROM wfh_month_counter'),
    before,
  );
  assert.equal(await f.counter('O10', month), undefined);
});
