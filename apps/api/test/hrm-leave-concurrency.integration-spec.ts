// T7 effect of an approval on PostgreSQL (design §6.2, §6.3 invariant 5, §7.3, ADR 0017; acceptance
// E-06..E-10): the annual-leave debit inside the decision transaction, atomicity with the audit,
// replay, serialization on the (employee, year) bucket even when it is new, two submits and a
// submit against a decision racing for the last minutes, years and status periods. The stack
// registers a STAND-IN `attendance` effect next to the real leave debit (and no WFH part), so
// annual leave is open here while WFH stays closed: the by-kind gate of a partial composition.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ApiRejection } from '../dist/infrastructure/helpers/api-error.helper.js';
import { PermissionObjectRepository } from '../dist/modules/permission/permission-object.repository.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { createApprovedEffects } from '../dist/modules/work-request/services/request-approval.service.js';
import { AttendanceFactsRepository } from '../dist/modules/attendance/repositories/attendance-facts.repository.js';
import { AttendanceEffectRepository } from '../dist/modules/attendance/repositories/attendance-effect.repository.js';
import { LeaveFactsRepository } from '../dist/modules/leave/repositories/leave-facts.repository.js';
import { LeaveEffectRepository } from '../dist/modules/leave/repositories/leave-effect.repository.js';
import type {
  ApprovalInput,
  SubmitRequestInput,
} from '../dist/modules/work-request/work-request.types.js';
import { openClient, withClient } from './setup-postgres.ts';
import { type ModulePerson, type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

const permissionObject = new PermissionObjectRepository();

let stack: ModuleStack;
const people: Record<string, ModulePerson & { employee?: string }> = {};
let team = '';
let sequence = 0;

const p = (name: string) => {
  const person = people[name];
  if (!person) throw new Error(`Unknown fixture person ${name}`);
  return person;
};

const employeeOf = (name: string) => {
  const id = p(name).employee;
  if (!id) throw new Error(`${name} has no profile`);
  return id;
};

const count = async (sql: string, params: unknown[] = []) =>
  Number((await stack.migration.query<{ n: string }[]>(sql, params))[0]?.n ?? 'NaN');

async function hire(
  name: string,
  roles: readonly string[],
  options: { status?: 'probation' | 'official'; hiredOn?: string } = {},
) {
  const person = await stack.person(roles);
  const { id } = await stack.employees.create(await stack.freshRoot(), {
    code: `K${String(++sequence).padStart(3, '0')}`,
    fullName: `Nhân viên duyệt phép giả ${sequence}`,
    hiredOn: options.hiredOn ?? '2026-01-05',
    status: options.status ?? 'official',
    // Probation has no rate row (ADR 0039).
    annualLeaveMinutes: options.status === 'probation' ? null : 5760,
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
  const [version] = await stack.migration.query<{ version: string }[]>(
    'SELECT version::text AS version FROM employee WHERE id=$1',
    [id],
  );
  assert.ok(
    await stack.employees.linkAccount(await stack.freshRoot(), {
      employeeId: id,
      expectedVersion: version!.version,
      accountId: person.id,
    }),
  );
  people[name] = { ...person, employee: id };
  if (name !== 'L1' && name !== 'C' && name !== 'H')
    assert.ok(
      await stack.teams.addMember(await stack.freshRoot(), {
        teamId: team,
        employeeId: id,
        primary: true,
      }),
    );
}

let cursor = 1;

/** `n` unused Monday–Friday dates after today in one month of one year. */
async function days(n: number): Promise<string[]> {
  const found: string[] = [];
  while (found.length < n) {
    const date = await stack.day(cursor++);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (found[0] && found[0].slice(0, 7) !== date.slice(0, 7)) found.length = 0;
    found.push(date);
  }
  return found;
}

const leave = (...dates: string[]) =>
  ({
    kind: 'annual-leave',
    teamId: null,
    reason: 'Nghỉ phép',
    segments: dates.map((date) => ({ date, startMinute: 540, endMinute: 1080 })),
  }) as const satisfies SubmitRequestInput;

const submit = (name: string, input: SubmitRequestInput, key = randomUUID()) =>
  stack.workRequests.submit(p(name).secret, key, input);

/** Entitlement at the end of `date`'s month = `minutes` (hired official 2026-01-05 at 5760). */
const available = (name: string, date: string, minutes: number) =>
  stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
     VALUES (gen_random_uuid(), $1, 'opening', CAST($2 AS date), $3, 'import:điều-chỉnh-thử')`,
    [employeeOf(name), `${date.slice(0, 4)}-01-01`, minutes - 480 * Number(date.slice(5, 7))],
  );

const input = (
  request: { id: string; version: string },
  decision: 'approve' | 'reject',
  options: { version?: string; key?: string } = {},
): ApprovalInput => ({
  requestId: request.id,
  expectedVersion: options.version ?? request.version,
  idempotencyKey: options.key ?? randomUUID(),
  decision,
  reason: decision === 'reject' ? 'Thiếu người' : null,
  acknowledgeWfhLimit: false,
});

/** Lead approval, leaving the request pending_final at version 2. */
async function atFinal(name: string, request: SubmitRequestInput) {
  const created = await submit(name, request);
  assert.ok(created);
  const lead = await stack.approvals.decide(p('L1').secret, input(created, 'approve'));
  assert.equal(lead?.state, 'pending_final');
  return lead;
}

const finalDecide = (
  request: { id: string; version: string },
  decision: 'approve' | 'reject' = 'approve',
  options: { version?: string; key?: string; as?: string } = {},
) => stack.approvals.decide(options.as ?? p('C').secret, input(request, decision, options));

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof ApiRejection && error.code === code && error.status === status;

/** Everything the approval of a request may write. */
const snapshot = async (requestId: string) => ({
  request: (
    await stack.migration.query<{ state: string; version: string }[]>(
      'SELECT state, version::text AS version FROM work_request WHERE id = $1',
      [requestId],
    )
  )[0],
  decisions: await count('SELECT count(*)::text AS n FROM request_decision WHERE request_id = $1', [
    requestId,
  ]),
  claims: await count(
    `SELECT count(*)::text AS n FROM hr_idempotency WHERE operation = 'workRequest.decide'`,
  ),
  audits: await count(
    `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'hr.request.decide%'`,
  ),
  ledger: await count('SELECT count(*)::text AS n FROM leave_ledger WHERE entry_kind = $1', [
    'debit',
  ]),
  buckets: await count('SELECT count(*)::text AS n FROM leave_bucket'),
});

/** A pending_lead annual-leave request written as the owner, at any dates (an older build's). */
async function fixtureLeave(name: string, dates: readonly string[]): Promise<string> {
  const id = randomUUID();
  const objectId = await stack.runner.run('write', (tx) =>
    permissionObject.register(tx, 'workRequest', id),
  );
  await stack.migration.query(
    `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
     VALUES($1,$2,$3,$4,$5,'annual-leave','pending_lead','Đơn cũ')`,
    [id, objectId, employeeOf(name), p(name).id, team],
  );
  await stack.migration.query(
    `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
     SELECT $1,'annual-leave', d, 540, 1080, 480 FROM unnest(CAST($2 AS date[])) AS d`,
    [id, dates],
  );
  return id;
}

/**
 * Holds `n` data-login backends on locks: a superuser transaction runs `hold`, `attempts` start,
 * and the transaction commits only once `n` data backends wait on a lock, inside the runner's 1 s
 * lock timeout (the pattern of hrm-approval / hrm-request).
 */
async function raced<T>(
  hold: string,
  params: unknown[],
  waiting: number,
  attempts: () => readonly Promise<T>[],
  during: () => Promise<void> = () => Promise.resolve(),
): Promise<PromiseSettledResult<T>[]> {
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    await blocker.query('BEGIN');
    await blocker.query(hold, params);
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
    await during();
    await blocker.query('COMMIT');
    return await settled;
  } finally {
    await blocker.end();
    await watcher.end();
  }
}

before(async () => {
  // The real leave debit plus a stand-in attendance effect and no WFH counter: a partial
  // composition, to test the gate by kind (production registers all three parts since T8).
  stack = await startModuleStack({
    effects: {
      leave: createApprovedEffects(
        new AttendanceEffectRepository(new AttendanceFactsRepository()),
        new LeaveEffectRepository(new LeaveFactsRepository()),
      ).leave,
      attendance: () => Promise.resolve(),
    },
  });
  team = (await stack.teams.create(await stack.freshRoot(), { name: 'T1' })).id;
  await hire('L1', ['hr.employee']);
  await hire('C', ['hr.employee', 'hr.coo']);
  await hire('H', ['hr.employee', 'hr.admin']);
  for (const name of ['L1', 'C', 'H'])
    assert.ok(
      await stack.teams.addMember(await stack.freshRoot(), {
        teamId: team,
        employeeId: employeeOf(name),
        primary: true,
      }),
    );
  assert.ok(
    await stack.teams.assignLead(await stack.freshRoot(), {
      teamId: team,
      employeeId: employeeOf('L1'),
    }),
  );
});

after(() => stack?.stop());

test('final approval of annual leave writes the decision, the state, one debit per segment, the new bucket and the audit together; replay and a second approval debit nothing more (E-06, E-10)', async () => {
  await hire('E1', ['hr.employee']);
  const [d1, d2] = await days(2);
  await available('E1', d1!, 960);
  const waiting = await atFinal('E1', leave(d1!, d2!));
  assert.ok(waiting);
  const before = await snapshot(waiting.id);
  assert.equal(before.buckets, 0, 'the bucket does not exist before the first approval');
  const key = randomUUID();
  const result = await finalDecide(waiting, 'approve', { key });
  assert.deepEqual(result, { id: waiting.id, state: 'approved', version: '3' });
  const after = await snapshot(waiting.id);
  assert.deepEqual(after, {
    request: { state: 'approved', version: '3' },
    decisions: before.decisions + 1,
    claims: before.claims + 1,
    audits: before.audits + 1,
    ledger: before.ledger + 2,
    buckets: before.buckets + 1,
  });
  const debits = await stack.migration.query<{ date: string; minutes: number }[]>(
    `SELECT to_char(effective_on,'YYYY-MM-DD') AS date, minutes FROM leave_ledger
      WHERE source_request_id = $1 ORDER BY effective_on`,
    [waiting.id],
  );
  assert.deepEqual(debits, [
    { date: d1, minutes: 480 },
    { date: d2, minutes: 480 },
  ]);
  // The minutes moved from "pending" to the ledger: nothing is counted twice or lost.
  const view = await stack.leave.balance(p('E1').secret, {
    employeeId: employeeOf('E1'),
    asOn: d1!,
  });
  assert.ok(view);
  assert.equal(view.pendingMinutes, 0);
  assert.equal(view.usedMinutes + view.futureApprovedMinutes, 960);
  assert.equal(view.availableMinutes, 0);
  // Replay (same key, same payload): the stored result, no second debit, no second audit.
  assert.deepEqual(await finalDecide(waiting, 'approve', { key }), result);
  assert.deepEqual(await snapshot(waiting.id), after);
  // Another approval of the approved request (new key): refused, nothing written.
  await assert.rejects(
    finalDecide({ id: waiting.id, version: '3' }, 'approve'),
    rejected('invalid_transition'),
  );
  assert.deepEqual(await snapshot(waiting.id), after);
  // The submit check reads the same ledger: nothing is left for another day (E-08).
  const [d3] = await days(1);
  await assert.rejects(submit('E1', leave(d3!)), refused('error.insufficientLeave', 422));
});

test('the opened kind is the only one: WFH needs its own counter effect and stays closed with no state, debit or audit (M3 by kind)', async () => {
  await hire('E2', ['hr.employee']);
  const [date] = await days(1);
  const created = await submit('E2', {
    kind: 'wfh',
    teamId: null,
    reason: 'Làm tại nhà',
    dates: [date!],
  });
  assert.ok(created);
  const waiting = await stack.approvals.decide(p('L1').secret, input(created, 'approve'));
  assert.ok(waiting);
  const before = await snapshot(waiting.id);
  await assert.rejects(finalDecide(waiting), rejected('final_approval_unavailable'));
  assert.deepEqual(await snapshot(waiting.id), before);
});

test('an audit failure rolls back the decision, the state, the claim, the debit and the new bucket (E-07, F-09)', async () => {
  await hire('E3', ['hr.employee']);
  const [date] = await days(1);
  await available('E3', date!, 480);
  const waiting = await atFinal('E3', leave(date!));
  assert.ok(waiting);
  const before = await snapshot(waiting.id);
  const key = randomUUID();
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      finalDecide(waiting, 'approve', { key }),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual(await snapshot(waiting.id), before);
  // With the writer back, the same key and payload now succeed once.
  assert.equal((await finalDecide(waiting, 'approve', { key }))?.state, 'approved');
  assert.equal((await snapshot(waiting.id)).ledger, before.ledger + 1);
});

test('a short entitlement refuses the approval (409, nothing written) and rejecting stays possible', async () => {
  await hire('E4', ['hr.employee']);
  const [date] = await days(1);
  await available('E4', date!, 480);
  const waiting = await atFinal('E4', leave(date!));
  assert.ok(waiting);
  // HR takes leave back after the submit (a signed adjustment with its source).
  await stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
     VALUES (gen_random_uuid(), $1, 'adjustment', CAST($2 AS date), -480, 'adjustment:giảm-thử')`,
    [employeeOf('E4'), `${date!.slice(0, 4)}-01-02`],
  );
  const before = await snapshot(waiting.id);
  await assert.rejects(finalDecide(waiting), rejected('insufficient_leave'));
  assert.deepEqual(await snapshot(waiting.id), before);
  assert.equal((await finalDecide(waiting, 'reject'))?.state, 'rejected');
  assert.equal((await snapshot(waiting.id)).ledger, before.ledger);
});

