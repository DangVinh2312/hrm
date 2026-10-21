// T7 annual leave on PostgreSQL (design §8–§9, ADR 0017/0018; acceptance E-01..E-16, B-05, B-07):
// accrual and the D09 breakdown through the real queries, scope of the balance, the balance check
// of submit, the reconciliation list, the internal debit, the closed M3 gate of the production
// composition and the ledger schema/ACL. Synthetic people only. Balances at an explicit report
// date use fixed dates (hire 2026-01-05); submit tests move the entitlement with an `opening`
// ledger entry so they hold on any run date.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ApiRejection } from '../dist/infrastructure/api-error.helper.js';
import { isUniqueViolation, registerHrObject } from '../dist/hr/hr-database.helper.js';
import { ProductCommandRejected } from '../dist/authorization/services/product-authority.service.js';
import { applyApprovedLeave } from '../dist/leave/leave.service.js';
import { approvedEffects } from '../dist/work-request/services/request-approval.service.js';
import type { SubmitRequestInput } from '../dist/work-request/work-request.types.js';
import { sqlState } from './setup-postgres.ts';
import { type HrPerson, type HrStack, startHrStack } from './hrm-stack.helper.ts';

// T1: lead L1, members E1, E2, L1, P (probation). T2: members C (COO), X (CEO, employee role
// only). H is HR/Admin; N is signed in without any HR role.
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

const versionOf = async (employeeId: string) =>
  (
    await stack.migration.query<{ version: string }[]>(
      'SELECT version::text AS version FROM employee WHERE id=$1',
      [employeeId],
    )
  )[0]!.version;

