// T5 submit and "my requests" on PostgreSQL (design §6.2–§6.4, §7, D06; acceptance B-01..B-20,
// C-07, C-22, C-23, C-26): owner from the session, initial state, segments, overlap under the
// employee lock, idempotent retry, scoped pagination, audit atomicity, ACL and CHECKs.
// Synthetic people and fixture calendar days only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { ApiRejection } from '../dist/infrastructure/helpers/api-error.helper.js';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { WORK_CALENDAR_ID } from '../dist/modules/hr/helpers/hr-database.helper.js';
import type { SubmitRequestInput } from '../dist/modules/work-request/work-request.types.js';
import { openClient, sqlState, withClient } from './setup-postgres.ts';
import { type HrPerson, type HrStack, startHrStack } from './hrm-stack.helper.ts';

// E1/E2/R3 employees, P1 on probation, L1 lead of T1, C COO, H HR/Admin; U has the employee
// role but no profile; N is signed in without any HR role.
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

const totals = async () => ({
  requests: await count('SELECT count(*)::text AS n FROM work_request'),
  segments: await count('SELECT count(*)::text AS n FROM work_request_segment'),
  decisions: await count('SELECT count(*)::text AS n FROM request_decision'),
  claims: await count('SELECT count(*)::text AS n FROM hr_idempotency'),
  objects: await count(
    `SELECT count(*)::text AS n FROM object_ref WHERE type_key = convert_to('workRequest','UTF8')`,
  ),
  audits: await count(
    `SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') = 'hr.request.submit'`,
  ),
});

const versionOf = async (employeeId: string) =>
  (
    await stack.migration.query<{ version: string }[]>(
      'SELECT version::text AS version FROM employee WHERE id=$1',
      [employeeId],
    )
  )[0]!.version;

