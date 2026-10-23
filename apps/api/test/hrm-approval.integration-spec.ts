// T6 decisions on PostgreSQL (design §6.2–§6.4.1, §7, ADR 0017; acceptance C-01..C-25): who may
// decide which stage, the one-step chain of late/early, the M3 gate refusing every approval that
// would reach `approved`, expectedVersion, idempotent replay with a fresh permission check,
// races on two connections, atomic audit and the queues. Synthetic people only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ApiRejection } from '../dist/infrastructure/helpers/api-error.helper.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import type {
  ApprovalInput,
  SubmitRequestInput,
  SubmitResult,
} from '../dist/modules/work-request/work-request.types.js';
import { openClient, sqlState, withClient } from './setup-postgres.ts';
import { type HrPerson, type HrStack, startHrStack } from './hrm-stack.helper.ts';

// T1: lead L1, members E1 (primary), E2, E3 (primary), L1, L3. T2: lead L2, members L2, C, X and
// E3 (second team). T4: lead LC (also hr.coo), member M4. T5: no lead, member E5. H is HR/Admin,
// X the CEO (employee role only), N signed in without any HR role.
let stack: HrStack;
const people: Record<string, HrPerson & { employee?: string }> = {};
const teams: Record<string, string> = {};
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

/** Everything a decision may write; a refused decision leaves all of it unchanged. */
const snapshot = async (requestId: string) => ({
  row: (
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
});

const versionOf = async (employeeId: string) =>
  (
    await stack.migration.query<{ version: string }[]>(
      'SELECT version::text AS version FROM employee WHERE id=$1',
      [employeeId],
    )
  )[0]!.version;

async function hire(name: string, roles: readonly string[]) {
  const person = await stack.person(roles);
  const { id } = await stack.employees.create(await stack.freshRoot(), {
    code: `A${String(++sequence).padStart(3, '0')}`,
    fullName: `Người duyệt giả ${sequence}`,
    hiredOn: '2026-01-05',
    status: 'official',
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
  assert.ok(
    await stack.employees.linkAccount(await stack.freshRoot(), {
      employeeId: id,
      expectedVersion: await versionOf(id),
      accountId: person.id,
    }),
  );
  people[name] = { ...person, employee: id };
}

const member = async (team: string, name: string, primary: boolean) =>
  assert.ok(
    await stack.teams.addMember(await stack.freshRoot(), {
      teamId: teams[team]!,
      employeeId: employeeOf(name),
      primary,
    }),
  );

const lead = async (team: string, name: string | null) =>
  assert.ok(
    await stack.teams.assignLead(await stack.freshRoot(), {
      teamId: teams[team]!,
      employeeId: name === null ? null : employeeOf(name),
    }),
  );

let cursor = 1;

/** One unused Monday–Friday business date after today. */
async function day(): Promise<string> {
  for (;;) {
    const date = await stack.day(cursor++);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return date;
  }
}

const wfh = async (teamId: string | null = null): Promise<SubmitRequestInput> => ({
  kind: 'wfh',
  teamId,
  reason: 'Làm tại nhà',
  dates: [await day()],
});

const late = async (): Promise<SubmitRequestInput> => ({
  kind: 'late-arrival',
  teamId: null,
  reason: 'Đưa con đi khám',
  date: await day(),
  expectedMinute: 600,
});

async function submit(name: string, input: SubmitRequestInput | Promise<SubmitRequestInput>) {
  const created = await stack.workRequests.submit(p(name).secret, randomUUID(), await input);
  assert.ok(created);
  return created;
}

const input = (
  request: SubmitResult | string | undefined,
  decision: 'approve' | 'reject',
  options: { version?: string; key?: string; reason?: string | null; ack?: boolean } = {},
): ApprovalInput => {
  // A previous step's result: undefined means that step already failed its own assertion.
  if (request === undefined) throw new Error('No request to decide');
  return {
    requestId: typeof request === 'string' ? request : request.id,
    expectedVersion: options.version ?? (typeof request === 'string' ? '1' : request.version),
    idempotencyKey: options.key ?? randomUUID(),
    decision,
    reason:
      options.reason !== undefined ? options.reason : decision === 'reject' ? 'Thiếu người' : null,
    acknowledgeWfhLimit: options.ack ?? false,
  };
};

const decide = (
  name: string,
  request: SubmitResult | string | undefined,
  decision: 'approve' | 'reject',
  options: { version?: string; key?: string; reason?: string | null; ack?: boolean } = {},
) => stack.approvals.decide(p(name).secret, input(request, decision, options));

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof ApiRejection && error.code === code && error.status === status;

const revoke = (name: string, role: string) =>
  stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `DELETE FROM user_role WHERE user_id = $1 AND role_key = convert_to($2,'UTF8')`,
      [p(name).id, role],
    ),
  );

const grantRole = (name: string, role: string) =>
  stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `INSERT INTO user_role(user_id, role_key) VALUES ($1, convert_to($2,'UTF8'))`,
      [p(name).id, role],
    ),
  );