async function hire(
  name: string,
  roles: readonly string[],
  options: { status?: 'probation' | 'official'; hiredOn?: string; rate?: number } = {},
) {
  const person = await stack.person(roles);
  const { id } = await stack.employees.create(await stack.freshRoot(), {
    code: `V${String(++sequence).padStart(3, '0')}`,
    fullName: `Nhân viên phép giả ${sequence}`,
    hiredOn: options.hiredOn ?? '2026-01-05',
    status: options.status ?? 'official',
    annualLeaveMinutes: options.rate ?? 5760,
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

const member = async (team: string, name: string, primary = true) =>
  assert.ok(
    await stack.teams.addMember(await stack.freshRoot(), {
      teamId: teams[team]!,
      employeeId: employeeOf(name),
      primary,
    }),
  );

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

const leave = (
  date: string,
  startMinute = 540,
  endMinute = 1080,
  kind: 'annual-leave' | 'unpaid-leave' = 'annual-leave',
) =>
  ({
    kind,
    teamId: null,
    reason: 'Việc gia đình',
    segments: [{ date, startMinute, endMinute }],
  }) as const satisfies SubmitRequestInput;

const submit = (name: string, input: SubmitRequestInput, key = randomUUID()) =>
  stack.workRequests.submit(p(name).secret, key, input);

const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof ApiRejection && error.code === code && error.status === status;

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

/** A ledger row written as the owner (the import path of D14 is offline, T12). */
const ledger = (
  name: string,
  kind: 'opening' | 'adjustment',
  effectiveOn: string,
  minutes: number,
  reference = 'import:phép-đầu-kỳ-giả',
) =>
  stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
     VALUES (gen_random_uuid(), $1, $2, CAST($3 AS date), $4, $5)`,
    [employeeOf(name), kind, effectiveOn, minutes, reference],
  );

/**
 * Makes the entitlement at the end of `date`'s month exactly `minutes` for an employee hired
 * official 2026-01-05 at 5760 (480 a month), so a test does not depend on the run date.
 */
const available = (name: string, date: string, minutes: number) =>
  ledger(
    name,
    'opening',
    `${date.slice(0, 4)}-01-01`,
    minutes - 480 * Number(date.slice(5, 7)),
    'import:điều-chỉnh-thử',
  );

/** `as`'s balance read of `target`, at `asOn` (default: today). */
const balance = (as: string, target: string, asOn: string | null = null) =>
  stack.leave.balance(p(as).secret, { employeeId: employeeOf(target), asOn });

/** A request row the way an older build left it: written as the owner, any state and dates. */
async function fixtureLeave(
  name: string,
  state: string,
  dates: readonly { date: string; start: number; end: number; minutes: number }[],
): Promise<string> {
  const id = randomUUID();
  const objectId = await stack.runner.run('write', (tx) => registerHrObject(tx, 'workRequest', id));
  await stack.migration.query(
    `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state,reason)
     VALUES($1,$2,$3,$4,$5,'annual-leave',$6,'Đơn cũ')`,
    [id, objectId, employeeOf(name), p(name).id, teams.T1, state],
  );
  await stack.migration.query(
    `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
     SELECT $1,'annual-leave', s.d, s.a, s.b, s.m
       FROM unnest(CAST($2 AS date[]), CAST($3 AS int2[]), CAST($4 AS int2[]), CAST($5 AS int2[])) AS s(d,a,b,m)`,
    [
      id,
      dates.map((d) => d.date),
      dates.map((d) => d.start),
      dates.map((d) => d.end),
      dates.map((d) => d.minutes),
    ],
  );
  return id;
}

const day480 = (date: string) => ({ date, start: 540, end: 1080, minutes: 480 });

/** Everything the leave effect may write; a refused decision or effect leaves it unchanged. */
const leaveRows = async () => ({
  ledger: await count('SELECT count(*)::text AS n FROM leave_ledger'),
  buckets: await count('SELECT count(*)::text AS n FROM leave_bucket'),
});

before(async () => {
  stack = await startHrStack();
  for (const name of ['E1', 'E2', 'L1', 'X']) await hire(name, ['hr.employee']);
  await hire('P', ['hr.employee'], { status: 'probation' });
  await hire('C', ['hr.employee', 'hr.coo']);
  await hire('H', ['hr.employee', 'hr.admin']);
  people.N = await stack.person([]);
  for (const name of ['T1', 'T2'])
    teams[name] = (await stack.teams.create(await stack.freshRoot(), { name })).id;
  for (const name of ['E1', 'E2', 'L1', 'P']) await member('T1', name);
  for (const name of ['C', 'X']) await member('T2', name);
  assert.ok(
    await stack.teams.assignLead(await stack.freshRoot(), {
      teamId: teams.T1!,
      employeeId: employeeOf('L1'),
    }),
  );
});

after(() => stack?.stop());

test('accrual through the query: standard 5760, agreed 14 days, no carry-over, no seniority (E-01, E-02, E-14..E-16)', async () => {
  await hire('A14', ['hr.employee'], { rate: 6720 });
  await hire('OLD', ['hr.employee'], { hiredOn: '2020-01-06' });
  const march = await balance('H', 'E1', '2026-03-31');
  assert.deepEqual(march, {
    employeeId: employeeOf('E1'),
    year: 2026,
    asOn: '2026-03-31',
    annualMinutes: 5760,
    entitledMinutes: 1440,
    usedMinutes: 0,
    futureApprovedMinutes: 0,
    pendingMinutes: 0,
    availableMinutes: 1440,
  });
  assert.equal((await balance('H', 'E1', '2026-12-31'))?.entitledMinutes, 5760);
  assert.equal((await balance('H', 'A14', '2026-03-31'))?.entitledMinutes, 1680);
  assert.equal((await balance('H', 'A14', '2026-03-31'))?.annualMinutes, 6720);
  assert.equal((await balance('H', 'A14', '2026-12-31'))?.entitledMinutes, 6720);
  // A new year starts from its own accrual: nothing carried from 2026, no bonus for six years.
  assert.equal((await balance('H', 'E1', '2027-01-31'))?.entitledMinutes, 480);
  assert.equal((await balance('H', 'OLD', '2026-01-31'))?.entitledMinutes, 480);
  assert.equal((await balance('H', 'OLD', '2026-12-31'))?.entitledMinutes, 5760);
});

test('probation accrues nothing and is not paid back after the official date (B-05, B-07, E-11)', async () => {
  await hire('P2', ['hr.employee'], { status: 'probation', hiredOn: '2026-07-01' });
  assert.equal((await balance('H', 'P2', '2026-11-30'))?.entitledMinutes, 0);
  assert.ok(
    await stack.employees.confirmOfficial(p('H').secret, {
      employeeId: employeeOf('P2'),
      effectiveOn: '2026-09-01',
    }),
  );
  // Official from 2026-09-01: September..December count, July and August are not paid back.
  assert.equal((await balance('H', 'P2', '2026-08-31'))?.entitledMinutes, 0);
  assert.equal((await balance('H', 'P2', '2026-09-30'))?.entitledMinutes, 480);
  assert.equal((await balance('H', 'P2', '2026-12-31'))?.entitledMinutes, 1920);
  // Official from the 16th of a month: that month is probation on its 15th.
  await hire('P3', ['hr.employee'], { status: 'probation', hiredOn: '2026-07-01' });
  assert.ok(
    await stack.employees.confirmOfficial(p('H').secret, {
      employeeId: employeeOf('P3'),
      effectiveOn: '2026-11-16',
    }),
  );
  assert.equal((await balance('H', 'P3', '2026-11-30'))?.entitledMinutes, 0);
  assert.equal((await balance('H', 'P3', '2026-12-31'))?.entitledMinutes, 480);
  // The probation employee of the fixture cannot even file annual leave (T5 rule, B-02).
  const [date] = await days(1);
  await assert.rejects(submit('P', leave(date!)), refused('error.kindNotAllowedInProbation', 422));
});

test('the rate floor is 12 days and only HR sets it (E-03, E-04)', async () => {
  const effectiveFrom = '2026-06-01';
  await assert.rejects(
    stack.migration.query(
      `INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes)
       SELECT gen_random_uuid(), object_id, employee_id, DATE '2026-07-01', 5280
         FROM leave_rate WHERE employee_id = $1`,
      [employeeOf('E2')],
    ),
    (error) => (error as { code?: string }).code === '23514',
  );
  for (const name of ['L1', 'E1', 'C'])
    assert.equal(
      await stack.employees.adjustLeaveRate(p(name).fresh, {
        employeeId: employeeOf('E2'),
        effectiveFrom,
        annualMinutes: 6720,
      }),
      undefined,
      name,
    );
  assert.ok(
    await stack.employees.adjustLeaveRate(p('H').fresh, {
      employeeId: employeeOf('E2'),
      effectiveFrom,
      annualMinutes: 6720,
    }),
  );
  // January..May accrue 480 each; from June each month adds floor(R*k/12) - floor(R*(k-1)/12) on
  // the rate of its 15th (spec §9): June adds 3360 - 2800 and December ends on 6720 - 2800 more.
  assert.equal((await balance('H', 'E2', '2026-05-31'))?.entitledMinutes, 2400);
  assert.equal((await balance('H', 'E2', '2026-06-30'))?.entitledMinutes, 2400 + 560);
  assert.equal((await balance('H', 'E2', '2026-12-31'))?.entitledMinutes, 2400 + (6720 - 2800));
});

test('who may read a balance: self, a lead of the member, HR and Root; COO, CEO and others only their own (matrix §5.2)', async () => {
  const allowed: [string, string][] = [
    ['E1', 'E1'],
    ['L1', 'E1'],
    ['L1', 'L1'],
    ['H', 'E1'],
    ['H', 'C'],
    ['C', 'C'],
    ['X', 'X'],
  ];
  for (const [who, target] of allowed)
    assert.equal((await balance(who, target, '2026-03-31'))?.employeeId, employeeOf(target));
  const denied: [string, string][] = [
    ['E1', 'E2'],
    ['E2', 'E1'],
    ['L1', 'C'],
    ['C', 'E1'],
    ['X', 'E1'],
    ['N', 'E1'],
  ];
  for (const [who, target] of denied)
    assert.equal(await balance(who, target, '2026-03-31'), undefined, `${who} → ${target}`);
  // Absent and foreign are indistinguishable.
  const absent = { employeeId: randomUUID(), asOn: null };
  assert.equal(await stack.leave.balance(p('H').secret, absent), undefined);
  assert.equal(await stack.leave.balance(p('E1').secret, absent), undefined);
  assert.equal(
    (await stack.leave.balance(await stack.root(), { employeeId: employeeOf('E1'), asOn: null }))
      ?.employeeId,
    employeeOf('E1'),
  );
  // A lead reads the members of their own team only.
  assert.equal(await balance('L1', 'X'), undefined);
});

test('D09 breakdown: a pending request is "pending", never "used"; the report date defaults to today (E-05)', async () => {
  await hire('F1', ['hr.employee']);
  await member('T1', 'F1');
  const [date] = await days(1);
  await available('F1', date!, 1920);
  const before = await balance('F1', 'F1', date);
  assert.ok(before);
  assert.equal(before.entitledMinutes, 1920);
  assert.equal(before.availableMinutes, 1920);
  const result = await submit('F1', leave(date!, 540, 780));
  assert.equal(result?.state, 'pending_lead');
  const after = await balance('F1', 'F1', date);
  assert.ok(after);
  assert.equal(after.usedMinutes, 0);
  assert.equal(after.futureApprovedMinutes, 0);
  assert.equal(after.pendingMinutes, 240);
  assert.equal(after.availableMinutes, 1920 - 240);
  assert.equal(after.entitledMinutes, 1920);
  assert.equal((await balance('F1', 'F1'))?.asOn, await stack.day(0));
  assert.equal(
    await count('SELECT count(*)::text AS n FROM leave_ledger WHERE employee_id = $1', [
      employeeOf('F1'),
    ]),
    1,
    'only the opening entry: submit writes no debit',
  );
});

test('submit checks the accrued balance: exact fit passes, one slot more is 422 and nothing is written (B-05, E-08, E-13)', async () => {
  await hire('F2', ['hr.employee']);
  await member('T1', 'F2');
  const [d1, d2, d3] = await days(3);
  await available('F2', d1!, 480);
  const first = await submit('F2', leave(d1!, 540, 1080));
  assert.equal(first?.state, 'pending_lead');
  const before = {
    requests: await count('SELECT count(*)::text AS n FROM work_request'),
    segments: await count('SELECT count(*)::text AS n FROM work_request_segment'),
    claims: await count('SELECT count(*)::text AS n FROM hr_idempotency'),
    audits: await count(`SELECT count(*)::text AS n FROM audit_outbox`),
  };
  const key = randomUUID();
  await assert.rejects(
    submit('F2', leave(d2!, 540, 660), key),
    refused('error.insufficientLeave', 422),
  );
  assert.deepEqual(
    {
      requests: await count('SELECT count(*)::text AS n FROM work_request'),
      segments: await count('SELECT count(*)::text AS n FROM work_request_segment'),
      claims: await count('SELECT count(*)::text AS n FROM hr_idempotency'),
      audits: await count(`SELECT count(*)::text AS n FROM audit_outbox`),
    },
    before,
  );
  // Unpaid leave and other kinds do not draw on the leave balance.
  assert.equal((await submit('F2', leave(d3!, 540, 1080, 'unpaid-leave')))?.state, 'pending_lead');
  // A request the lead rejects frees its minutes: the same submit now fits, with the same key.
  const lead = await stack.approvals.decide(p('L1').secret, {
    requestId: first.id,
    expectedVersion: '1',
    idempotencyKey: randomUUID(),
    decision: 'reject',
    reason: 'Thiếu người',
    acknowledgeWfhLimit: false,
  });
  assert.equal(lead?.state, 'rejected');
  assert.equal((await submit('F2', leave(d2!, 540, 660), key))?.state, 'pending_lead');
});

test('a replay with the same key returns the first result even after the balance is used up', async () => {
  await hire('F3', ['hr.employee']);
  await member('T1', 'F3');
  const [d1, d2] = await days(2);
  await available('F3', d1!, 480);
  const key = randomUUID();
  const first = await submit('F3', leave(d1!, 540, 1080), key);
  assert.ok(first);
  await assert.rejects(submit('F3', leave(d2!, 540, 660)), refused('error.insufficientLeave', 422));
  assert.deepEqual(await submit('F3', leave(d1!, 540, 1080), key), first);
});

test('the check counts approved leave through the ledger, pending through the request, with leave dated in earlier months first (spec §8)', async () => {
  await hire('F4', ['hr.employee']);
  await member('T1', 'F4');
  const [d1, d2, d3] = await days(3);
  // Approved leave of this month (a debit as the approval effect leaves it): 480 of 960.
  await available('F4', d1!, 960);
  const id = await fixtureLeave('F4', 'approved', [day480(d1!)]);
  await stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, source_request_id, source_work_date)
     VALUES (gen_random_uuid(), $1, 'debit', CAST($2 AS date), 480, $3, CAST($2 AS date))`,
    [employeeOf('F4'), d1, id],
  );
  assert.equal((await submit('F4', leave(d2!, 540, 1080)))?.state, 'pending_lead');
  await assert.rejects(submit('F4', leave(d3!, 540, 660)), refused('error.insufficientLeave', 422));
  const view = await balance('F4', 'F4');
  assert.ok(view);
  assert.equal(view.pendingMinutes, 480);
  assert.equal(view.availableMinutes, 0);
});