async function hire(name: string, roles: readonly string[], status: 'probation' | 'official') {
  const person = await stack.person(roles);
  const { id } = await stack.employees.create(await stack.freshRoot(), {
    code: `R${String(++sequence).padStart(3, '0')}`,
    fullName: `Người gửi giả ${sequence}`,
    hiredOn: '2026-01-05',
    status,
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

const isWorkweek = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

let cursor = 1;

/** `n` unused Monday–Friday business dates after today, all in one calendar year. */
async function days(n: number): Promise<string[]> {
  const found: string[] = [];
  while (found.length < n) {
    const date = await stack.day(cursor++);
    if (!isWorkweek(date)) continue;
    if (found[0] && found[0].slice(0, 4) !== date.slice(0, 4)) found.length = 0;
    found.push(date);
  }
  return found;
}

const key = () => randomUUID();

const late = (date: string, expectedMinute = 600, teamId: string | null = null) =>
  ({
    kind: 'late-arrival',
    teamId,
    reason: 'Đưa con đi khám',
    date,
    expectedMinute,
  }) as const satisfies SubmitRequestInput;

const leave = (
  date: string,
  startMinute = 540,
  endMinute = 780,
  kind: 'annual-leave' | 'unpaid-leave' = 'annual-leave',
) =>
  ({
    kind,
    teamId: null,
    reason: 'Việc gia đình',
    segments: [{ date, startMinute, endMinute }],
  }) as const satisfies SubmitRequestInput;

const wfh = (...dates: string[]) =>
  ({
    kind: 'wfh',
    teamId: null,
    reason: 'Làm tại nhà',
    dates,
  }) as const satisfies SubmitRequestInput;

const submit = (name: string, input: SubmitRequestInput, idempotencyKey = key()) =>
  stack.workRequests.submit(p(name).secret, idempotencyKey, input);

const invalid = (reason: string) => (error: unknown) =>
  error instanceof ProductInvalidRequest && error.message === reason;

/** The HTTP answer (filter) is `{ statusCode: status, code }` for exactly these two fields. */
const refused = (code: string, status: number) => (error: unknown) =>
  error instanceof ApiRejection && error.code === code && error.status === status;

const setDay = async (body: { holiday: string | null } | { makeup: boolean }, date: string) => {
  const [row] = await stack.migration.query<{ version: string }[]>(
    'SELECT version::text AS version FROM work_calendar WHERE id=$1',
    [WORK_CALENDAR_ID],
  );
  assert.ok(
    await stack.workCalendar.setDay(p('H').fresh, {
      expectedVersion: row!.version,
      date,
      ...body,
    }),
  );
};

before(async () => {
  stack = await startHrStack();
  for (const [name, roles, status] of [
    ['E1', ['hr.employee'], 'official'],
    ['E2', ['hr.employee'], 'official'],
    ['R3', ['hr.employee'], 'official'],
    ['P1', ['hr.employee'], 'probation'],
    ['L1', ['hr.employee'], 'official'],
    ['C', ['hr.employee', 'hr.coo'], 'official'],
    ['H', ['hr.employee', 'hr.admin'], 'official'],
  ] as const)
    await hire(name, roles, status);
  people.U = await stack.person(['hr.employee']);
  people.N = await stack.person([]);
  for (const name of ['T1', 'T2', 'T3'])
    teams[name] = (await stack.teams.create(await stack.freshRoot(), { name })).id;
  for (const name of ['E1', 'E2', 'R3', 'P1', 'L1']) await member('T1', name, true);
  for (const name of ['C', 'H']) await member('T2', name, true);
  await member('T2', 'E1', false);
  assert.ok(
    await stack.teams.assignLead(await stack.freshRoot(), {
      teamId: teams.T1!,
      employeeId: employeeOf('L1'),
    }),
  );
});

after(() => stack?.stop());

test('submit: owner and team from the session, pending_lead v1, segments, history and an ids-only audit; no leave effect (B-01, C-22)', async () => {
  const [date] = await days(1);
  const before = await totals();
  const result = await submit('E1', leave(date!));
  assert.ok(result);
  assert.deepEqual(
    { state: result.state, version: result.version },
    {
      state: 'pending_lead',
      version: '1',
    },
  );
  const [row] = await stack.migration.query<Record<string, string>[]>(
    `SELECT employee_id::text AS employee, owner_account_id::text AS owner, team_id::text AS team,
            kind, state, version::text AS version, reason
       FROM work_request WHERE id = $1`,
    [result.id],
  );
  assert.deepEqual(row, {
    employee: employeeOf('E1'),
    owner: p('E1').id,
    team: teams.T1,
    kind: 'annual-leave',
    state: 'pending_lead',
    version: '1',
    reason: 'Việc gia đình',
  });
  assert.deepEqual(await totals(), {
    ...before,
    requests: before.requests + 1,
    segments: before.segments + 1,
    claims: before.claims + 1,
    objects: before.objects + 1,
    audits: before.audits + 1,
  });
  // Audit: actor/permission/target ids only, no reason text or dates (plan, ADR 0016).
  const [audit] = await stack.migration.query<{ payload: string }[]>(
    `SELECT row_to_json(a)::text AS payload FROM audit_outbox a
      WHERE convert_from(event_kind,'UTF8') = 'hr.request.submit' ORDER BY occurred_at DESC LIMIT 1`,
  );
  const payload = audit?.payload ?? '';
  assert.ok(payload.includes(result.id));
  for (const secret of ['Việc gia đình', date!, 'annual']) assert.ok(!payload.includes(secret));
  // No leave effect at submit (requirement §4.3): no decision, the rate rows are untouched.
  assert.equal(
    await count('SELECT count(*)::text AS n FROM request_decision WHERE request_id = $1', [
      result.id,
    ]),
    0,
  );
  const detail = await stack.workRequests.detail(p('E1').secret, result.id);
  assert.deepEqual(detail && { ...detail, createdAt: typeof detail.createdAt }, {
    id: result.id,
    employeeId: employeeOf('E1'),
    teamId: teams.T1,
    kind: 'annual-leave',
    state: 'pending_lead',
    version: '1',
    reason: 'Việc gia đình',
    createdAt: 'string',
    segments: [{ date, startMinute: 540, endMinute: 780, minutes: 240 }],
    decisions: [],
  });
  // A chosen team must be a current team of the submitter (C-21, C-23).
  const [other, third] = await days(2);
  const chosen = await submit('E1', late(other!, 600, teams.T2));
  assert.equal((await stack.workRequests.detail(p('E1').secret, chosen!.id))?.teamId, teams.T2);
  // The key says only "not one of your current teams": an existing team the caller is not in and
  // an id that exists nowhere give the same answer (no existence leak), and nothing is written.
  const before2 = await totals();
  const answers = [];
  for (const teamId of [teams.T3!, randomUUID()]) {
    const error: unknown = await submit('E1', late(third!, 600, teamId)).then(
      () => assert.fail('submitted'),
      (reason: unknown) => reason,
    );
    assert.ok(refused('error.teamNotMember', 422)(error));
    answers.push(error instanceof ApiRejection && [error.status, error.code, error.message]);
  }
  assert.deepEqual(answers[0], answers[1]);
  assert.deepEqual(await totals(), before2);
});

test('lead of the chosen team skips the lead step with a system decision; the COO’s own request is approved at submit (C-07, C-26)', async () => {
  const [a, b] = await days(2);
  const lead = await submit('L1', late(a!));
  assert.equal(lead?.state, 'pending_final');
  assert.deepEqual(
    (await stack.workRequests.detail(p('L1').secret, lead.id))?.decisions.map((d) => ({
      ...d,
      decidedAt: typeof d.decidedAt,
    })),
    [
      {
        stage: 'lead',
        decision: 'skip',
        actorKind: 'system',
        systemReason: 'lead_skipped_submitter_is_lead',
        reason: null,
        decidedAt: 'string',
      },
    ],
  );
  // The system decision is no user decision: it does not make L1 a decider of their own request.
  assert.equal(
    await count('SELECT count(*)::text AS n FROM hr_request_decider WHERE request_id = $1', [
      lead.id,
    ]),
    0,
  );
  // §6.4 (1), T8 part B: the COO's own request is approved at submit (effects: hrm-coo-submit).
  const own = await submit('C', late(b!));
  assert.deepEqual(
    { state: own?.state, version: own?.version },
    { state: 'approved', version: '1' },
  );
});

test('probation is rechecked per day from the status periods: annual and WFH refused, late/early/unpaid accepted (§4.5, B-02..B-06)', async () => {
  const [d1, d2, d3, d4, d5, official] = await days(6);
  const before = await totals();
  for (const input of [leave(d1!, 540, 1080), wfh(d1!)])
    await assert.rejects(submit('P1', input), refused('error.kindNotAllowedInProbation', 422));
  assert.deepEqual(await totals(), before);
  assert.equal((await submit('P1', late(d1!)))?.state, 'pending_lead');
  assert.equal(
    (await submit('P1', { ...late(d2!, 1020), kind: 'early-departure' }))?.state,
    'pending_lead',
  );
  assert.equal((await submit('P1', leave(d3!, 540, 1080, 'unpaid-leave')))?.state, 'pending_lead');
  // HR confirms official from a later date: days before it stay probation (B-06), from it annual is fine.
  assert.ok(
    await stack.employees.confirmOfficial(p('H').secret, {
      employeeId: employeeOf('P1'),
      effectiveOn: official!,
    }),
  );
  await assert.rejects(
    submit('P1', wfh(d4!, d5!, official!)),
    refused('error.kindNotAllowedInProbation', 422),
  );
  // The status rule only: leave from the first official day (its entitlement is T7's: a month
  // counts when official on its 15th, so this grants the minutes instead of depending on the date).
  await stack.migration.query(
    `INSERT INTO leave_ledger(id, employee_id, entry_kind, effective_on, minutes, reference)
     VALUES (gen_random_uuid(), $1, 'opening', CAST($2 AS date), 5760, 'import:cấp-thử-trạng-thái')`,
    [employeeOf('P1'), `${official!.slice(0, 4)}-01-01`],
  );
  assert.equal((await submit('P1', leave(official!, 540, 1080)))?.state, 'pending_lead');
});

test('calendar and D06 bounds: weekends, paid holidays and leave on makeup days refused; inclusive [today − 7, today + 90]', async () => {
  const [holiday] = await days(1);
  await setDay({ holiday: 'Ngày lễ giả T5' }, holiday!);
  for (const input of [late(holiday!), leave(holiday!), wfh(holiday!)])
    await assert.rejects(submit('E2', input), refused('error.nonWorkingDay', 422));
  // First Saturday after the cursor: a weekend unless HR marks it a makeup day.
  let saturday = '';
  for (let offset = cursor; !saturday; offset++) {
    const date = await stack.day(offset);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 6) saturday = date;
  }
  await assert.rejects(submit('E2', late(saturday)), refused('error.nonWorkingDay', 422));
  await setDay({ makeup: true }, saturday);
  await assert.rejects(submit('E2', leave(saturday)), refused('error.makeupDay', 422));
  assert.equal((await submit('E2', late(saturday)))?.state, 'pending_lead');
  // Bounds on the DB business date (Asia/Ho_Chi_Minh); a weekend edge is made a makeup day so the
  // late arrival is valid apart from its date.
  for (const offset of [-8, -7, 90, 91]) {
    const date = await stack.day(offset);
    if (!isWorkweek(date)) await setDay({ makeup: true }, date);
    const attempt = submit('E2', late(date, 1000));
    if (offset === -8 || offset === 91)
      await assert.rejects(attempt, refused('error.dateOutOfRange', 422));
    else assert.equal((await attempt)?.state, 'pending_lead');
  }
  // B-17: never across a calendar year (checked before the date bounds).
  const year = Number((await stack.day(0)).slice(0, 4));
  const before = await totals();
  for (const input of [
    wfh(`${year}-12-31`, `${year + 1}-01-04`),
    {
      ...leave(`${year}-12-31`, 540, 1080, 'unpaid-leave'),
      segments: [
        { date: `${year}-12-31`, startMinute: 540, endMinute: 1080 },
        { date: `${year + 1}-01-04`, startMinute: 540, endMinute: 1080 },
      ],
    },
  ])
    await assert.rejects(submit('E2', input), refused('error.crossesYear', 422));
  // Rules without their own key stay the generic invalid request (HTTP 400): a time outside a
  // shift or a non-slot interval (fixed rules on the input alone).
  const [plain] = await days(1);
  await assert.rejects(submit('E2', late(plain!, 800)), invalid('invalid_time'));
  await assert.rejects(submit('E2', leave(plain!, 600, 720)), invalid('invalid_slot'));
  assert.deepEqual(await totals(), before);
});

test('overlap with pending/approved requests under the employee lock; late/early on a WFH day allowed; cancelled frees the time (D05, D06, B-12, B-19, B-20)', async () => {
  const [x, y] = await days(2);
  const morning = await submit('E2', leave(x!, 540, 780));
  const before = await totals();
  await assert.rejects(submit('E2', leave(x!, 660, 780)), refused('error.overlappingRequest', 409));
  await assert.rejects(submit('E2', late(x!, 600)), refused('error.overlappingRequest', 409));
  assert.deepEqual(await totals(), before);
  assert.ok(await submit('E2', leave(x!, 960, 1080, 'unpaid-leave')));
  assert.ok(await submit('E2', late(x!, 900)));
  // B-20: one late arrival per day even without crossing times.
  await assert.rejects(submit('E2', late(x!, 1000)), refused('error.overlappingRequest', 409));
  // B-19: WFH day.
  assert.ok(await submit('E2', wfh(y!)));
  assert.ok(await submit('E2', late(y!, 600)));
  assert.ok(await submit('E2', { ...late(y!, 1020), kind: 'early-departure' }));
  await assert.rejects(
    submit('E2', leave(y!, 840, 1080)),
    refused('error.overlappingRequest', 409),
  );
  // An approved request blocks too; a cancelled or rejected one no longer does (fixture state).
  await stack.migration.query(`UPDATE work_request SET state = 'approved' WHERE id = $1`, [
    morning!.id,
  ]);
  await assert.rejects(submit('E2', leave(x!, 540, 660)), refused('error.overlappingRequest', 409));
  await stack.migration.query(`UPDATE work_request SET state = 'cancelled' WHERE id = $1`, [
    morning!.id,
  ]);
  assert.ok(await submit('E2', leave(x!, 540, 660)));
  // Another employee's requests never conflict.
  assert.ok(await submit('E1', leave(x!, 540, 780)));
});

/**
 * Barrier for two submits on two pool connections: a superuser transaction holds the calendar
 * anchor FOR UPDATE, which every submit needs FOR SHARE after the employee lock. Both attempts
 * start, and only when two data-login backends wait on a lock (one on the calendar, the other on
 * the employee row — or both on the calendar if the employee lock were missing) is it released,
 * well inside the runner's 1 s lock timeout. So both transactions are in flight at once.
 */
async function raced<T>(attempts: () => readonly Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
  const blocker = await openClient(stack.postgres.superuser);
  const watcher = await openClient(stack.postgres.superuser);
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM work_calendar WHERE id = $1 FOR UPDATE', [WORK_CALENDAR_ID]);
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
        throw new Error('Barrier not reached: the two submits were never in flight together');
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

test('two overlapping submits in flight at once on two connections: exactly one commits (B-13)', async () => {
  const [date] = await days(1);
  const before = await totals();
  const results = await raced(() => [
    submit('R3', leave(date!, 540, 780)),
    submit('R3', leave(date!, 660, 780, 'unpaid-leave')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.ok(failed && refused('error.overlappingRequest', 409)(failed.reason));
  assert.equal((await totals()).requests, before.requests + 1);
});

test('idempotent retry: same key and payload replay the stored result, another payload is refused, a revoked submitter gets nothing (B-10, B-11, C-19)', async () => {
  const [a, b] = await days(2);
  const k = key();
  const first = await submit('R3', late(a!), k);
  const before = await totals();
  assert.deepEqual(await submit('R3', late(a!), k), first);
  assert.deepEqual(await totals(), before);
  await assert.rejects(submit('R3', late(a!, 601), k), refused('error.idempotencyKeyReused', 422));
  await assert.rejects(submit('R3', late(b!), k), refused('error.idempotencyKeyReused', 422));
  // Keys are per account: another submitter's key space is separate.
  assert.ok(await submit('E1', late(b!), k));
  // Concurrent retries with one key (timeout + click again, H-03): one request, same result.
  const k2 = key();
  const [one, two] = await raced(() => [submit('R3', wfh(b!), k2), submit('R3', wfh(b!), k2)]);
  assert.ok(one?.status === 'fulfilled' && two?.status === 'fulfilled');
  assert.deepEqual(one.value, two.value);
  assert.equal(
    await count('SELECT count(*)::text AS n FROM hr_idempotency WHERE key = $1', [k2]),
    1,
  );
  // C-19: the replay rechecks the permission now; without the role the request is not found.
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `DELETE FROM user_role WHERE user_id = $1 AND role_key = convert_to('hr.employee','UTF8')`,
      [p('R3').id],
    ),
  );
  assert.equal(await submit('R3', late(a!), k), undefined);
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `INSERT INTO user_role(user_id, role_key) VALUES ($1, convert_to('hr.employee','UTF8'))`,
      [p('R3').id],
    ),
  );
  assert.deepEqual(await submit('R3', late(a!), k), first);
});

test('owner spoof and unauthorized callers: no profile, no role and Root reach nothing; a foreign employee target is not found (B-09, B-14)', async () => {
  const [date] = await days(1);
  const before = await totals();
  assert.equal(await submit('U', late(date!)), undefined);
  assert.equal(await submit('N', late(date!)), undefined);
  assert.equal(
    await stack.workRequests.submit(await stack.freshRoot(), key(), late(date!)),
    undefined,
  );
  // Rule-violating bodies reveal nothing to them either: absent profile is 404, never a 422 key.
  const year = Number((await stack.day(0)).slice(0, 4));
  assert.ok(teams.T3);
  const violating = [
    wfh(`${year}-12-31`, `${year + 1}-01-04`),
    late(date!, 600, teams.T3),
    late(date!, 600, randomUUID()),
  ];
  for (const input of violating) {
    assert.equal(await submit('U', input), undefined);
    assert.equal(await submit('N', input), undefined);
    assert.equal(await stack.workRequests.submit(await stack.freshRoot(), key(), input), undefined);
  }
  // Even a command call naming another employee is matched against `selfEmployee` on the row.
  const spoof = {
    employeeId: employeeOf('E2'),
    key: key(),
    hash: '0'.repeat(64),
    request: late(date!),
  };
  assert.equal(
    await stack.authorization.execute(p('E1').secret, stack.hr.submitRequest, spoof),
    undefined,
  );
  assert.equal(
    await stack.authorization.execute(p('H').secret, stack.hr.submitRequest, spoof),
    undefined,
  );
  // Root's attempt leaves an access.* event (ADR 0012), never a submit.
  assert.deepEqual(await totals(), before);
  // HR submits for itself only.
  const own = await submit('H', late(date!));
  assert.equal(
    (
      await stack.migration.query<{ e: string }[]>(
        'SELECT employee_id::text AS e FROM work_request WHERE id = $1',
        [own!.id],
      )
    )[0]?.e,
    employeeOf('H'),
  );
  // A deny rule on the submit permission wins over the grant: not found, nothing written.
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
       VALUES ($1, convert_to('employee.submitRequest','UTF8'), $2, 'deny', convert_to('allEmployees','UTF8'), 1, '{}', 'runtime')`,
      [randomUUID(), p('E2').id],
    ),
  );
  try {
    const [later] = await days(1);
    const denied = await totals();
    assert.equal(await submit('E2', late(later!)), undefined);
    assert.deepEqual(await totals(), denied);
  } finally {
    await stack.runner.run('admin', (tx) =>
      tx.manager.query(
        `DELETE FROM policy_rule WHERE user_id = $1 AND permission_key = convert_to('employee.submitRequest','UTF8')`,
        [p('E2').id],
      ),
    );
  }
});

test('my requests: scoped before pagination; detail of foreign and absent requests is the same not found', async () => {
  const mine = await stack.workRequests.list(p('E1').secret, { limit: 100, offset: 0 });
  const owned = await count('SELECT count(*)::text AS n FROM work_request WHERE employee_id = $1', [
    employeeOf('E1'),
  ]);
  assert.ok(owned >= 3);
  assert.equal(mine.total, String(owned));
  assert.equal(mine.items.length, owned);
  assert.ok(owned < (await count('SELECT count(*)::text AS n FROM work_request')));
  // Newest first; a page is cut from the scoped set, its total is not the company's.
  const page = await stack.workRequests.list(p('E1').secret, { limit: 1, offset: 1 });
  assert.equal(page.total, String(owned));
  assert.deepEqual(page.items, [mine.items[1]]);
  const first = mine.items[0]!;
  assert.deepEqual(Object.keys(first).sort(), [
    'createdAt',
    'endDate',
    'id',
    'kind',
    'minutes',
    'startDate',
    'state',
    'teamId',
    'version',
  ]);
  // Lead and HR read E1's request (read scope), but it is not in their own list.
  assert.equal((await stack.workRequests.detail(p('L1').secret, first.id))?.id, first.id);
  assert.equal((await stack.workRequests.detail(p('H').secret, first.id))?.id, first.id);
  for (const name of ['L1', 'H'])
    assert.ok(
      !(await stack.workRequests.list(p(name).secret, { limit: 100, offset: 0 })).items.some(
        (item) => item.id === first.id,
      ),
    );
  // Another employee, no role, no profile: same as an absent id.
  for (const name of ['E2', 'N', 'U'])
    assert.equal(await stack.workRequests.detail(p(name).secret, first.id), undefined);
  assert.equal(await stack.workRequests.detail(p('E1').secret, randomUUID()), undefined);
  assert.deepEqual(await stack.workRequests.list(p('N').secret, { limit: 20, offset: 0 }), {
    items: [],
    total: '0',
  });
});

test('audit writer failure rolls back the request, segments, claim and object (atomic audit)', async () => {
  const [date] = await days(1);
  const before = await totals();
  const k = key();
  await withClient(stack.postgres.superuser, (client) =>
    client.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(
      submit('E2', wfh(date!), k),
      (error) => !(error instanceof ProductAccessDenied),
    );
  } finally {
    await withClient(stack.postgres.superuser, (client) =>
      client.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.deepEqual(await totals(), before);
  // Nothing was claimed, so the same key now creates the request.
  assert.equal((await submit('E2', wfh(date!), k))?.state, 'pending_lead');
});

test('ACL and CHECKs: runtime appends segments/claims only; slots and kinds hold in the schema', async () => {
  const [date] = await days(1);
  const created = await submit('E1', leave(date!, 840, 1080, 'unpaid-leave'));
  const data = stack.pools.data;
  for (const statement of [
    `UPDATE work_request_segment SET end_minute = 960 WHERE request_id = '${created!.id}'`,
    `DELETE FROM work_request_segment WHERE request_id = '${created!.id}'`,
    `UPDATE work_request SET reason = 'x' WHERE id = '${created!.id}'`,
    `UPDATE work_request SET kind = 'wfh' WHERE id = '${created!.id}'`,
    `DELETE FROM hr_idempotency`,
    `UPDATE hr_idempotency SET result = '{}'`,
    'DELETE FROM work_request',
  ])
    assert.equal(await sqlState(data.query(statement)), '42501', statement);
  assert.equal(
    await sqlState(
      stack.pools.authority.query(
        `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
         VALUES ($1,'unpaid-leave',CAST($2 AS date),540,660,120)`,
        [created!.id, date],
      ),
    ),
    '42501',
  );

  const insert = (kind: string, start: number, end: number, minutes: number, day = date) =>
    sqlState(
      stack.migration.query(
        `INSERT INTO work_request_segment(request_id,kind,work_date,start_minute,end_minute,minutes)
         VALUES ($1,$2,CAST($3 AS date),$4,$5,$6)`,
        [created!.id, kind, day, start, end, minutes],
      ),
    );

  // 10–12 is no slot, a slot with the wrong minutes, WFH half day, late outside a shift.
  const other = await stack.day(-3);
  for (const [kind, start, end, minutes] of [
    ['unpaid-leave', 600, 720, 120],
    ['unpaid-leave', 540, 1080, 540],
    ['unpaid-leave', 540, 660, 60],
  ] as const)
    assert.equal(await insert(kind, start, end, minutes, other), '23514');
  // The segment kind must be the request's kind (composite FK).
  assert.equal(await insert('wfh', 540, 1080, 480, other), '23503');
  // One segment per request and date.
  assert.equal(await insert('unpaid-leave', 540, 660, 120), '23505');
  assert.equal(
    await sqlState(
      stack.migration.query(`UPDATE work_request SET reason = '' WHERE id = $1`, [created!.id]),
    ),
    '23514',
  );
  assert.equal(
    await sqlState(
      stack.migration.query(
        `INSERT INTO hr_idempotency(actor_id,operation,key,payload_hash,target_id,result)
         VALUES ($1,'workRequest.edit',$2,$3,$4,'{}')`,
        [p('E1').id, randomUUID(), 'a'.repeat(64), created!.id],
      ),
    ),
    '23514',
  );
});

test('teamNotMember: no primary team and an ended membership answer like an unknown team id, nothing written', async () => {
  await hire('G1', ['hr.employee'], 'official');
  await hire('G2', ['hr.employee'], 'official');
  await member('T1', 'G2', true);
  await member('T2', 'G2', false);
  assert.ok(
    await stack.teams.endMembership(await stack.freshRoot(), {
      teamId: teams.T2!,
      employeeId: employeeOf('G2'),
    }),
  );
  const [date] = await days(1);
  const before = await totals();
  const answers = [];
  for (const [name, teamId] of [
    ['G1', null], // no team at all, so no primary team to default to
    ['G2', teams.T2!], // ended membership
    ['G2', randomUUID()],
  ] as const) {
    const error: unknown = await submit(name, late(date!, 600, teamId)).then(
      () => assert.fail('submitted'),
      (reason: unknown) => reason,
    );
    assert.ok(refused('error.teamNotMember', 422)(error));
    answers.push(error instanceof ApiRejection && [error.status, error.code, error.message]);
  }
  assert.deepEqual(answers[0], answers[2]);
  assert.deepEqual(answers[1], answers[2]);
  assert.deepEqual(await totals(), before);
});

test('keyed rejections write nothing: nonWorkingDay, makeupDay, dateOutOfRange, idempotencyKeyReused leave requests, segments and claims unchanged', async () => {
  const [weekday] = await days(1);
  let saturday = '';
  for (let offset = cursor; !saturday; offset++) {
    const date = await stack.day(offset);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 6) saturday = date;
  }
  await setDay({ holiday: 'Ngày lễ giả T5b' }, weekday!);
  const k = key();
  const [ok] = await days(1);
  assert.ok(await submit('E2', late(ok!), k));
  const before = await totals();
  await assert.rejects(submit('E2', late(weekday!)), refused('error.nonWorkingDay', 422));
  await assert.rejects(submit('E2', late(saturday)), refused('error.nonWorkingDay', 422));
  await assert.rejects(
    submit('E2', late(await stack.day(-8), 1000)),
    refused('error.dateOutOfRange', 422),
  );
  await assert.rejects(
    submit('E2', late(await stack.day(91), 1000)),
    refused('error.dateOutOfRange', 422),
  );
  await assert.rejects(submit('E2', late(ok!, 601), k), refused('error.idempotencyKeyReused', 422));
  assert.deepEqual(await totals(), before);
  await setDay({ makeup: true }, saturday);
  const afterMakeup = await totals();
  await assert.rejects(submit('E2', leave(saturday)), refused('error.makeupDay', 422));
  assert.deepEqual(await totals(), afterMakeup);
});
