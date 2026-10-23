import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { HR_COMPANY_ID } from '../dist/modules/hr/helpers/hr-database.helper.js';
import { HrObjectRepository } from '../dist/modules/hr/repositories/hr-object.repository.js';
import type { EmployeeCreateInput } from '../dist/modules/employee/employee.types.js';
import type { UserId } from '../dist/authorization/core/authorization.types.js';
import { sqlState } from './setup-postgres.ts';
import { type HrPerson, type HrStack, startHrStack } from './hrm-stack.helper.ts';

// Synthetic people only (docs/hrm-acceptance.md style). H = HR/Admin, C = COO, L = lead of team
// T with member E, X outside T, N signed in without any HR role.
let stack: HrStack;
let root: string;
const people: Record<string, HrPerson & { employee?: string }> = {};
let team: string;
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

const noIdentity = {
  dateOfBirth: null,
  documentKind: null,
  documentNumber: null,
  taxCode: null,
  gender: null,
  phone: null,
  workEmail: null,
};

const input = (overrides: Partial<EmployeeCreateInput> = {}): EmployeeCreateInput => ({
  code: `NV${String(++sequence).padStart(3, '0')}`,
  fullName: `Nhân viên giả ${sequence}`,
  hiredOn: '2026-01-05',
  status: 'probation',
  annualLeaveMinutes: 5760,
  identity: noIdentity,
  position: null,
  classification: null,
  ...overrides,
});

const versionOf = async (employeeId: string) =>
  (
    await stack.migration.query<{ version: string }[]>(
      'SELECT version::text AS version FROM employee WHERE id=$1',
      [employeeId],
    )
  )[0]!.version;

async function link(name: string): Promise<void> {
  const employee = employeeOf(name);
  const linked = await stack.employees.linkAccount(await stack.freshRoot(), {
    employeeId: employee,
    expectedVersion: await versionOf(employee),
    accountId: p(name).id,
  });
  assert.ok(linked, `link ${name}`);
}

const auditKinds = async (since: string) =>
  (
    await stack.migration.query<{ kind: string; metadata: Record<string, string> }[]>(
      `SELECT convert_from(event_kind,'UTF8') AS kind, safe_metadata AS metadata FROM audit_outbox
        WHERE occurred_at > CAST($1 AS timestamptz) ORDER BY occurred_at`,
      [since],
    )
  ).map((row) => row);

const now = async () =>
  (
    await stack.migration.query<{ now: string }[]>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    )
  )[0]!.now;

before(async () => {
  stack = await startHrStack();
  root = await stack.freshRoot();
  for (const [name, roles] of [
    ['H', ['hr.employee', 'hr.admin']],
    ['C', ['hr.employee', 'hr.coo']],
    ['L', ['hr.employee']],
    ['E', ['hr.employee']],
    ['X', ['hr.employee']],
    ['N', []],
  ] as const)
    people[name] = await stack.person(roles);
  for (const name of ['H', 'C', 'L', 'E', 'X']) {
    const created = await stack.employees.create(
      root,
      input({
        identity:
          name === 'E'
            ? {
                dateOfBirth: '1990-02-28',
                documentKind: 'cccd',
                documentNumber: '001090000001',
                taxCode: '0100000001',
                gender: 'female',
                phone: '0901234567',
                workEmail: 'nhan.vien.e@example.com',
              }
            : noIdentity,
        ...(name === 'E' ? { position: 'Kỹ sư phần mềm', classification: 'fullTime' } : {}),
      }),
    );
    p(name).employee = created.id;
    await link(name);
  }
  team = (await stack.teams.create(root, { name: 'Team T' })).id;
  const assign = await stack.freshRoot();
  for (const name of ['L', 'E'])
    assert.ok(
      await stack.teams.addMember(assign, {
        teamId: team,
        employeeId: employeeOf(name),
        primary: true,
      }),
    );
  assert.ok(await stack.teams.assignLead(assign, { teamId: team, employeeId: employeeOf('L') }));
});

after(async () => {
  await stack?.stop();
});