test('reconciliation: a negative entitlement only forbids taking leave, months with nothing committed are not listed', async () => {
  await hire('R3', ['hr.employee']);
  await member('T1', 'R3');
  // 480 a month minus 3000 on 2026-01-02: the cumulative entitlement is negative until April.
  await ledger('R3', 'adjustment', '2026-01-02', -3000, 'adjustment:điều-chỉnh-giảm');
  await fixtureLeave('R3', 'pending_lead', [day480('2026-03-02')]);
  const page = await stack.leave.reconciliation(p('H').secret, {
    year: 2026,
    limit: 100,
    offset: 0,
  });
  const months = page.items.filter((i) => i.employeeId === employeeOf('R3')).map((i) => i.month);
  assert.equal(months.includes(1), false, 'January has nothing committed');
  assert.equal(months.includes(2), false, 'February has nothing committed');
  assert.equal(months[0], 3, 'March is the first month with leave taken beyond the entitlement');
});

test('reconciliation: pending leave above the accrual is listed per month for HR, nothing is cancelled (spec §8, T5 backlog)', async () => {
  await hire('R1', ['hr.employee']);
  await member('T1', 'R1');
  // Five days in March 2026 against 1440 accrued to the end of March (E-13), filed by an older build.
  const march = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];
  const id = await fixtureLeave('R1', 'pending_lead', march.map(day480));
  await hire('R2', ['hr.employee']);
  await member('T1', 'R2');
  await fixtureLeave('R2', 'pending_lead', [day480('2026-03-02')]);

  const state = () =>
    stack.migration.query<{ state: string; version: string }[]>(
      'SELECT state, version::text AS version FROM work_request WHERE id = $1',
      [id],
    );

  const before = await state();
  const page = await stack.leave.reconciliation(p('H').secret, {
    year: 2026,
    limit: 100,
    offset: 0,
  });
  assert.equal(page.year, 2026);
  const mine = page.items.filter((item) => item.employeeId === employeeOf('R1'));
  assert.deepEqual(
    mine.map((item) => [item.month, item.accruedMinutes, item.pendingMinutes, item.excessMinutes]),
    [
      [3, 1440, 2400, 960],
      [4, 1920, 2400, 480],
    ],
  );
  assert.deepEqual(mine[0]?.requestIds, [id]);
  assert.equal(mine[0]?.employeeCode.startsWith('V'), true);
  assert.equal(
    page.items.some((item) => item.employeeId === employeeOf('R2')),
    false,
    'a fitting request is not listed',
  );
  assert.deepEqual(await state(), before, 'no state or version change');
  // Scope: the lead of the team sees members, the employee sees only themself, others nothing.
  const own = await stack.leave.reconciliation(p('R1').secret, {
    year: 2026,
    limit: 100,
    offset: 0,
  });
  assert.ok(own.items.length > 0 && own.items.every((i) => i.employeeId === employeeOf('R1')));
  const led = await stack.leave.reconciliation(p('L1').secret, {
    year: 2026,
    limit: 100,
    offset: 0,
  });
  assert.ok(led.items.some((i) => i.employeeId === employeeOf('R1')));
  for (const other of ['E2', 'X', 'C', 'N']) {
    const none = await stack.leave.reconciliation(p(other).secret, {
      year: 2026,
      limit: 100,
      offset: 0,
    });
    assert.equal(
      none.items.some((i) => i.employeeId === employeeOf('R1')),
      false,
      other,
    );
  }
  // Paging counts employees (every one with pending annual leave in the year), not months.
  assert.ok(Number(page.total) >= 2);
  const beyond = await stack.leave.reconciliation(p('H').secret, {
    year: 2026,
    limit: 1,
    offset: Number(page.total),
  });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, page.total);
  assert.deepEqual(
    (await stack.leave.reconciliation(p('H').secret, { year: 2031, limit: 100, offset: 0 })).items,
    [],
  );
});