before(async () => {
  // No effect handler registered: the fail-closed gate (spec §6.3 invariant 5). The production
  // composition, where every kind is open, is tested in hrm-attendance*.integration-spec.ts.
  stack = await startHrStack({ effects: {} });
  for (const name of ['E1', 'E2', 'E3', 'E5', 'L1', 'L2', 'L3', 'M4', 'X'])
    await hire(name, ['hr.employee']);
  await hire('C', ['hr.employee', 'hr.coo']);
  await hire('LC', ['hr.employee', 'hr.coo']);
  await hire('H', ['hr.employee', 'hr.admin']);
  people.N = await stack.person([]);
  for (const name of ['T1', 'T2', 'T4', 'T5'])
    teams[name] = (await stack.teams.create(await stack.freshRoot(), { name })).id;
  for (const name of ['E1', 'E2', 'E3', 'L1', 'L3']) await member('T1', name, true);
  for (const name of ['L2', 'C', 'X']) await member('T2', name, true);
  await member('T2', 'E3', false);
  await member('T4', 'LC', true);
  await member('T4', 'M4', true);
  await member('T5', 'E5', true);
  await member('T1', 'H', true);
  await lead('T1', 'L1');
  await lead('T2', 'L2');
  await lead('T4', 'LC');
});

after(() => stack?.stop());

test('C-01: the current lead approves a WFH request → pending_final v2, one lead decision, claim and an ids-only audit; the queues move', async () => {
  const request = await submit('E1', wfh());
  const queue = await stack.approvals.leadQueue(p('L1').secret, { limit: 100, offset: 0 });
  assert.ok(
    queue.items.some((item) => item.id === request.id && item.employeeId === employeeOf('E1')),
  );
  const before = await snapshot(request.id);
  const result = await decide('L1', request, 'approve', { reason: 'Đồng ý' });
  assert.deepEqual(result, { id: request.id, state: 'pending_final', version: '2' });
  assert.deepEqual(await snapshot(request.id), {
    row: { state: 'pending_final', version: '2' },
    decisions: before.decisions + 1,
    claims: before.claims + 1,
    audits: before.audits + 1,
  });
  const [decision] = await stack.migration.query<Record<string, string | null>[]>(
    `SELECT stage, decision, actor_kind AS kind, actor_account_id::text AS actor, reason
       FROM request_decision WHERE request_id = $1`,
    [request.id],
  );
  assert.deepEqual(decision, {
    stage: 'lead',
    decision: 'approve',
    kind: 'user',
    actor: p('L1').id,
    reason: 'Đồng ý',
  });
  const [audit] = await stack.migration.query<{ payload: string }[]>(
    `SELECT row_to_json(a)::text AS payload FROM audit_outbox a
      WHERE convert_from(event_kind,'UTF8') = 'hr.request.decide-lead' ORDER BY occurred_at DESC LIMIT 1`,
  );
  assert.ok(audit?.payload.includes(request.id));
  for (const secret of ['Đồng ý', 'Làm tại nhà', 'wfh'])
    assert.ok(!audit?.payload.includes(secret));
  // History (C-20): the owner sees the decision with its reason; the lead still reads it.
  const detail = await stack.workRequests.detail(p('E1').secret, request.id);
  assert.deepEqual(
    detail?.decisions.map((d) => ({ ...d, decidedAt: typeof d.decidedAt })),
    [
      {
        stage: 'lead',
        decision: 'approve',
        actorKind: 'user',
        systemReason: null,
        reason: 'Đồng ý',
        decidedAt: 'string',
      },
    ],
  );
  assert.equal(
    (await stack.workRequests.detail(p('L1').secret, request.id))?.state,
    'pending_final',
  );
  assert.ok(
    !(await stack.approvals.leadQueue(p('L1').secret, { limit: 100, offset: 0 })).items.some(
      (item) => item.id === request.id,
    ),
  );
  assert.ok(
    (await stack.approvals.finalQueue(p('C').secret, { limit: 100, offset: 0 })).items.some(
      (item) => item.id === request.id,
    ),
  );
});