test('the company anchor is created once and is not registrable by the data login', async () => {
  await stack.runner.run('sync', (tx) => new HrObjectRepository().ensureHrCompany(tx));
  const rows = await stack.migration.query<{ n: string }[]>(
    'SELECT count(*)::text AS n FROM hr_company WHERE id=$1',
    [HR_COMPANY_ID],
  );
  assert.equal(rows[0]?.n, '1');
  for (const type of ['hrCompany', 'account'])
    assert.equal(
      await sqlState(
        stack.pools.data.query('SELECT public.hr_register_object($1,$2)', [type, randomUUID()]),
      ),
      '22023',
      type,
    );
  // The data login cannot write the account link or insert a profile carrying one.
  for (const statement of [
    'UPDATE employee SET account_id=NULL',
    `INSERT INTO employee(id,object_id,code,full_name,hired_on,account_id) VALUES(gen_random_uuid(),gen_random_uuid(),'Z','Z',DATE '2026-01-01',NULL)`,
  ])
    assert.equal(await sqlState(stack.pools.data.query(statement)), '42501', statement);
});

test('HR creates a profile only with fresh auth; duplicates roll back without audit', async () => {
  await assert.rejects(stack.employees.create(p('H').secret, input()), ProductAccessDenied);
  await assert.rejects(stack.employees.create(p('E').fresh, input()), ProductAccessDenied);
  const since = await now();
  const created = await stack.employees.create(
    p('H').fresh,
    input({
      code: 'HR-NEW',
      identity: {
        dateOfBirth: '1995-05-05',
        documentKind: 'cccd',
        documentNumber: '001095000009',
        taxCode: '0100000009',
        gender: 'male',
        phone: '0281234567',
        workEmail: 'hr.new@example.com',
      },
      position: 'Chuyên viên nhân sự',
      classification: 'contractor',
    }),
  );
  const view = await stack.employees.detail(p('H').secret, created.id);
  assert.equal(view?.code, 'HR-NEW');
  assert.deepEqual(view?.periods, [{ status: 'probation', startsOn: '2026-01-05', endsOn: null }]);
  assert.equal(view?.accountId, null);
  assert.equal(view?.position, 'Chuyên viên nhân sự');
  assert.equal(view?.classification, 'contractor');
  // F1 only: no F2/F3 field (gender, phone, workEmail included) reaches the employee projection.
  assert.deepEqual(Object.keys(view ?? {}).sort(), [
    'accountId',
    'classification',
    'code',
    'fullName',
    'hiredOn',
    'id',
    'periods',
    'position',
    'state',
    'teams',
    'terminatedOn',
    'version',
  ]);
  assert.deepEqual(
    (await stack.employees.leaveRates(p('H').secret, created.id)).map((rate) => [
      rate.effectiveFrom,
      rate.annualMinutes,
    ]),
    [['2026-01-05', 5760]],
  );
  const events = await auditKinds(since);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['hr.employee.create'],
  );
  // Audit carries ids and kinds only: no code, name or F2 value.
  const metadata = JSON.stringify(events[0]?.metadata);
  for (const secret of [
    'HR-NEW',
    '001095000009',
    '0100000009',
    '1995-05-05',
    '0281234567',
    'hr.new@example.com',
    'Chuyên viên nhân sự',
  ])
    assert.ok(!metadata.includes(secret), secret);

  const count = async () =>
    (await stack.migration.query<{ n: string }[]>('SELECT count(*)::text AS n FROM employee'))[0]!
      .n;

  const before = await count();
  const duplicates = await now();
  await assert.rejects(
    stack.employees.create(p('H').fresh, input({ code: 'HR-NEW' })),
    ProductCommandRejected,
  );
  await assert.rejects(
    stack.employees.create(
      p('H').fresh,
      input({
        identity: { ...noIdentity, documentKind: 'cccd', documentNumber: '001095000009' },
      }),
    ),
    ProductCommandRejected,
  );
  assert.equal(await count(), before);
  assert.deepEqual(await auditKinds(duplicates), []);
});