test('two approvals racing for the last minutes serialize on a NEW bucket: one debit, the other 409 (E-08)', async () => {
  await hire('E5', ['hr.employee']);
  const [d1, d2] = await days(2);
  await available('E5', d1!, 960);
  const first = await atFinal('E5', leave(d1!));
  const second = await atFinal('E5', leave(d2!));
  assert.ok(first && second);
  await stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
     VALUES (gen_random_uuid(), $1, 'adjustment', CAST($2 AS date), -480, 'adjustment:giảm-thử')`,
    [employeeOf('E5'), `${d1!.slice(0, 4)}-01-02`],
  );
  const before = await snapshot(first.id);
  assert.equal(
    await count('SELECT count(*)::text AS n FROM leave_bucket WHERE employee_id = $1', [
      employeeOf('E5'),
    ]),
    0,
  );
  // A superuser transaction inserts the bucket row and keeps it uncommitted: both decisions'
  // `INSERT ... ON CONFLICT DO NOTHING` wait for it, so they are in flight together. After the
  // commit the first one locks the bucket; the second waits for that lock and then sees its debit.
  const results = await raced(
    'INSERT INTO leave_bucket(employee_id, year) VALUES ($1, $2)',
    [employeeOf('E5'), Number(d1!.slice(0, 4))],
    2,
    () => [finalDecide(first), finalDecide(second)],
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.ok(lost && rejected('insufficient_leave')(lost.reason));
  const total = await count(
    `SELECT count(*)::text AS n FROM leave_ledger WHERE employee_id = $1 AND entry_kind = 'debit'`,
    [employeeOf('E5')],
  );
  assert.equal(total, 1, 'only one 480-minute debit exists');
  assert.equal((await snapshot(first.id)).ledger, before.ledger + 1);
  const states = await stack.migration.query<{ state: string }[]>(
    `SELECT state FROM work_request WHERE id = ANY($1::uuid[]) ORDER BY state`,
    [[first.id, second.id]],
  );
  assert.deepEqual(
    states.map((s) => s.state),
    ['approved', 'pending_final'],
  );
});

test('two submits of one employee for the last minutes: one 201, the other 422 (E-08)', async () => {
  await hire('E6', ['hr.employee']);
  const [d1, d2] = await days(2);
  await available('E6', d1!, 480);
  const results = await raced(
    'SELECT 1 FROM employee WHERE id = $1 FOR UPDATE',
    [employeeOf('E6')],
    2,
    () => [submit('E6', leave(d1!)), submit('E6', leave(d2!))],
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.ok(lost && refused('error.insufficientLeave', 422)(lost.reason));
  assert.equal(
    await count(`SELECT count(*)::text AS n FROM work_request WHERE employee_id = $1`, [
      employeeOf('E6'),
    ]),
    1,
  );
});

test('a submit meeting a decision of the same employee never oversubscribes, before or after its commit', async () => {
  await hire('E7', ['hr.employee']);
  const [d1, d2] = await days(2);
  await available('E7', d1!, 480);
  const waiting = await atFinal('E7', leave(d1!));
  assert.ok(waiting);
  // The decision waits on its request row, so the submit runs while the request is still pending.
  const [decision] = await raced(
    'SELECT 1 FROM work_request WHERE id = $1 FOR UPDATE',
    [waiting.id],
    1,
    () => [finalDecide(waiting)],
    () => assert.rejects(submit('E7', leave(d2!)), refused('error.insufficientLeave', 422)),
  );
  assert.equal(decision?.status, 'fulfilled');
  // After the commit the minutes sit in the ledger and the same submit is still refused.
  await assert.rejects(submit('E7', leave(d2!)), refused('error.insufficientLeave', 422));
  assert.equal(
    (await count(`SELECT count(*)::text AS n FROM leave_ledger WHERE employee_id = $1`, [
      employeeOf('E7'),
    ])) - 1,
    1,
    'the opening entry plus exactly one debit',
  );
});

test('each year has its own bucket and entitlement; leave in a probation day is refused at approval (E-15, B-07)', async () => {
  await hire('E8', ['hr.employee']);
  // January 2027: entitlement 480 from that year's own accrual, nothing from 2026.
  const request = await fixtureLeave('E8', ['2027-01-12']);
  const lead = await stack.approvals.decide(
    p('L1').secret,
    input({ id: request, version: '1' }, 'approve'),
  );
  assert.equal(lead?.state, 'pending_final');
  assert.equal((await finalDecide({ id: request, version: '2' }))?.state, 'approved');
  const buckets = await stack.migration.query<{ year: number }[]>(
    'SELECT year FROM leave_bucket WHERE employee_id = $1 ORDER BY year',
    [employeeOf('E8')],
  );
  assert.deepEqual(buckets, [{ year: 2027 }]);

  const view = (asOn: string) =>
    stack.leave.balance(p('E8').secret, { employeeId: employeeOf('E8'), asOn });

  assert.deepEqual(
    [(await view('2027-01-31'))?.usedMinutes, (await view('2027-01-31'))?.availableMinutes],
    [480, 0],
  );
  assert.equal((await view('2026-12-31'))?.usedMinutes, 0);
  // Official from 2026-09-01 only: a day of August is probation, so its approval is refused.
  await hire('E9', ['hr.employee'], { status: 'probation', hiredOn: '2026-01-05' });
  assert.ok(
    await stack.employees.confirmOfficial(p('H').secret, {
      employeeId: employeeOf('E9'),
      effectiveOn: '2026-09-01',
    }),
  );
  const early = await fixtureLeave('E9', ['2026-08-05']);
  assert.equal(
    (await stack.approvals.decide(p('L1').secret, input({ id: early, version: '1' }, 'approve')))
      ?.state,
    'pending_final',
  );
  const before = await snapshot(early);
  await assert.rejects(finalDecide({ id: early, version: '2' }), rejected('not_official'));
  assert.deepEqual(await snapshot(early), before);
});