test('C-02, C-03, C-06, C-15: COO before the lead, another team’s lead, the CEO and a role-less caller get not found; Root cannot skip the lead step', async () => {
  const request = await submit('E1', wfh());
  const before = await snapshot(request.id);
  for (const name of ['C', 'L2', 'X', 'N', 'E2', 'H'])
    for (const decision of ['approve', 'reject'] as const)
      assert.equal(await decide(name, request, decision), undefined, `${name} ${decision}`);
  // Even naming the final command directly: the COO's plan (stage pending_final) misses the row.
  const direct = { ...input(request, 'approve'), hash: '0'.repeat(64) };
  assert.equal(
    await stack.authorization.execute(p('C').secret, stack.finalDecision, direct),
    undefined,
  );
  // C-15: Root passes authorization, but a final decision on pending_lead is no transition, and
  // Root is never the current first-step approver.
  await assert.rejects(
    stack.authorization.execute(await stack.root(), stack.finalDecision, direct),
    rejected('invalid_transition'),
  );
  await assert.rejects(
    stack.approvals.decide(await stack.root(), input(request, 'approve')),
    ProductAccessDenied,
  );
  assert.deepEqual(await snapshot(request.id), before);
  for (const name of ['C', 'X', 'N', 'H'])
    assert.ok(
      !(await stack.approvals.leadQueue(p(name).secret, { limit: 100, offset: 0 })).items.some(
        (item) => item.id === request.id,
      ),
    );
  assert.equal(
    (await stack.approvals.leadQueue(await stack.root(), { limit: 100, offset: 0 })).total,
    '0',
  );
  assert.deepEqual(await stack.approvals.finalQueue(p('X').secret, { limit: 20, offset: 0 }), {
    items: [],
    total: '0',
  });
});

test('C-04, C-05, C-14: a lead cannot decide the final stage; rejected is terminal; a stale version is a conflict', async () => {
  const request = await submit('E2', wfh());
  await assert.rejects(
    decide('L1', request, 'approve', { version: '2' }),
    rejected('stale_version'),
  );
  const moved = await decide('L1', request, 'approve');
  assert.equal(moved?.state, 'pending_final');
  // The lead holds no decideFinal grant: the final stage is not theirs (same as absent).
  assert.equal(await decide('L1', moved, 'approve'), undefined);
  const other = await submit('E2', wfh());
  const done = await decide('L1', other, 'reject', { reason: 'Thiếu người trực' });
  assert.deepEqual(done, { id: other.id, state: 'rejected', version: '2' });
  const before = await snapshot(other.id);
  for (const decision of ['approve', 'reject'] as const)
    await assert.rejects(decide('L1', done, decision), rejected('invalid_transition'));
  // The COO never read it (not in the final queue, never decided): not found.
  assert.equal(await decide('C', done, 'approve'), undefined);
  assert.deepEqual(await snapshot(other.id), before);
});

test('C-17, C-30 gate: the COO (and Root) final approval is refused before M3 with nothing written; final reject works', async () => {
  const request = await submit('E2', wfh());
  const moved = await decide('L1', request, 'approve');
  const before = await snapshot(request.id);
  await assert.rejects(decide('C', moved, 'approve'), rejected('final_approval_unavailable'));
  assert.deepEqual(await snapshot(request.id), before);
  const done = await decide('C', moved, 'reject', { reason: 'Không đủ người' });
  assert.deepEqual(done, { id: request.id, state: 'rejected', version: '3' });
  assert.deepEqual(
    await stack.migration.query(
      `SELECT stage, decision, actor_account_id::text AS actor FROM request_decision
        WHERE request_id = $1 ORDER BY decided_at, stage`,
      [request.id],
    ),
    [
      { stage: 'lead', decision: 'approve', actor: p('L1').id },
      { stage: 'final', decision: 'reject', actor: p('C').id },
    ],
  );
  // Root (no step-up: decide has no fresh@1, C-16) passes authorization; the guards still hold.
  const third = await decide('L1', await submit('E2', wfh()), 'approve');
  await assert.rejects(
    stack.approvals.decide(await stack.root(), input(third, 'approve')),
    rejected('final_approval_unavailable'),
  );
  assert.equal(
    (await stack.approvals.decide(await stack.root(), input(third, 'reject')))?.state,
    'rejected',
  );
});

test('late/early only need the lead (§6.4.1): the lead approval is final and refused before M3; lead reject works; a lead’s own late request still goes to the COO', async () => {
  const request = await submit('E1', late());
  assert.equal(request.state, 'pending_lead');
  const before = await snapshot(request.id);
  await assert.rejects(decide('L1', request, 'approve'), rejected('final_approval_unavailable'));
  assert.deepEqual(await snapshot(request.id), before);
  assert.deepEqual(await decide('L1', request, 'reject'), {
    id: request.id,
    state: 'rejected',
    version: '2',
  });
  // §6.4.1 assumption [P]: L1's own late request skipped the lead step; the COO decides it.
  const own = await submit('L1', late());
  assert.equal(own.state, 'pending_final');
  await assert.rejects(decide('C', own, 'approve'), rejected('final_approval_unavailable'));
  assert.equal((await decide('C', own, 'reject'))?.state, 'rejected');
});