test('probation becomes official on its date; termination closes the chain', async () => {
  const hiredOn = await stack.day(-60);
  const later = await stack.day(10);
  const earlier = await stack.day(-10);
  const a = (await stack.employees.create(root, input({ hiredOn }))).id;
  const b = (await stack.employees.create(root, input({ hiredOn }))).id;
  const fresh = p('H').fresh;
  // Official from a future date: still probation today, official from that day (effective date).
  assert.ok(await stack.employees.confirmOfficial(fresh, { employeeId: a, effectiveOn: later }));
  assert.equal((await stack.employees.detail(fresh, a))?.state, 'probation');
  assert.deepEqual((await stack.employees.detail(fresh, a))?.periods, [
    { status: 'probation', startsOn: hiredOn, endsOn: later },
    { status: 'official', startsOn: later, endsOn: null },
  ]);
  assert.ok(await stack.employees.confirmOfficial(fresh, { employeeId: b, effectiveOn: earlier }));
  assert.equal((await stack.employees.detail(fresh, b))?.state, 'official');
  // Twice, before or on the probation start: refused, nothing changed.
  for (const effectiveOn of [later, hiredOn, await stack.day(-61)])
    await assert.rejects(
      stack.employees.confirmOfficial(fresh, { employeeId: b, effectiveOn }),
      ProductCommandRejected,
      effectiveOn,
    );
  await assert.rejects(
    stack.employees.terminate(fresh, { employeeId: b, terminatedOn: await stack.day(-61) }),
    ProductCommandRejected,
  );
  assert.ok(
    await stack.employees.terminate(fresh, { employeeId: b, terminatedOn: await stack.day(-1) }),
  );
  const ended = await stack.employees.detail(fresh, b);
  assert.equal(ended?.state, 'terminated');
  assert.equal(ended?.periods.at(-1)?.endsOn, await stack.day(0));
  for (const attempt of [
    () => stack.employees.terminate(fresh, { employeeId: b, terminatedOn: later }),
    () => stack.employees.confirmOfficial(fresh, { employeeId: b, effectiveOn: later }),
  ])
    await assert.rejects(attempt(), ProductCommandRejected);
  // Without update scope a record is not found (404), like an absent id.
  assert.equal(
    await stack.employees.confirmOfficial(p('E').fresh, { employeeId: a, effectiveOn: later }),
    undefined,
  );
  assert.equal(
    await stack.employees.terminate(fresh, { employeeId: randomUUID(), terminatedOn: later }),
    undefined,
  );
});

test('F1 list/detail share one scope per role; F2/F3 only for self and HR (D08)', async () => {
  const visible = async (name: string) => {
    const page = await stack.employees.list(p(name).secret, { limit: 100, offset: 0 });
    assert.equal(page.total, String(page.items.length));
    return page.items.map((item) => item.id);
  };

  const all = (await visible('H')).sort();
  assert.ok(all.length >= 5);
  assert.deepEqual((await visible('C')).sort(), all);
  assert.deepEqual(await visible('E'), [employeeOf('E')]);
  assert.deepEqual((await visible('L')).sort(), [employeeOf('L'), employeeOf('E')].sort());
  assert.deepEqual(await visible('X'), [employeeOf('X')]);
  // No grant: the plan reaches nothing (empty page), not an error that would reveal anything.
  assert.deepEqual(await stack.employees.list(p('N').secret, { limit: 20, offset: 0 }), {
    items: [],
    total: '0',
  });
  // Detail follows the same scope: hidden and absent are the same undefined.
  assert.equal(await stack.employees.detail(p('X').secret, employeeOf('E')), undefined);
  assert.equal(await stack.employees.detail(p('X').secret, randomUUID()), undefined);
  assert.equal((await stack.employees.detail(p('L').secret, employeeOf('E')))?.id, employeeOf('E'));
  // Search narrows inside the scope only.
  const code = (await stack.employees.detail(p('H').secret, employeeOf('E')))!.code;
  assert.deepEqual(
    (await stack.employees.list(p('X').secret, { limit: 20, offset: 0, search: code })).items,
    [],
  );
  assert.deepEqual(
    (await stack.employees.list(p('H').secret, { limit: 20, offset: 0, search: code })).items.map(
      (i) => i.id,
    ),
    [employeeOf('E')],
  );
  assert.deepEqual(
    (await stack.employees.list(p('H').secret, { limit: 20, offset: 0, search: '%' })).items,
    [],
  );

  // F2: own and HR; Lead and COO see none of a member's identity data.
  assert.equal(
    (await stack.employees.identity(p('E').secret, employeeOf('E')))?.documentNumber,
    '001090000001',
  );
  assert.equal(
    (await stack.employees.identity(p('H').secret, employeeOf('E')))?.taxCode,
    '0100000001',
  );
  const own = await stack.employees.identity(p('E').secret, employeeOf('E'));
  assert.deepEqual(
    [own?.gender, own?.phone, own?.workEmail],
    ['female', '0901234567', 'nhan.vien.e@example.com'],
  );
  for (const name of ['L', 'C', 'X'])
    assert.equal(await stack.employees.identity(p(name).secret, employeeOf('E')), undefined, name);
  // F1 extras follow `employee.read`: the lead sees the position, the outsider sees no record.
  assert.equal(
    (await stack.employees.detail(p('L').secret, employeeOf('E')))?.position,
    'Kỹ sư phần mềm',
  );
  assert.equal(await stack.employees.identity(p('N').secret, employeeOf('E')), undefined);
  // F3 alike.
  assert.equal((await stack.employees.leaveRates(p('E').secret, employeeOf('E'))).length, 1);
  for (const name of ['L', 'C', 'X'])
    assert.deepEqual(await stack.employees.leaveRates(p(name).secret, employeeOf('E')), [], name);
});

