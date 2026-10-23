import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DataSource } from 'typeorm';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { ProductAuthenticationError } from '../dist/authentication/services/product-identity.service.js';
import { sessionDigest } from '../dist/authentication/services/product-identity.service.js';
import { withClient } from './setup-postgres.ts';
import { type HrPerson, type HrStack, startHrStack } from './hrm-stack.helper.ts';

// permitsMany (ADR 0017 addendum): one transaction, one session, one fence for the menu probes,
// each answer identical to the single `permits` of the same pair.

let stack: HrStack;
let sequence = 0;

const utf8 = (value: string) => Buffer.from(value, 'utf8');

/** The menu probes of GET /api/auth/me and the company hint of GET /api/hr/employees/me, plus pairs that must fail closed. */
const reportActionNames = [
  'reportAttendance',
  'reportLateEarly',
  'reportSeniority',
  'reportLeave',
  'reportWfh',
  'reportBirthday',
];
const probes = [
  { resource: 'team', action: 'read' },
  { resource: 'hrCompany', action: 'read' },
  { resource: 'workCalendar', action: 'read' },
  { resource: 'employee', action: 'submitRequest' },
  { resource: 'team', action: 'approvals' },
  { resource: 'hrCompany', action: 'approvals' },
  { resource: 'employee', action: 'readLeaveBalance' },
  { resource: 'employee', action: 'readAttendance' },
  { resource: 'employee', action: 'read' },
  { resource: 'account', action: 'read' },
  ...reportActionNames.map((action) => ({ resource: 'employee', action })),
];
const failClosed = [
  { resource: 'employee', action: 'noSuchAction' },
  { resource: 'noSuchResource', action: 'read' },
];

