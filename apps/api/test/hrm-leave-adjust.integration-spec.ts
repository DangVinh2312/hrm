// T7 item 2 on PostgreSQL (design §5.2 leave-rate.adjust, §8–§9, D07, D14, ADR 0017/0018,
// acceptance E-17): the writer of `adjustment` ledger entries (HR, fresh session, mandatory
// `reference`, open month, idempotent, audited atomically) and the HR reconciliation list reading
// the requests it names. Past months are fixed (hire 2026-01-05; March 2026 accrues 1440 minutes
// by its end); nothing depends on the run date. Synthetic people only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { after, before, test } from 'node:test';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { withClient } from './setup-postgres.ts';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';
import {
  attendanceFixture,
  failures,
  fulfilled,
  raced,
  refused,
  rejected,
} from './hrm-attendance.helper.ts';

let stack: ModuleStack;
let f: ReturnType<typeof attendanceFixture>;

before(async () => {
  stack = await startModuleStack();
  f = attendanceFixture(stack);
  await f.setup();
});

after(() => stack?.stop());

const adjust = (
  secret: string,
  name: string,
  options: {
    minutes?: number;
    effectiveOn?: string;
    reference?: string;
    key?: string;
  } = {},
) =>
  stack.leave.adjust(secret, {
    employeeId: f.employeeOf(name),
    minutes: options.minutes ?? 480,
    effectiveOn: options.effectiveOn ?? '2026-03-10',
    reference: options.reference ?? 'QĐ-2026/03',
    idempotencyKey: options.key ?? randomUUID(),
  });

const rows = (name: string) =>
  stack.migration.query<
    { id: string; kind: string; minutes: number; reference: string | null; date: string }[]
  >(
    `SELECT id::text AS id, entry_kind AS kind, minutes, reference, to_char(effective_on,'YYYY-MM-DD') AS date
       FROM leave_ledger WHERE employee_id = $1 AND entry_kind = 'adjustment' ORDER BY created_at, id`,
    [f.employeeOf(name)],
  );

const everything = async (name: string) => ({
  ledger: await rows(name),
  buckets: await f.count('SELECT count(*)::text AS n FROM leave_bucket'),
  claims: await f.count(
    `SELECT count(*)::text AS n FROM hr_idempotency WHERE operation = 'leave.adjust'`,
  ),
  audits: await f.count(
    `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') = 'hr.leave.adjust'`,
  ),
});

const entitled = async (name: string, asOn: string) =>
  (await stack.leave.balance(f.p('H').secret, { employeeId: f.employeeOf(name), asOn }))
    ?.entitledMinutes;

test('HR adds an adjustment with a reference: one ledger row, the balance moves, one audit (E-17 writer)', async () => {
  await f.hire('Y1', ['hr.employee']);
  const before = await entitled('Y1', '2026-03-31');
  const result = await adjust(f.p('H').fresh, 'Y1', { minutes: 480, reference: 'QĐ-2026/03' });
  assert.ok(result);
  const [row] = await rows('Y1');
  assert.deepEqual(row, {
    id: result.id,
    kind: 'adjustment',
    minutes: 480,
    reference: 'QĐ-2026/03',
    date: '2026-03-10',
  });
  assert.equal(await entitled('Y1', '2026-03-31'), (before ?? 0) + 480);
  assert.equal((await everything('Y1')).audits, 1);
  // A negative entry lowers it; the entries stay in the ledger, nothing is edited.
  await adjust(f.p('H').fresh, 'Y1', { minutes: -240, reference: 'Sửa số cũ' });
  assert.equal(await entitled('Y1', '2026-03-31'), (before ?? 0) + 240);
  assert.equal((await rows('Y1')).length, 2);
});

test('only HR with a fresh session adjusts; everyone else is refused or sees 404, and nothing is written', async () => {
  await f.hire('Y2', ['hr.employee']);
  const before = await everything('Y2');
  await assert.rejects(adjust(f.p('H').secret, 'Y2'), ProductAccessDenied);
  assert.equal(await adjust(f.p('Y2').fresh, 'Y2'), undefined, 'not even for oneself');
  assert.equal(await adjust(f.p('L1').fresh, 'Y2'), undefined, 'a lead has no such right');
  assert.equal(await adjust(f.p('C').fresh, 'Y2'), undefined, 'the COO has no such right');
  const stranger = await stack.person([]);
  assert.equal(await adjust(stranger.fresh, 'Y2'), undefined);
  assert.deepEqual(await everything('Y2'), before);
});

test('a retry with the same key writes nothing more; the same key for another payload is refused (422)', async () => {
  await f.hire('Y3', ['hr.employee']);
  const key = randomUUID();
  const first = await adjust(f.p('H').fresh, 'Y3', { key });
  assert.deepEqual(await adjust(f.p('H').fresh, 'Y3', { key }), first);
  assert.equal((await rows('Y3')).length, 1);
  await assert.rejects(
    adjust(f.p('H').fresh, 'Y3', { key, minutes: 960 }),
    refused('error.idempotencyKeyReused', 422),
  );
  assert.equal((await rows('Y3')).length, 1);
  assert.ok(await adjust(f.p('H').fresh, 'Y3'), 'a new key is a new adjustment');
  assert.equal((await rows('Y3')).length, 2);
});