test('the internal debit writes one ledger row per segment and creates the bucket; replay and a short balance write nothing (E-06, E-10)', async () => {
  await hire('D1', ['hr.employee']);
  await member('T1', 'D1');
  const [d1, d2] = await days(2);
  await available('D1', d1!, 960);
  const request = await submit('D1', {
    kind: 'annual-leave',
    teamId: null,
    reason: 'Nghỉ phép',
    segments: [
      { date: d1!, startMinute: 540, endMinute: 780 },
      { date: d2!, startMinute: 840, endMinute: 1080 },
    ],
  });
  assert.ok(request);
  const before = await leaveRows();
  await stack.runner.run('write', (tx) => applyApprovedLeave(tx, { requestId: request.id }));
  const debits = await stack.migration.query<{ date: string; minutes: number; kind: string }[]>(
    `SELECT to_char(effective_on,'YYYY-MM-DD') AS date, minutes, entry_kind AS kind FROM leave_ledger
      WHERE source_request_id = $1 ORDER BY effective_on`,
    [request.id],
  );
  assert.deepEqual(debits, [
    { date: d1, minutes: 240, kind: 'debit' },
    { date: d2, minutes: 240, kind: 'debit' },
  ]);
  const buckets = await stack.migration.query<{ year: number; revision: string }[]>(
    'SELECT year, revision::text AS revision FROM leave_bucket WHERE employee_id = $1',
    [employeeOf('D1')],
  );
  assert.deepEqual(buckets, [{ year: Number(d1!.slice(0, 4)), revision: '2' }]);
  assert.deepEqual(await leaveRows(), { ledger: before.ledger + 2, buckets: before.buckets + 1 });
  // The request is still pending in this internal test, so it counts once: the sum holds.
  // The debits are the approved minutes; dates after the report date are "approved ahead".
  const view = await balance('D1', 'D1', d1);
  assert.equal(view?.usedMinutes, 240);
  assert.equal(view?.futureApprovedMinutes, 240);

  // Replay: the UNIQUE per segment refuses a second debit and the whole transaction rolls back.
  await assert.rejects(
    stack.runner.run('write', (tx) => applyApprovedLeave(tx, { requestId: request.id })),
    isUniqueViolation,
  );
  assert.deepEqual(await leaveRows(), { ledger: before.ledger + 2, buckets: before.buckets + 1 });

  // A short balance (an adjustment took leave back after the submit) refuses the debit: no
  // ledger row and no bucket, the bucket insert rolled back with it.
  await hire('D2', ['hr.employee']);
  await member('T1', 'D2');
  const [d3] = await days(1);
  await available('D2', d3!, 480);
  const second = await submit('D2', leave(d3!, 540, 1080));
  assert.ok(second);
  await ledger('D2', 'adjustment', `${d3!.slice(0, 4)}-01-02`, -480, 'adjustment:điều-chỉnh-giảm');
  const snapshot = await leaveRows();
  await assert.rejects(
    stack.runner.run('write', (tx) => applyApprovedLeave(tx, { requestId: second.id })),
    rejected('insufficient_leave'),
  );
  assert.deepEqual(await leaveRows(), snapshot);
});