test('F2 and F3 writes need HR with fresh auth and keep their invariants', async () => {
  const id = employeeOf('X');
  const identity = await stack.employees.identity(p('H').secret, id);
  assert.ok(identity);
  const next = {
    dateOfBirth: '1992-12-31',
    documentKind: 'passport',
    documentNumber: 'B1234567',
    taxCode: null,
    gender: 'other',
    phone: '0912345678',
    workEmail: 'x.fixture@example.com',
  } as const;
  await assert.rejects(
    stack.employees.updateIdentity(p('H').secret, {
      employeeId: id,
      expectedVersion: identity.version,
      identity: next,
    }),
    ProductAccessDenied,
  );
  assert.equal(
    await stack.employees.updateIdentity(p('X').fresh, {
      employeeId: id,
      expectedVersion: identity.version,
      identity: next,
    }),
    undefined,
  );
  const updated = await stack.employees.updateIdentity(p('H').fresh, {
    employeeId: id,
    expectedVersion: identity.version,
    identity: next,
  });
  assert.equal(updated?.version, String(BigInt(identity.version) + 1n));
  const stored = await stack.employees.identity(p('H').secret, id);
  assert.deepEqual(
    [stored?.gender, stored?.phone, stored?.workEmail],
    ['other', '0912345678', 'x.fixture@example.com'],
  );
  await assert.rejects(
    stack.employees.updateIdentity(p('H').fresh, {
      employeeId: id,
      expectedVersion: identity.version,
      identity: next,
    }),
    ProductCommandRejected,
  );
  // Another profile with the same document is a conflict.
  const other = await stack.employees.identity(p('H').secret, employeeOf('C'));
  await assert.rejects(
    stack.employees.updateIdentity(p('H').fresh, {
      employeeId: employeeOf('C'),
      expectedVersion: other!.version,
      identity: { ...next, taxCode: null },
    }),
    ProductCommandRejected,
  );

  await assert.rejects(
    stack.employees.adjustLeaveRate(p('H').secret, {
      employeeId: id,
      effectiveFrom: '2027-01-01',
      annualMinutes: 6240,
    }),
    ProductAccessDenied,
  );
  assert.ok(
    await stack.employees.adjustLeaveRate(p('H').fresh, {
      employeeId: id,
      effectiveFrom: '2027-01-01',
      annualMinutes: 6240,
    }),
  );
  for (const effectiveFrom of ['2027-01-01', '2025-12-31'])
    await assert.rejects(
      stack.employees.adjustLeaveRate(p('H').fresh, {
        employeeId: id,
        effectiveFrom,
        annualMinutes: 6240,
      }),
      ProductCommandRejected,
      effectiveFrom,
    );
  assert.deepEqual(
    (await stack.employees.leaveRates(p('X').secret, id)).map((r) => [
      r.effectiveFrom,
      r.annualMinutes,
    ]),
    [
      ['2027-01-01', 6240],
      ['2026-01-05', 5760],
    ],
  );
  // Below 12 days never reaches the table even through the owner login.
  assert.equal(
    await sqlState(
      stack.migration.query('UPDATE leave_rate SET annual_minutes=5759 WHERE employee_id=$1', [id]),
    ),
    '23514',
  );
});