test('self approval and holding two roles (D01, C-09): no one decides their own request; lead + COO decides both stages in two steps', async () => {
  const request = await submit('E2', wfh());
  // E2 becomes the lead of T1: now the current first-step approver of their own request.
  await lead('T1', 'E2');
  try {
    const before = await snapshot(request.id);
    await assert.rejects(decide('E2', request, 'approve'), ProductAccessDenied);
    await assert.rejects(decide('E2', request, 'reject'), ProductAccessDenied);
    // C-11: the former lead lost the step at once.
    assert.equal(await decide('L1', request, 'approve'), undefined);
    assert.deepEqual(await snapshot(request.id), before);
    assert.ok(
      !(await stack.approvals.leadQueue(p('E2').secret, { limit: 100, offset: 0 })).items.some(
        (item) => item.id === request.id,
      ),
    );
  } finally {
    await lead('T1', 'L1');
  }
  // C-09: LC leads T4 and holds hr.coo; two operations, two decisions by the same actor.
  const first = await submit('M4', wfh());
  const step = await decide('LC', first, 'approve');
  assert.equal(step?.state, 'pending_final');
  await assert.rejects(decide('LC', step, 'approve'), rejected('final_approval_unavailable'));
  assert.equal((await decide('LC', step, 'reject'))?.state, 'rejected');
  assert.equal(
    await count(
      'SELECT count(DISTINCT stage)::text AS n FROM request_decision WHERE request_id = $1 AND actor_account_id = $2',
      [first.id, p('LC').id],
    ),
    2,
  );
  // The employee's own request stays theirs after HR moves their profile to another account.
  await hire('E6', ['hr.employee']);
  await member('T1', 'E6', true);
  const before6 = await submit('E6', wfh());
  people.A6 = await stack.person(['hr.employee']);
  assert.ok(
    await stack.employees.linkAccount(await stack.freshRoot(), {
      employeeId: employeeOf('E6'),
      expectedVersion: await versionOf(employeeOf('E6')),
      accountId: p('A6').id,
    }),
  );
  await lead('T1', 'E6');
  try {
    await assert.rejects(decide('A6', before6, 'approve'), ProductAccessDenied);
  } finally {
    await lead('T1', 'L1');
  }
  // A lead who later holds hr.coo still cannot final-decide their own pending_final request.
  const own = await submit('L1', wfh());
  await grantRole('L1', 'hr.coo');
  try {
    await assert.rejects(decide('L1', own, 'reject'), ProductAccessDenied);
    assert.ok(
      !(await stack.approvals.finalQueue(p('L1').secret, { limit: 100, offset: 0 })).items.some(
        (item) => item.id === own.id,
      ),
    );
  } finally {
    await revoke('L1', 'hr.coo');
  }
});

test('C-10: a team without a lead: the request waits, nobody can decide it (no CEO, HR or Root fallback)', async () => {
  const request = await submit('E5', wfh());
  assert.equal(request.state, 'pending_lead');
  const before = await snapshot(request.id);
  for (const name of ['H', 'C', 'X', 'L1', 'E5'])
    assert.equal(await decide(name, request, 'approve'), undefined, name);
  await assert.rejects(
    stack.approvals.decide(await stack.root(), input(request, 'approve')),
    ProductAccessDenied,
  );
  assert.deepEqual(await snapshot(request.id), before);
});

test('C-11, C-21, C-24: the approver is the current lead of the request’s team, or of the primary team after leaving it', async () => {
  const onT2 = await submit('E3', wfh(teams.T2));
  assert.equal(await decide('L1', onT2, 'approve'), undefined);
  const onT2b = await submit('E3', wfh(teams.T2));
  assert.equal((await decide('L2', onT2b, 'approve'))?.state, 'pending_final');
  // E3 leaves T2: the first step moves to the lead of the primary team T1.
  assert.ok(
    await stack.teams.endMembership(await stack.freshRoot(), {
      teamId: teams.T2!,
      employeeId: employeeOf('E3'),
    }),
  );
  assert.equal(await decide('L2', onT2, 'approve'), undefined);
  assert.equal((await decide('L1', onT2, 'approve'))?.state, 'pending_final');
  // C-11: the lead of T1 changes to L3 while a request waits.
  const waiting = await submit('E1', wfh());
  await lead('T1', 'L3');
  try {
    assert.equal(await decide('L1', waiting, 'approve'), undefined);
    assert.equal((await decide('L3', waiting, 'approve'))?.state, 'pending_final');
  } finally {
    await lead('T1', 'L1');
  }
});