test('the debit refuses a request outside official days and a request that is not annual leave', async () => {
  await hire('D3', ['hr.employee'], { status: 'probation', hiredOn: '2026-01-05' });
  await member('T1', 'D3');
  const id = await fixtureLeave('D3', 'pending_final', [day480('2026-03-03')]);
  const before = await leaveRows();
  await assert.rejects(
    stack.runner.run('write', (tx) => applyApprovedLeave(tx, { requestId: id })),
    rejected('not_official'),
  );
  const [date] = await days(1);
  const unpaid = await submit('E1', leave(date!, 540, 1080, 'unpaid-leave'));
  assert.ok(unpaid);
  await assert.rejects(
    stack.runner.run('write', (tx) => applyApprovedLeave(tx, { requestId: unpaid.id })),
    /not annual leave/,
  );
  assert.deepEqual(await leaveRows(), before);
});

test('production composition: every effect part is registered, so the COO and Root approve annual leave and the debit is written', async () => {
  assert.deepEqual(Object.keys(approvedEffects).sort(), ['attendance', 'leave', 'wfh']);
  await hire('G1', ['hr.employee']);
  await member('T1', 'G1');
  const [first, second] = await days(2);
  await available('G1', second!, 960);

  const key = () => randomUUID();

  const decide = (who: string, id: string, version: string, decision: 'approve' | 'reject') =>
    stack.approvals.decide(who, {
      requestId: id,
      expectedVersion: version,
      idempotencyKey: key(),
      decision,
      reason: decision === 'reject' ? 'Hết ngân sách' : null,
      acknowledgeWfhLimit: false,
    });

  for (const [date, approver] of [
    [first!, p('C').secret],
    [second!, await stack.root()],
  ] as const) {
    const request = await submit('G1', leave(date, 540, 1080));
    assert.ok(request);
    assert.equal(
      (await decide(p('L1').secret, request.id, '1', 'approve'))?.state,
      'pending_final',
    );
    assert.deepEqual(await decide(approver, request.id, '2', 'approve'), {
      id: request.id,
      state: 'approved',
      version: '3',
    });
    assert.equal(
      await count('SELECT count(*)::text AS n FROM leave_ledger WHERE source_request_id = $1', [
        request.id,
      ]),
      1,
    );
  }
});