test('account link: Root only (boundary required), checked targets, scope moves at commit', async () => {
  const fresh = await stack.freshRoot();
  const target = (await stack.employees.create(root, input())).id;
  const account = await stack.person(['hr.employee']);
  // HR holds the grant but no boundary binding exists: denied like any principal outside it.
  await assert.rejects(
    stack.employees.linkAccount(p('H').fresh, {
      employeeId: target,
      expectedVersion: await versionOf(target),
      accountId: account.id,
    }),
    ProductAccessDenied,
  );
  const suspended = await stack.person([]);
  assert.equal(await stack.authorization.suspendUser(await stack.freshRoot(), suspended.id), true);
  for (const [accountId, reason] of [
    [p('E').id, 'already linked elsewhere'],
    [stack.rootId, 'Root and own account'],
    [randomUUID(), 'absent account'],
    [suspended.id, 'suspended account'],
  ] as const)
    await assert.rejects(
      stack.employees.linkAccount(fresh, {
        employeeId: target,
        expectedVersion: await versionOf(target),
        accountId,
      }),
      ProductCommandRejected,
      reason,
    );
  await assert.rejects(
    stack.employees.linkAccount(fresh, {
      employeeId: target,
      expectedVersion: '999',
      accountId: account.id,
    }),
    ProductCommandRejected,
  );
  assert.equal((await stack.employees.me(account.secret)).employee, null);
  const revision = await stack.revision();
  assert.ok(
    await stack.employees.linkAccount(fresh, {
      employeeId: target,
      expectedVersion: await versionOf(target),
      accountId: account.id,
    }),
  );
  assert.equal(await stack.revision(), String(BigInt(revision) + 1n));
  assert.equal((await stack.employees.me(account.secret)).employee?.id, target);
  assert.equal((await stack.employees.identity(account.secret, target))?.employeeId, target);
  assert.ok(
    await stack.employees.linkAccount(fresh, {
      employeeId: target,
      expectedVersion: await versionOf(target),
      accountId: null,
    }),
  );
  assert.equal((await stack.employees.me(account.secret)).employee, null);
  assert.equal(await stack.employees.identity(account.secret, target), undefined);
});

test('no principal moves a link to or from its own account (guard runs for Root too)', async () => {
  const target = (await stack.employees.create(root, input())).id;

  // The command's guard, run as an IAM actor inside the exclusive transaction it would use.
  const attempt = (actor: UserId, accountId: string | null, employeeId: string) =>
    stack.runner.run('admin', async (tx) => {
      const [row] = await tx.manager.query<{ object_id: string; version: string }[]>(
        'SELECT object_id::text, version::text FROM employee WHERE id=$1',
        [employeeId],
      );
      return stack.hr.repositories.employeeCommand.linkAccount.run(
        {
          tx,
          actor: { id: actor, kind: 'iam' },
          permission: 'employee.linkAccount',
          target: { key: employeeId, objectId: row!.object_id },
          reaches: () => Promise.resolve(false),
          audit: () => Promise.resolve(),
        },
        { employeeId, expectedVersion: row!.version, accountId },
      );
    });

  const self = await stack.person(['hr.employee', 'hr.admin']);
  await assert.rejects(attempt(self.id, self.id, target), /self_link/);
  await assert.rejects(attempt(p('E').id, null, employeeOf('E')), /self_link/);
});