test('idempotency: same key + payload replays after the state moved on; another payload or request is refused; a revoked actor gets not found (C-19)', async () => {
  const request = await submit('E1', wfh());
  const key = randomUUID();
  const first = await decide('L1', request, 'approve', { key });
  const before = await snapshot(request.id);
  assert.deepEqual(await decide('L1', request, 'approve', { key }), first);
  assert.deepEqual(await snapshot(request.id), before);
  await assert.rejects(
    decide('L1', request, 'approve', { key, reason: 'Khác' }),
    refused('error.idempotencyKeyReused', 422),
  );
  await assert.rejects(
    decide('L1', request, 'reject', { key }),
    refused('error.idempotencyKeyReused', 422),
  );
  const other = await submit('E2', wfh());
  await assert.rejects(
    decide('L1', other, 'approve', { key }),
    refused('error.idempotencyKeyReused', 422),
  );
  assert.equal((await snapshot(other.id)).row?.state, 'pending_lead');
  // Keys are per actor: another approver's key space is separate.
  assert.equal((await decide('L1', other, 'approve'))?.state, 'pending_final');
  await revoke('L1', 'hr.employee');
  try {
    assert.equal(await decide('L1', request, 'approve', { key }), undefined);
  } finally {
    await grantRole('L1', 'hr.employee');
  }
  const claims = (await snapshot(request.id)).claims;
  assert.deepEqual(await decide('L1', request, 'approve', { key }), first);
  // Only `other` was decided meanwhile: this request and the claim count did not move.
  assert.deepEqual(await snapshot(request.id), { ...before, claims, audits: before.audits + 1 });
});

/**
 * Barrier for two decisions on two pool connections: a superuser transaction holds the request
 * row FOR UPDATE, which each decision's plan-matching statement needs FOR NO KEY UPDATE. Released
 * only once both data-login backends wait on a lock, inside the runner's 1 s lock timeout.
 */