test('menu `leave` follows the readable own balance (display only)', async () => {
  const menus = async (secret: string) => (await stack.employees.me(secret)).menus;

  for (const name of ['E1', 'L1', 'C', 'H', 'X'])
    assert.ok((await menus(p(name).secret)).includes('leave'), name);
  assert.equal((await menus(p('N').secret)).includes('leave'), false);
  assert.equal((await menus(await stack.root())).includes('leave'), false);
});

test('ledger schema: kinds, shapes, one debit per segment, one matching reversal per debit; opening needs a source (D14)', async () => {
  await hire('S1', ['hr.employee']);
  await member('T1', 'S1');
  const id = await fixtureLeave('S1', 'approved', [day480('2026-04-07')]);
  const employee = employeeOf('S1');

  const insert = (
    kind: string,
    minutes: number,
    extra: {
      source?: string | null;
      reverses?: string | null;
      reference?: string | null;
      date?: string;
    } = {},
  ) =>
    sqlState(
      stack.migration.query(
        `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, source_request_id, source_work_date, reverses_entry_id, reference)
         VALUES (gen_random_uuid(), $1, $2, CAST($3 AS date), $4, $5, CAST($6 AS date), $7, $8)`,
        [
          employee,
          kind,
          extra.date ?? '2026-04-07',
          minutes,
          extra.source ?? null,
          extra.source ? (extra.date ?? '2026-04-07') : null,
          extra.reverses ?? null,
          extra.reference ?? null,
        ],
      ),
    );

  // CHECK: an opening entry without a source, an empty source, a zero amount, a debit above a day.
  assert.equal(await insert('opening', 480), '23514');
  assert.equal(await insert('opening', 480, { reference: '' }), '23514');
  assert.equal(await insert('adjustment', 0, { reference: 'x' }), '23514');
  assert.equal(await insert('debit', 481, { source: id }), '23514');
  assert.equal(await insert('debit', 480), '23514', 'a debit names its segment');
  assert.equal(await insert('reversal', 480), '23514', 'a reversal names its debit');
  assert.equal(await insert('accrual', 480, { reference: 'x' }), '23514', 'accrual is not stored');
  // With a source an opening or adjustment entry is valid, either sign.
  await ledger('S1', 'opening', '2026-04-07', 480, 'import:phiếu-đối-soát-01');
  await ledger('S1', 'adjustment', '2026-04-07', -240, 'adjustment:điều-chỉnh-giảm-01');
  // One debit per segment.
  const [debit] = await stack.migration.query<{ id: string }[]>(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, source_request_id, source_work_date)
     VALUES (gen_random_uuid(), $1, 'debit', DATE '2026-04-07', 480, $2, DATE '2026-04-07') RETURNING id::text AS id`,
    [employee, id],
  );
  assert.equal(await insert('debit', 480, { source: id }), '23505');
  // A debit must come from an annual-leave segment and a real one.
  const [date] = await days(1);
  const unpaid = await submit('E1', leave(date!, 540, 1080, 'unpaid-leave'));
  assert.ok(unpaid);
  assert.equal(await insert('debit', 480, { source: unpaid.id, date: date! }), '23503');
  assert.equal(await insert('debit', 480, { source: id, date: '2026-04-08' }), '23503');
  // A reversal repeats its debit (same minutes, date, employee) and happens once.
  assert.equal(await insert('reversal', 240, { reverses: debit!.id }), '23503');
  assert.equal(await insert('reversal', 480, { reverses: debit!.id, date: '2026-04-08' }), '23503');
  await stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reverses_entry_id)
     VALUES (gen_random_uuid(), $1, 'reversal', DATE '2026-04-07', 480, $2)`,
    [employee, debit!.id],
  );
  assert.equal(await insert('reversal', 480, { reverses: debit!.id }), '23505');
});

test('ledger ACL: the runtime logins only append; authority, identity and sync see nothing', async () => {
  const employee = employeeOf('E1');
  for (const statement of [
    'UPDATE leave_ledger SET minutes = 1',
    'DELETE FROM leave_ledger',
    'DELETE FROM leave_bucket',
    'UPDATE leave_bucket SET year = 2000',
    'UPDATE leave_bucket SET employee_id = employee_id',
  ])
    assert.equal(await sqlState(stack.pools.data.query(statement)), '42501', statement);
  // Allowed: create the bucket and bump its revision (the lock), nothing else.
  await stack.pools.data.query(
    `INSERT INTO leave_bucket(employee_id, year) VALUES ($1, 2031) ON CONFLICT DO NOTHING`,
    [employee],
  );
  await stack.pools.data.query('UPDATE leave_bucket SET revision = revision + 1 WHERE year = 2031');
  for (const login of ['authority', 'identity', 'sync'] as const)
    for (const table of ['leave_ledger', 'leave_bucket'])
      assert.equal(
        await sqlState(stack.pools[login].query(`SELECT 1 FROM ${table}`)),
        '42501',
        `${login} ${table}`,
      );
});