async function hire(roles: readonly string[]): Promise<HrPerson & { employee: string }> {
  const person = await stack.person(roles);
  const { id } = await stack.employees.create(await stack.freshRoot(), {
    code: `P${String(++sequence).padStart(3, '0')}`,
    fullName: `Nhân viên thử ${sequence}`,
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
  const [row] = await stack.migration.query<{ version: string }[]>(
    'SELECT version::text AS version FROM employee WHERE id=$1',
    [id],
  );
  assert.ok(
    await stack.employees.linkAccount(await stack.freshRoot(), {
      employeeId: id,
      expectedVersion: row!.version,
      accountId: person.id,
    }),
  );
  return { ...person, employee: id };
}

before(async () => {
  stack = await startHrStack();
});
after(async () => {
  await stack?.stop();
});

/** Counts pool checkouts and resolve_session statements while `work` runs. */
async function counted<T>(work: () => Promise<T>) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally; called with `this`.
  const original = DataSource.prototype.createQueryRunner;
  const seen = { transactions: 0, sessions: 0, fences: 0 };
  DataSource.prototype.createQueryRunner = function (this: DataSource, ...args) {
    seen.transactions++;
    const runner = original.apply(this, args);
    const query = runner.query.bind(runner);
    runner.query = (sql: string, params?: unknown[]) => {
      if (/resolve_session/.test(sql)) seen.sessions++;
      if (/authz_acquire_shared_fence/.test(sql)) seen.fences++;
      return query(sql, params);
    };
    return runner;
  };
  try {
    return { result: await work(), seen };
  } finally {
    DataSource.prototype.createQueryRunner = original;
  }
}

async function single(secret: string, pairs: typeof probes) {
  const answers: boolean[] = [];
  for (const { resource, action } of pairs)
    answers.push(await stack.authorization.permits(secret, resource, action));
  return answers;
}

test('permitsMany answers every pair exactly like permits, for every kind of caller', async () => {
  const linked = await hire(['hr.employee']);
  const unlinked = await stack.person(['hr.employee']);
  const hr = await hire(['hr.employee', 'hr.admin']);
  const coo = await hire(['hr.employee', 'hr.coo']);
  const roleless = await stack.person([]);
  const lead = await hire(['hr.employee']);
  const team = (await stack.teams.create(await stack.freshRoot(), { name: 'Nhóm thử' })).id;
  assert.ok(
    await stack.teams.addMember(await stack.freshRoot(), {
      teamId: team,
      employeeId: lead.employee,
      primary: true,
    }),
  );
  assert.ok(
    await stack.teams.assignLead(await stack.freshRoot(), {
      teamId: team,
      employeeId: lead.employee,
    }),
  );
  const callers: [string, string][] = [
    ['linked employee', linked.secret],
    ['unlinked employee', unlinked.secret],
    ['lead', lead.secret],
    ['hr', hr.secret],
    ['coo', coo.secret],
    ['root', await stack.root()],
    ['no role', roleless.secret],
  ];
  const all = [...probes, ...failClosed];
  const grants = new Set<string>();
  for (const [name, secret] of callers) {
    const expected = await single(secret, all);
    // Two batches (the limit is 16); the answers concatenate to one per pair.
    const merged = [
      ...(await stack.authorization.permitsMany(secret, all.slice(0, 9))),
      ...(await stack.authorization.permitsMany(secret, all.slice(9))),
    ];
    assert.deepEqual(merged, expected, name);
    expected.forEach((answer, index) => answer && grants.add(`${name}:${index}`));
    // Unknown actions/resources never open, whoever asks (Root included: Root needs a declared action).
    assert.deepEqual(merged.slice(-failClosed.length), [false, false], `${name} fail closed`);
  }
  // The comparison is not vacuous: some callers hold grants and some probes are denied.
  assert.ok(grants.size > 10);
  assert.ok([...grants].some((entry) => entry.startsWith('hr:')));
});

test('permitsMany uses one transaction, one session resolution and one fence', async () => {
  const person = await stack.person(['hr.employee', 'hr.admin']);
  const before = await counted(() => single(person.secret, probes));
  const merged = await counted(() => stack.authorization.permitsMany(person.secret, probes));
  assert.deepEqual(merged.result, before.result);
  assert.deepEqual(merged.seen, { transactions: 1, sessions: 1, fences: 1 });
  assert.equal(before.seen.transactions, probes.length);
  assert.equal(before.seen.sessions, probes.length);
});

test('permitsMany bounds its input before any transaction starts', async () => {
  const person = await stack.person(['hr.employee']);
  const tooMany = Array.from({ length: 17 }, () => probes[0]!);
  for (const bad of [tooMany, [], [{ resource: 1, action: 'read' }], [null], 'x', undefined]) {
    const { seen } = await counted(() =>
      assert.rejects(
        stack.authorization.permitsMany(person.secret, bad as never),
        ProductInvalidRequest,
      ),
    );
    assert.equal(seen.transactions, 0);
  }
  // The limit itself is allowed.
  assert.equal(
    (await stack.authorization.permitsMany(person.secret, tooMany.slice(0, 16))).length,
    16,
  );
});

test('permitsMany refuses an unknown, revoked or expired session like permits', async () => {
  const revoked = await stack.person(['hr.employee', 'hr.admin']);
  const expired = await stack.person(['hr.employee', 'hr.admin']);
  const fine = await stack.authorization.permitsMany(revoked.secret, probes);
  assert.ok(fine.some(Boolean));
  await stack.runner.run('revoke', (tx) =>
    tx.manager.query(
      'UPDATE application_session SET revoked_at=statement_timestamp() WHERE token_hash=$1',
      [sessionDigest(revoked.secret)],
    ),
  );
  await stack.migration.query(
    `UPDATE application_session SET created_at=statement_timestamp() - interval '1 hour', authenticated_at=statement_timestamp() - interval '1 hour', reauthenticated_at=NULL, expires_at=statement_timestamp() - interval '1 second' WHERE token_hash=$1`,
    [sessionDigest(expired.secret)],
  );
  for (const secret of [revoked.secret, expired.secret, 'unknown-secret-value']) {
    await assert.rejects(
      stack.authorization.permits(secret, 'team', 'read'),
      ProductAuthenticationError,
    );
    await assert.rejects(
      stack.authorization.permitsMany(secret, probes),
      ProductAuthenticationError,
    );
  }
});

/** Polls until a backend is blocked on a lock inside the shared-fence statement (no fixed sleep). */
async function waitForFenceWaiter() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await withClient(stack.postgres.superuser, (client) =>
      client.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%authz_acquire_shared_fence%'`,
      ),
    );
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('permitsMany never blocked on the fence');
}