test('D07: a closed month refuses the adjustment (409 error.periodClosed); the next open month and a reopened month accept it', async () => {
  await f.hire('Y4', ['hr.employee']);
  await stack.attendance.closePeriod(f.p('H').fresh, { month: '2026-04' });
  const before = await everything('Y4');
  await assert.rejects(
    adjust(f.p('H').fresh, 'Y4', { effectiveOn: '2026-04-15' }),
    refused('error.periodClosed', 409),
  );
  assert.deepEqual(await everything('Y4'), before);
  assert.ok(await adjust(f.p('H').fresh, 'Y4', { effectiveOn: '2026-05-04' }));
  await stack.attendance.reopenPeriod(f.p('H').fresh, {
    month: '2026-04',
    reason: 'Điều chỉnh phép',
  });
  assert.ok(await adjust(f.p('H').fresh, 'Y4', { effectiveOn: '2026-04-15' }));
  assert.equal((await rows('Y4')).length, 2);
});

test('an adjustment dated before the hire date is refused', async () => {
  await f.hire('Y5', ['hr.employee'], { hiredOn: '2026-02-02' });
  const before = await everything('Y5');
  await assert.rejects(
    adjust(f.p('H').fresh, 'Y5', { effectiveOn: '2026-01-15' }),
    rejected('before_hire'),
  );
  assert.deepEqual(await everything('Y5'), before);
});

test('an audit failure rolls back the entry, the claim and the bucket; the same key then succeeds once', async () => {
  await f.hire('Y6', ['hr.employee']);
  const before = await everything('Y6');
  const key = randomUUID();
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      adjust(f.p('H').fresh, 'Y6', { key }),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual(await everything('Y6'), before);
  assert.ok(await adjust(f.p('H').fresh, 'Y6', { key }));
  assert.equal((await rows('Y6')).length, 1);
});

test('two requests with one key racing (a retry beside the original): one entry, both get its id', async () => {
  await f.hire('Y7', ['hr.employee']);
  const key = randomUUID();
  const results = await raced(
    stack,
    async (client: Client) => {
      await client.query('SELECT 1 FROM employee WHERE id = $1 FOR UPDATE', [f.employeeOf('Y7')]);
    },
    2,
    () => [adjust(f.p('H').fresh, 'Y7', { key }), adjust(f.p('H').fresh, 'Y7', { key })],
  );
  const done = fulfilled(results).map((r) => r.value);
  assert.equal(done.length, 2, JSON.stringify(failures(results).map(String)));
  assert.deepEqual(done[0], done[1]);
  assert.equal((await rows('Y7')).length, 1);
});

test('E-17: a negative adjustment makes pending leave exceed the accrual; HR reads the list and every request it names', async () => {
  await f.hire('Y8', ['hr.employee']);
  // March: 2 days pending (960) against 1440 accrued by the end of the month: no excess yet.
  const request = await f.fixtureRequest('Y8', 'annual-leave', 'pending_lead', [
    '2026-03-09',
    '2026-03-10',
  ]);

  const listed = async () =>
    (await stack.leave.reconciliation(f.p('H').secret, { year: 2026, limit: 100, offset: 0 })).items
      .filter((item) => item.employeeId === f.employeeOf('Y8'))
      .sort((a, b) => a.month - b.month);

  assert.deepEqual(await listed(), []);
  await adjust(f.p('H').fresh, 'Y8', {
    minutes: -960,
    effectiveOn: '2026-03-01',
    reference: 'Giảm',
  });
  const items = await listed();
  const march = items.find((item) => item.month === 3);
  assert.equal(march?.accruedMinutes, 480);
  assert.equal(march?.pendingMinutes, 960);
  assert.equal(march?.excessMinutes, 480);
  assert.deepEqual(march?.requestIds, [request.id]);
  // F6: HR (company scope) opens the named request, to decide what to do with it.
  for (const item of items)
    for (const id of item.requestIds) {
      const detail = await stack.workRequests.detail(f.p('H').secret, id);
      assert.equal(detail?.id, id);
      assert.equal(detail?.state, 'pending_lead');
    }
  // The list is HR's: the employee reads no one's reconciliation, and a stranger nothing.
  const own = await stack.leave.reconciliation(f.p('Y8').secret, {
    year: 2026,
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(
    own.items.filter((item) => item.employeeId !== f.employeeOf('Y8')),
    [],
  );
  const outsider = await stack.person([]);
  assert.deepEqual(
    (await stack.leave.reconciliation(outsider.secret, { year: 2026, limit: 100, offset: 0 }))
      .items,
    [],
  );
});