async function raced<T>(
  requestIds: string | readonly string[],
  attempts: () => readonly Promise<T>[],
): Promise<PromiseSettledResult<T>[]> {
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM work_request WHERE id = ANY($1::uuid[]) FOR UPDATE', [
      [requestIds].flat(),
    ]);
    const settled = Promise.allSettled(attempts());
    for (let waited = 0; ; waited += 5) {
      const { rows } = await watcher.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'product_data' AND state = 'active' AND wait_event_type = 'Lock'`,
      );
      if (rows[0]?.n === '2') break;
      if (waited > 800) {
        await blocker.query('ROLLBACK');
        await settled;
        throw new Error('Barrier not reached: the two decisions were never in flight together');
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

test('C-13 races on two connections: approve/approve and approve/reject leave exactly one decision; one key twice replays', async () => {
  for (const second of ['approve', 'reject'] as const) {
    const request = await submit('E1', wfh());
    const results = await raced(request.id, () => [
      decide('L1', request, 'approve'),
      decide('L1', request, second),
    ]);
    const done = results.filter((r) => r.status === 'fulfilled');
    assert.equal(done.length, 1, second);
    const failed = results.find((r) => r.status === 'rejected');
    assert.ok(failed && rejected('stale_version')(failed.reason), second);
    const after = await snapshot(request.id);
    assert.equal(after.decisions, 1);
    assert.equal(after.row?.version, '2');
  }
  const request = await submit('E1', wfh());
  const key = randomUUID();
  const [one, two] = await raced(request.id, () => [
    decide('L1', request, 'approve', { key }),
    decide('L1', request, 'approve', { key }),
  ]);
  assert.ok(one?.status === 'fulfilled' && two?.status === 'fulfilled');
  assert.deepEqual(one.value, two.value);
  assert.equal((await snapshot(request.id)).decisions, 1);
  // One key on two requests at once: the request locks do not serialize them, the claim does.
  const [a, b] = [await submit('E1', wfh()), await submit('E2', wfh())];
  const reused = randomUUID();
  const both = await raced([a.id, b.id], () => [
    decide('L1', a, 'approve', { key: reused }),
    decide('L1', b, 'approve', { key: reused }),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = both.find((r) => r.status === 'rejected');
  assert.ok(lost && refused('error.idempotencyKeyReused', 422)(lost.reason));
  assert.equal(
    (await snapshot(a.id)).decisions + (await snapshot(b.id)).decisions,
    1,
    'the refused decision rolled back',
  );
});

test('audit writer failure rolls back the decision, the transition and the claim', async () => {
  const request = await submit('E2', wfh());
  const before = await snapshot(request.id);
  const key = randomUUID();
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      decide('L1', request, 'approve', { key }),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual(await snapshot(request.id), before);
  assert.equal((await decide('L1', request, 'approve', { key }))?.state, 'pending_final');
});

test('menu `approvals` (display only) follows the approval right, not waiting requests: a current Team Lead, the COO, Root', async () => {
  const menus = async (secret: string) => (await stack.employees.me(secret)).menus;

  const waitingFor = (name: string) =>
    count(
      `SELECT count(*)::text AS n FROM work_request r JOIN hr_request_lead l ON l.request_id = r.id
        WHERE l.lead_account_id = $1`,
      [p(name).id],
    );

  // A new lead of a team nobody ever filed a request for: the right comes from the assignment.
  await hire('L9', ['hr.employee']);
  await hire('E9', ['hr.employee']);
  teams.T9 = (await stack.teams.create(await stack.freshRoot(), { name: 'T9' })).id;
  await member('T9', 'L9', true);
  await member('T9', 'E9', true);
  await lead('T9', 'L9');
  assert.equal(await waitingFor('L9'), 0);
  for (const name of ['L1', 'L2', 'L9', 'LC', 'C'])
    assert.ok((await menus(p(name).secret)).includes('approvals'), name);
  // hr.coo alone (no profile, no team) holds the final step.
  people.C2 = await stack.person(['hr.coo']);
  assert.ok((await menus(p('C2').secret)).includes('approvals'));
  assert.ok((await menus(await stack.root())).includes('approvals'));
  // Members without a led team, the CEO, HR/Admin and a role-less account get no approvals menu.
  for (const name of ['E1', 'E5', 'E9', 'M4', 'X', 'H', 'N'])
    assert.ok(!(await menus(p(name).secret)).includes('approvals'), name);
  assert.deepEqual(await menus(p('N').secret), []);
  // The assignment ends: the menu goes in the next transaction.
  await lead('T9', null);
  assert.ok(!(await menus(p('L9').secret)).includes('approvals'));
  await revoke('C2', 'hr.coo');
  assert.ok(!(await menus(p('C2').secret)).includes('approvals'));
});

test('history `decided`: requests decided in the caller’s approval scope — the lead’s teams (COO decisions included), everything for the COO and Root; scoped and paged before the count, latest decision first, no reason', async () => {
  // a: E1 (T1) lead-approved by L1, rejected by the COO. b: E2 (T1) rejected by L1.
  // c: X (T2) approved by L2 (still pending_final). d: E1 waiting (no decision).
  // own: L1's own request (lead step skipped) rejected by the COO.
  const a = await submit('E1', wfh());
  const forwarded = await decide('L1', a, 'approve');
  assert.equal(
    (await decide('C', forwarded, 'reject', { reason: 'Lý do COO bí mật' }))?.state,
    'rejected',
  );
  const b = await submit('E2', wfh());
  const bKey = randomUUID();
  await decide('L1', b, 'reject', { reason: 'Lý do lead bí mật', key: bKey });
  const c = await submit('X', wfh());
  assert.equal((await decide('L2', c, 'approve'))?.state, 'pending_final');
  const d = await submit('E1', wfh());
  const own = await submit('L1', wfh());
  await decide('C', own, 'reject');

  const all = (secret: string) => stack.approvals.decided(secret, { limit: 100, offset: 0 });

  const ids = async (secret: string) => (await all(secret)).items.map((item) => item.id);

  const decidedScope = `(r.state IN ('approved','rejected') OR EXISTS (SELECT 1 FROM request_decision d
      WHERE d.request_id = r.id AND d.actor_kind = 'user' AND d.stage IN ('lead','final')))`;

  const l1 = await all(p('L1').secret);
  const byId = new Map(l1.items.map((item) => [item.id, item]));
  assert.ok(byId.has(a.id) && byId.has(b.id));
  for (const hidden of [c.id, d.id, own.id]) assert.ok(!byId.has(hidden), hidden);
  assert.equal(byId.get(a.id)?.state, 'rejected');
  assert.deepEqual(
    { ...byId.get(a.id)?.decision, decidedAt: typeof byId.get(a.id)?.decision.decidedAt },
    { stage: 'final', decision: 'reject', actorKind: 'user', decidedAt: 'string' },
  );
  assert.deepEqual(
    { ...byId.get(b.id)?.decision, decidedAt: undefined },
    { stage: 'lead', decision: 'reject', actorKind: 'user', decidedAt: undefined },
  );
  assert.equal(
    l1.total,
    String(
      await count(
        `SELECT count(*)::text AS n FROM work_request r JOIN hr_request_lead l ON l.request_id = r.id
          WHERE l.lead_account_id = $1 AND r.owner_account_id <> $1 AND ${decidedScope}`,
        [p('L1').id],
      ),
    ),
  );
  // Projection allowlist: no reason (the queues return none either), no actor id.
  assert.deepEqual(Object.keys(l1.items[0]!).sort(), [
    'createdAt',
    'decision',
    'employeeId',
    'employeeName',
    'endDate',
    'id',
    'kind',
    'minutes',
    'startDate',
    'state',
    'teamId',
    'version',
  ]);

  // The owner's full name only, from the employee row of the request (never another field).
  const nameOf = async (employeeId: string) =>
    (
      await stack.migration.query<{ full_name: string }[]>(
        'SELECT full_name FROM employee WHERE id = $1',
        [employeeId],
      )
    )[0]?.full_name;

  assert.equal(byId.get(a.id)?.employeeName, await nameOf(employeeOf('E1')));
  assert.equal(byId.get(b.id)?.employeeName, await nameOf(employeeOf('E2')));
  const text = JSON.stringify(l1);
  for (const secret of ['bí mật', 'Làm tại nhà', p('L1').id, p('C').id])
    assert.ok(!text.includes(secret), secret);
  // Leak: only rows the caller may read carry a name; another team's owner is nowhere in it.
  assert.ok(!text.includes((await nameOf(employeeOf('X'))) ?? '?'));
  const [{ code } = { code: '?' }] = await stack.migration.query<{ code: string }[]>(
    'SELECT code FROM employee WHERE id = $1',
    [employeeOf('E1')],
  );
  assert.ok(!text.includes(code), 'no employee code');
  const cooItems = new Map((await all(p('C').secret)).items.map((item) => [item.id, item]));
  assert.equal(cooItems.get(c.id)?.employeeName, await nameOf(employeeOf('X')));
  for (const name of ['E1', 'E2', 'X', 'H', 'N'])
    assert.ok(
      !JSON.stringify(await all(p(name).secret)).includes('employeeName'),
      `${name} has no history, so no name`,
    );
  // Latest decision first, ties by id: a stable order the pages split without gaps or repeats.
  const order = l1.items.map((item) => `${item.decision.decidedAt} ${item.id}`);
  assert.deepEqual(
    order,
    [...order].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0)),
  );
  assert.equal(l1.items[0]?.id, b.id);
  const pages = [];
  for (let offset = 0; offset < l1.items.length; offset++) {
    const page = await stack.approvals.decided(p('L1').secret, { limit: 1, offset });
    assert.equal(page.total, l1.total);
    pages.push(...page.items);
  }
  assert.deepEqual(pages, l1.items);

  // Another team's lead sees their own team only.
  const l2 = await ids(p('L2').secret);
  assert.ok(l2.includes(c.id));
  for (const hidden of [a.id, b.id, d.id]) assert.ok(!l2.includes(hidden), hidden);
  // The COO sees every decided request but their own; Root sees all of them.
  const coo = await all(p('C').secret);
  for (const id of [a.id, b.id, c.id, own.id])
    assert.ok(
      coo.items.some((item) => item.id === id),
      id,
    );
  assert.ok(!coo.items.some((item) => item.id === d.id));
  assert.equal(
    coo.total,
    String(
      await count(
        `SELECT count(*)::text AS n FROM work_request r WHERE r.owner_account_id <> $1 AND ${decidedScope}`,
        [p('C').id],
      ),
    ),
  );
  const root = await stack.approvals.decided(await stack.root(), { limit: 100, offset: 0 });
  assert.equal(
    root.total,
    String(await count(`SELECT count(*)::text AS n FROM work_request r WHERE ${decidedScope}`)),
  );
  assert.ok(!root.items.some((item) => item.id === d.id));
  // No approval right: an empty page (the plan reaches nothing), never another's history.
  for (const name of ['E1', 'E2', 'X', 'H', 'N'])
    assert.deepEqual(
      await stack.approvals.decided(p(name).secret, { limit: 20, offset: 0 }),
      { items: [], total: '0' },
      name,
    );
  // The lead changes: the history follows the current assignment in the next transaction.
  await lead('T1', 'L3');
  try {
    const l3 = await ids(p('L3').secret);
    assert.ok(l3.includes(a.id) && l3.includes(b.id));
    const former = await ids(p('L1').secret);
    assert.ok(!former.includes(a.id) && !former.includes(b.id));
    // C-19: a replay rechecks only workRequest.read; L1 still reads b as its decider.
    assert.deepEqual(await decide('L1', b, 'reject', { reason: 'Lý do lead bí mật', key: bKey }), {
      id: b.id,
      state: 'rejected',
      version: '2',
    });
  } finally {
    await lead('T1', 'L1');
  }
});

test('release 9: the COO reads (only) a lead’s request rejected at the lead step; ordinary owners, other states and other callers stay 404; no decision right', async () => {
  // L3 (member of T1, led by L1) also leads T5: a lead's own request goes through L1 (pending_lead).
  await lead('T5', 'L3');
  let leads = true;
  try {
    const own = await submit('L3', wfh(teams.T1));
    const ordinary = await submit('E2', wfh());

    const detail = (name: string, id: string) => stack.workRequests.detail(p(name).secret, id);

    // Waiting at the lead step: the COO reads neither (not in the final queue, never decided).
    assert.equal(await detail('C', own.id), undefined);
    assert.equal(await detail('C', ordinary.id), undefined);
    const closed = await decide('L1', own, 'reject', { reason: 'Thiếu người trực' });
    assert.equal(closed?.state, 'rejected');
    await decide('L1', ordinary, 'reject', { reason: 'Thiếu người trực' });
    const before = await snapshot(own.id);
    const read = await detail('C', own.id);
    assert.equal(read?.id, own.id);
    assert.equal(read?.state, 'rejected');
    assert.equal(read?.decisions.length, 1);
    // A lead who is not the first-step approver, ordinary employees, HR and no-role callers: 404.
    for (const name of ['L2', 'E1', 'E2', 'X', 'N'])
      assert.equal(await detail(name, own.id), undefined, name);
    // The ordinary owner's request rejected by the same lead stays hidden from the COO.
    assert.equal(await detail('C', ordinary.id), undefined);
    // Read only: nothing in a queue, no decision of any stage, and nothing written.
    const queued = [
      ...(await stack.approvals.leadQueue(p('C').secret, { limit: 100, offset: 0 })).items,
      ...(await stack.approvals.finalQueue(p('C').secret, { limit: 100, offset: 0 })).items,
    ];
    assert.ok(!queued.some((item) => item.id === own.id));
    // Deciding needs the stage's permission; the read-only action does not open the decision
    // path either (the decision facts run under workRequest.read): not found, nothing written.
    assert.equal(await decide('C', closed, 'approve'), undefined);
    assert.equal(await decide('C', closed, 'reject'), undefined);
    assert.deepEqual(await snapshot(own.id), before);
    // Root reads everything.
    assert.equal((await stack.workRequests.detail(await stack.root(), own.id))?.id, own.id);
    // The scope follows the current assignment: once L3 leads nothing the COO loses the read.
    await lead('T5', null);
    leads = false;
    assert.equal(await detail('C', own.id), undefined);
  } finally {
    if (leads) await lead('T5', null);
  }
});

test('queues: scoped and paged before the count; employee ids only; ACL and CHECKs on decisions', async () => {
  const mine = await stack.approvals.leadQueue(p('L1').secret, { limit: 100, offset: 0 });
  const pending = await count(
    `SELECT count(*)::text AS n FROM work_request r JOIN hr_request_lead l ON l.request_id = r.id
      WHERE r.state = 'pending_lead' AND l.lead_account_id = $1`,
    [p('L1').id],
  );
  assert.ok(pending >= 1);
  assert.equal(mine.total, String(pending));
  const page = await stack.approvals.leadQueue(p('L1').secret, { limit: 1, offset: 0 });
  assert.equal(page.total, mine.total);
  assert.deepEqual(page.items, mine.items.slice(0, 1));
  assert.deepEqual(Object.keys(mine.items[0]!).sort(), [
    'createdAt',
    'employeeId',
    'endDate',
    'id',
    'kind',
    'minutes',
    'startDate',
    'state',
    'teamId',
    'version',
  ]);
  assert.ok(mine.items.every((item) => item.state === 'pending_lead'));
  const final = await stack.approvals.finalQueue(p('C').secret, { limit: 100, offset: 0 });
  assert.ok(final.items.every((item) => item.state === 'pending_final'));

  const [row] = await stack.migration.query<{ id: string }[]>(
    'SELECT id::text AS id FROM request_decision LIMIT 1',
  );
  for (const statement of [
    `UPDATE request_decision SET reason = 'x' WHERE id = '${row!.id}'`,
    `DELETE FROM request_decision WHERE id = '${row!.id}'`,
    `DELETE FROM hr_idempotency`,
  ])
    assert.equal(await sqlState(stack.pools.data.query(statement)), '42501', statement);
  const request = await submit('E1', wfh());
  // D08 in the schema: a user reject without reason, an empty reason.
  for (const reason of [null, ''])
    assert.equal(
      await sqlState(
        stack.migration.query(
          `INSERT INTO request_decision(id,request_id,stage,decision,actor_kind,actor_account_id,reason)
           VALUES ($1,$2,'lead','reject','user',$3,$4)`,
          [randomUUID(), request.id, p('L1').id, reason],
        ),
      ),
      '23514',
    );
});