test('a role revoked while permitsMany waits at the fence never yields a stale allow', async () => {
  const person = await stack.person(['hr.employee', 'hr.admin']);
  const before = await stack.authorization.permitsMany(person.secret, probes);
  assert.ok(before.some(Boolean));
  let pending: Promise<boolean[]> | undefined;
  await stack.runner.run('admin', async (tx) => {
    await tx.manager.query('DELETE FROM user_role WHERE user_id=$1 AND role_key=$2', [
      person.id,
      utf8('hr.admin'),
    ]);
    // Blocked behind the exclusive fence until this transaction commits.
    pending = stack.authorization.permitsMany(person.secret, probes);
    await waitForFenceWaiter();
  });
  const after = await pending!;
  assert.deepEqual(after, await single(person.secret, probes));

  // hr.admin's company-scope grants are gone in every answer, not just some of them.
  const index = (resource: string, action: string) =>
    probes.findIndex((probe) => probe.resource === resource && probe.action === action);

  assert.equal(before[index('hrCompany', 'read')], true);
  assert.equal(after[index('hrCompany', 'read')], false);
  assert.equal(after[index('team', 'read')], false);
});

test('an any-of group answers the OR of its pairs, in order, and counts toward the limit', async () => {
  const coo = await stack.person(['hr.employee', 'hr.coo']);
  const lead = await stack.person(['hr.employee']);
  const group = [
    { resource: 'team', action: 'approvals' },
    { resource: 'hrCompany', action: 'approvals' },
  ];
  for (const person of [coo, lead, { secret: await stack.root() }]) {
    const [a, b] = await single(person.secret, group);
    assert.deepEqual(
      await stack.authorization.permitsMany(person.secret, [group, probes[0]!, group.slice(0, 1)]),
      [a || b, await stack.authorization.permits(person.secret, 'team', 'read'), a],
    );
  }
  const seven = Array.from({ length: 7 }, () => probes[0]!);
  // 2 + 7 + 7 pairs = 16 is allowed; one more pair or an empty group is not.
  assert.equal(
    (await stack.authorization.permitsMany(coo.secret, [group, seven, seven])).length,
    3,
  );
  await assert.rejects(
    stack.authorization.permitsMany(coo.secret, [group, seven, seven, probes[0]!]),
    ProductInvalidRequest,
  );
  await assert.rejects(stack.authorization.permitsMany(coo.secret, [[]]), ProductInvalidRequest);
});

/** Pauses the transaction for `ms` once, right after its first reachability probe (EXISTS). */
async function slowAfterFirstPair<T>(ms: number, work: () => Promise<T>) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally; called with `this`.
  const original = DataSource.prototype.createQueryRunner;
  let paused = false;
  DataSource.prototype.createQueryRunner = function (this: DataSource, ...args) {
    const runner = original.apply(this, args);
    const query = runner.query.bind(runner);
    runner.query = (async (sql: string, params?: unknown[]) => {
      const result: unknown = await query(sql, params);
      if (!paused && /^SELECT EXISTS/.test(sql)) {
        paused = true;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return result;
    }) as typeof runner.query;
    return runner;
  };
  try {
    return await work();
  } finally {
    DataSource.prototype.createQueryRunner = original;
  }
}

const groupedProbes = probes.slice(0, 6);

test('a slow first pair does not make later pairs false: each pair gets its own 2 s window', async () => {
  const person = await stack.person(['hr.employee', 'hr.admin']);
  const expected = await single(person.secret, groupedProbes);
  assert.ok(expected.filter(Boolean).length >= 3);
  // 2.2 s > the 2 s plan window of one session read, < the 3 s transaction timeout.
  const merged = await slowAfterFirstPair(2200, () =>
    stack.authorization.permitsMany(person.secret, groupedProbes),
  );
  assert.deepEqual(merged, expected);
});

test('a session that really expires between pairs still answers false for the later pairs', async () => {
  const person = await stack.person(['hr.employee', 'hr.admin']);
  const expected = await single(person.secret, groupedProbes);
  await stack.migration.query(
    `UPDATE application_session SET created_at=statement_timestamp() - interval '1 hour', authenticated_at=statement_timestamp() - interval '1 hour', reauthenticated_at=NULL, expires_at=statement_timestamp() + interval '1500 milliseconds' WHERE token_hash=$1`,
    [sessionDigest(person.secret)],
  );
  const merged = await slowAfterFirstPair(1800, () =>
    stack.authorization.permitsMany(person.secret, groupedProbes),
  );
  assert.equal(merged[0], expected[0]);
  assert.ok(expected.slice(1).some(Boolean));
  assert.deepEqual(
    merged.slice(1),
    expected.slice(1).map(() => false),
  );
});