test('bootstrap: own profile and display menus per role, nothing for an account without roles', async () => {
  const me = (name: string) => stack.employees.me(p(name).secret);

  assert.deepEqual(await me('E'), {
    employee: {
      id: employeeOf('E'),
      code: (await stack.employees.detail(p('E').secret, employeeOf('E')))!.code,
      fullName: (await stack.employees.detail(p('E').secret, employeeOf('E')))!.fullName,
    },
    // T5: a linked profile with hr.employee may submit requests; T7: and reads its own leave balance; T8: and its own timesheet.
    menus: ['requests', 'teams', 'calendar', 'leave', 'attendance'],
    companyScope: false,
  });
  // T4: every HR role reads the work calendar; T5: every linked profile may submit requests.
  // T6 part C: `approvals` follows the approval right (L leads Team T, C holds hr.coo, Root), no
  // request exists in this file.
  // T7: `leave` for every linked profile (own balance); T8: `attendance` likewise; Root and an unlinked account have none.
  assert.deepEqual((await me('L')).menus, [
    'requests',
    'approvals',
    'employees',
    'teams',
    'calendar',
    'leave',
    'attendance',
  ]);
  // T9 web: `reports` follows any employee.report* action reaching a row (COO and HR, never Lead).
  assert.deepEqual((await me('C')).menus, [
    'requests',
    'approvals',
    'employees',
    'teams',
    'calendar',
    'leave',
    'attendance',
    'reports',
  ]);
  assert.deepEqual((await me('H')).menus, [
    'requests',
    'employees',
    'teams',
    'calendar',
    'leave',
    'attendance',
    'reports',
  ]);
  assert.deepEqual((await me('X')).menus, ['requests', 'calendar', 'leave', 'attendance']);
  assert.deepEqual(await me('N'), { employee: null, menus: [], companyScope: false });
  assert.deepEqual(await stack.employees.me(root), {
    employee: null,
    menus: ['approvals', 'employees', 'teams', 'calendar', 'reports'],
    companyScope: true,
  });
  assert.equal((await me('H')).companyScope, true);
  for (const name of ['L', 'C', 'X']) assert.equal((await me(name)).companyScope, false, name);
  // No F2 value, role key or revision in the bootstrap.
  const text = JSON.stringify(await me('E'));
  for (const leaked of ['001090000001', 'hr.employee', 'revision'])
    assert.ok(!text.includes(leaked), leaked);
});

test('F1 position/classification update with the version; F2 extras stay out of the audit; CHECKs hold', async () => {
  const id = employeeOf('X');
  const detail = await stack.employees.detail(p('H').secret, id);
  assert.ok(detail);
  const since = await now();
  const edit = {
    employeeId: id,
    expectedVersion: detail.version,
    code: detail.code,
    fullName: detail.fullName,
    position: 'Trưởng nhóm',
    classification: 'fullTime',
  } as const;
  assert.equal(await stack.employees.update(p('X').fresh, edit), undefined);
  assert.ok(await stack.employees.update(p('H').fresh, edit));
  const after = await stack.employees.detail(p('H').secret, id);
  assert.deepEqual([after?.position, after?.classification], ['Trưởng nhóm', 'fullTime']);
  // Stale version: the second write with the old version is a conflict.
  await assert.rejects(stack.employees.update(p('H').fresh, edit), ProductCommandRejected);
  assert.ok(
    await stack.employees.update(p('H').fresh, {
      ...edit,
      expectedVersion: after!.version,
      position: null,
      classification: null,
    }),
  );
  assert.equal((await stack.employees.detail(p('H').secret, id))?.position, null);
  const metadata = JSON.stringify((await auditKinds(since)).map((e) => e.metadata));
  assert.ok(!metadata.includes('Trưởng nhóm'));

  // The same rules as the validators, enforced by the owner login too.
  for (const [column, table, value] of [
    ['job_position', 'employee', 'Trưởng\tnhóm'],
    ['job_position', 'employee', ' Trưởng nhóm'],
    ['job_position', 'employee', ''],
    ['job_position', 'employee', 'x'.repeat(101)],
    ['classification', 'employee', 'intern'],
    ['gender', 'employee_identity', 'unknown'],
    ['phone', 'employee_identity', '84901234567'],
    ['phone', 'employee_identity', '090123456'],
    ['work_email', 'employee_identity', 'Upper@example.com'],
    ['work_email', 'employee_identity', 'a@b'],
  ] as const) {
    const key = table === 'employee' ? 'id' : 'employee_id';
    assert.equal(
      await sqlState(
        stack.migration.query(`UPDATE ${table} SET ${column}=$1 WHERE ${key}=$2`, [value, id]),
      ),
      '23514',
      `${column}=${value.slice(0, 12)}`,
    );
  }
  // Phone and work email are not unique: another profile may carry the same values.
  const shared = { phone: '0933333333', mail: 'shared@example.com' };
  for (const key of [employeeOf('L'), employeeOf('C')])
    await stack.migration.query(
      'UPDATE employee_identity SET phone=$1, work_email=$2 WHERE employee_id=$3',
      [shared.phone, shared.mail, key],
    );
});
