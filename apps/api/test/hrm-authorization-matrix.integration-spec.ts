// HR permission matrix on the wired employee/team commands (T2 regression): boundary-required
// actions per role, deny over a write allow, Root outside IAM, audit atomicity per login and the
// bootstrap following a role revoke without a new session. Release 7: the HR boundary
// `hrAdministration@1` bound per user lets an IAM HR/Admin reach team.assign/employee.linkAccount.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import type { EmployeeCreateInput } from '../dist/employee/employee.types.js';
import { withClient } from './setup-postgres.ts';
import { type HrPerson, type HrStack, startHrStack } from './hrm-stack.helper.ts';

// Synthetic people only. H = HR/Admin (grants, no boundary binding), C = COO, E = employee
// (CEO-like: no extra role), N = signed in without any HR role.
let stack: HrStack;
const people: Record<string, HrPerson & { employee?: string }> = {};
let sequence = 0;

const utf8 = (value: string) => Buffer.from(value, 'utf8');

const p = (name: string) => {
  const person = people[name];
  if (!person) throw new Error(`Unknown fixture person ${name}`);
  return person;
};

const input = (): EmployeeCreateInput => ({
  code: `MX${String(++sequence).padStart(3, '0')}`,
  fullName: `Nhân viên giả ${sequence}`,
  hiredOn: '2026-01-05',
  status: 'official',
  annualLeaveMinutes: 5760,
  identity: { dateOfBirth: null, documentKind: null, documentNumber: null, taxCode: null },
});

const one = async (sql: string, params: unknown[] = []) =>
  (await stack.migration.query<{ v: string | null }[]>(sql, params))[0]?.v ?? null;

const versionOf = async (employeeId: string) =>
  one('SELECT version::text AS v FROM employee WHERE id=$1', [employeeId]);

const auditCount = () => one('SELECT count(*)::text AS v FROM audit_outbox');

const memberships = (teamId: string) =>
  one('SELECT count(*)::text AS v FROM team_membership WHERE team_id=$1', [teamId]);

const accountOf = (employeeId: string) =>
  one('SELECT account_id::text AS v FROM employee WHERE id=$1', [employeeId]);

/** Runtime binding of the HR boundary (no route/CLI writes user_boundary yet, ADR 0027 §9). */
const bindHrBoundary = (user: string, permissions: readonly string[]) =>
  stack.runner.run('admin', async (tx) => {
    for (const permission of permissions)
      await tx.manager.query(
        'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)',
        [user, utf8(permission), utf8('hrAdministration')],
      );
  });

const hrBoundaryPermissions = ['team.assign', 'employee.linkAccount'] as const;

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

/** An HR/Admin linked to an own employee profile (by Root), so self guards can be exercised. */
const linkedHrAdmin = async () => {
  const person = await stack.person(['hr.employee', 'hr.admin']);
  const { id } = await stack.employees.create(await stack.freshRoot(), input());
  assert.ok(
    await stack.employees.linkAccount(await stack.freshRoot(), {
      employeeId: id,
      expectedVersion: (await versionOf(id)) ?? '',
      accountId: person.id,
    }),
  );
  return { ...person, employee: id };
};

before(async () => {
  stack = await startHrStack();
  for (const [name, roles] of [
    ['H', ['hr.employee', 'hr.admin']],
    ['C', ['hr.employee', 'hr.coo']],
    ['E', ['hr.employee']],
    ['N', []],
  ] as const)
    people[name] = await stack.person(roles);
  for (const name of ['H', 'C', 'E']) {
    const { id } = await stack.employees.create(await stack.freshRoot(), input());
    assert.ok(
      await stack.employees.linkAccount(await stack.freshRoot(), {
        employeeId: id,
        expectedVersion: (await versionOf(id)) ?? '',
        accountId: p(name).id,
      }),
    );
    p(name).employee = id;
  }
});

after(async () => {
  await stack?.stop();
});

test('boundary-required actions: no IAM role or session reaches them without a binding; Root does', async () => {
  const team = (await stack.teams.create(await stack.freshRoot(), { name: 'Ma trận' })).id;
  const target = (await stack.employees.create(await stack.freshRoot(), input())).id;
  const account = await stack.person(['hr.employee']);
  const revision = await stack.revision();
  const audits = await auditCount();
  const version = await versionOf(target);

  for (const [name, secret] of [
    ['H plain', p('H').secret],
    ['H fresh', p('H').fresh],
    ['C fresh', p('C').fresh],
    ['E fresh', p('E').fresh],
    ['N fresh', p('N').fresh],
  ] as const) {
    await assert.rejects(
      stack.teams.addMember(secret, { teamId: team, employeeId: target, primary: true }),
      ProductAccessDenied,
      `${name} team.assign`,
    );
    await assert.rejects(
      stack.teams.assignLead(secret, { teamId: team, employeeId: target }),
      ProductAccessDenied,
      `${name} team.assign lead`,
    );
    await assert.rejects(
      stack.employees.linkAccount(secret, {
        employeeId: target,
        expectedVersion: version ?? '',
        accountId: account.id,
      }),
      ProductAccessDenied,
      `${name} employee.linkAccount`,
    );
  }
  // Refusals change no fact, version or audit row.
  assert.equal(await stack.revision(), revision);
  assert.equal(await versionOf(target), version);
  assert.equal(await memberships(team), '0');
  assert.equal(await auditCount(), audits);

  const root = await stack.freshRoot();
  assert.ok(await stack.teams.addMember(root, { teamId: team, employeeId: target, primary: true }));
  assert.ok(
    await stack.employees.linkAccount(root, {
      employeeId: target,
      expectedVersion: version ?? '',
      accountId: account.id,
    }),
  );
  const events = await stack.migration.query<{ kind: string; kindOf: string }[]>(
    `SELECT convert_from(event_kind,'UTF8') AS kind, safe_metadata->>'principalKind' AS "kindOf"
       FROM audit_outbox WHERE actor_id=$1 AND convert_from(event_kind,'UTF8') IN
       ('hr.team.assign','hr.employee.link-account') ORDER BY occurred_at DESC LIMIT 2`,
    [stack.rootId],
  );
  assert.deepEqual(events.map((e) => [e.kind, e.kindOf]).sort(), [
    ['hr.employee.link-account', 'root'],
    ['hr.team.assign', 'root'],
  ]);
});

test('a deny rule wins over the HR write allow; Root stays outside IAM rules', async () => {
  const target = (await stack.employees.create(await stack.freshRoot(), input())).id;
  const rule = randomUUID();
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
      [rule, utf8('employee.update'), p('H').id, utf8('allEmployees')],
    ),
  );
  try {
    const version = (await versionOf(target)) ?? '';
    // Denied like absent: no version bump, no audit.
    const audits = await auditCount();
    assert.equal(
      await stack.employees.update(p('H').fresh, {
        employeeId: target,
        expectedVersion: version,
        code: 'DENIED',
        fullName: 'Bị chặn',
      }),
      undefined,
    );
    assert.equal(await versionOf(target), version);
    assert.equal(await auditCount(), audits);
    // Read is a different permission: the deny on update does not hide the record.
    assert.equal((await stack.employees.detail(p('H').secret, target))?.id, target);
    assert.ok(
      await stack.employees.update(await stack.freshRoot(), {
        employeeId: target,
        expectedVersion: version,
        code: `R${sequence}`,
        fullName: 'Root sửa',
      }),
    );
  } finally {
    await stack.runner.run('admin', (tx) =>
      tx.manager.query('DELETE FROM policy_rule WHERE rule_id=$1', [rule]),
    );
  }
  assert.ok(
    await stack.employees.update(p('H').fresh, {
      employeeId: target,
      expectedVersion: (await versionOf(target)) ?? '',
      code: `H${sequence}`,
      fullName: 'HR sửa',
    }),
  );
});

test('a failing audit writer rolls back wired HR commands on both the data and authority logins', async () => {
  const employees = () => one('SELECT count(*)::text AS v FROM employee');

  const objects = () => one('SELECT count(*)::text AS v FROM object_ref');

  const team = (await stack.teams.create(await stack.freshRoot(), { name: 'Audit lỗi' })).id;
  const target = (await stack.employees.create(await stack.freshRoot(), input())).id;
  const before = {
    employees: await employees(),
    objects: await objects(),
    revision: await stack.revision(),
    audits: await auditCount(),
  };

  const withoutAudit = async (login: string, attempt: () => Promise<unknown>) => {
    await withClient(stack.postgres.superuser, (client) =>
      client.query(`REVOKE INSERT ON audit_outbox FROM ${login}`),
    );
    try {
      await assert.rejects(attempt(), (error) => !(error instanceof ProductAccessDenied));
    } finally {
      await withClient(stack.postgres.superuser, (client) =>
        client.query(`GRANT INSERT ON audit_outbox TO ${login}`),
      );
    }
  };

  // hrCompany.createEmployee runs on the data login (mode write).
  await withoutAudit('product_data', () => stack.employees.create(p('H').fresh, input()));
  // team.assign runs on the authority login (mode admin) and bumps the revision.
  await withoutAudit('product_authority', async () =>
    stack.teams.addMember(await stack.freshRoot(), {
      teamId: team,
      employeeId: target,
      primary: true,
    }),
  );

  assert.deepEqual(
    {
      employees: await employees(),
      objects: await objects(),
      revision: await stack.revision(),
      audits: await auditCount(),
    },
    before,
  );
  assert.equal(await memberships(team), '0');
  // Same commands succeed once the writer works again.
  assert.ok(await stack.employees.create(p('H').fresh, input()));
  assert.ok(
    await stack.teams.addMember(await stack.freshRoot(), {
      teamId: team,
      employeeId: target,
      primary: true,
    }),
  );
});

test('bootstrap follows a role revoke on the same session (no cached menus)', async () => {
  const person = await stack.person(['hr.employee', 'hr.admin']);
  assert.deepEqual(await stack.employees.me(person.secret), {
    employee: null,
    menus: ['employees', 'teams', 'calendar'],
    companyScope: true,
  });
  await stack.runner.run('admin', (tx) =>
    tx.manager.query('DELETE FROM user_role WHERE user_id=$1 AND role_key=$2', [
      person.id,
      utf8('hr.admin'),
    ]),
  );
  assert.deepEqual(await stack.employees.me(person.secret), {
    employee: null,
    // hr.employee remains: the work calendar stays readable (T4).
    menus: ['calendar'],
    companyScope: false,
  });
  await assert.rejects(stack.employees.create(person.fresh, input()), ProductAccessDenied);
});

test('an IAM HR/Admin bound to the HR boundary assigns teams and links accounts, audited per revision', async () => {
  const admin = await linkedHrAdmin();
  await bindHrBoundary(admin.id, hrBoundaryPermissions);
  const team = (await stack.teams.create(await stack.freshRoot(), { name: 'Ranh giới HR' })).id;
  const target = (await stack.employees.create(await stack.freshRoot(), input())).id;
  const account = await stack.person(['hr.employee']);

  // fresh@1 of hrFresh still decides: the binding does not replace the policy.
  const plain = { revision: await stack.revision(), audits: await auditCount() };
  await assert.rejects(
    stack.teams.addMember(admin.secret, { teamId: team, employeeId: target, primary: true }),
    ProductAccessDenied,
  );
  assert.deepEqual({ revision: await stack.revision(), audits: await auditCount() }, plain);

  const revision = BigInt(await stack.revision());
  assert.ok(
    await stack.teams.addMember(admin.fresh, { teamId: team, employeeId: target, primary: true }),
  );
  assert.ok(await stack.teams.assignLead(admin.fresh, { teamId: team, employeeId: target }));
  assert.ok(
    await stack.employees.linkAccount(admin.fresh, {
      employeeId: target,
      expectedVersion: (await versionOf(target)) ?? '',
      accountId: account.id,
    }),
  );
  // Each admin command commits its own fact change and revision.
  assert.equal(BigInt(await stack.revision()), revision + 3n);
  assert.equal(await memberships(team), '1');
  assert.equal(await accountOf(target), account.id);
  const events = await stack.migration.query<{ kind: string; kindOf: string | null }[]>(
    `SELECT convert_from(event_kind,'UTF8') AS kind, safe_metadata->>'principalKind' AS "kindOf"
       FROM audit_outbox WHERE actor_id=$1 ORDER BY occurred_at, event_id`,
    [admin.id],
  );
  assert.deepEqual(events.map((e) => [e.kind, e.kindOf]).sort(), [
    ['hr.employee.link-account', null],
    ['hr.team.assign', null],
    ['hr.team.assign', null],
  ]);
  // The linked account reads its own profile in the next transaction.
  assert.equal((await stack.employees.me(account.secret)).employee?.id, target);
});

test('the HR boundary only limits: no grant, unbound permission, deny, guards and revoke still refuse', async () => {
  const team = (await stack.teams.create(await stack.freshRoot(), { name: 'Chỉ giới hạn' })).id;
  const target = (await stack.employees.create(await stack.freshRoot(), input())).id;
  const account = await stack.person(['hr.employee']);
  const admin = await linkedHrAdmin();
  const bare = await stack.person([]);
  const partial = await stack.person(['hr.employee', 'hr.admin']);
  await bindHrBoundary(admin.id, hrBoundaryPermissions);
  await bindHrBoundary(bare.id, hrBoundaryPermissions);
  await bindHrBoundary(partial.id, ['team.assign']);
  const rule = randomUUID();
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
      [rule, utf8('team.assign'), admin.id, utf8('allTeams')],
    ),
  );

  const link = async (secret: string, accountId: string, employeeId = target) =>
    stack.employees.linkAccount(secret, {
      employeeId,
      expectedVersion: (await versionOf(employeeId)) ?? '1',
      accountId,
    });

  const before = { revision: await stack.revision(), audits: await auditCount() };

  // Bindings are per permission: team.assign bound does not open employee.linkAccount.
  await assert.rejects(link(partial.fresh, account.id), ProductAccessDenied);
  // Code-owned guards hold whatever the boundary says: no self link.
  await assert.rejects(link(admin.fresh, admin.id), rejected('self_link'));
  await assert.rejects(link(admin.fresh, account.id, admin.employee), rejected('self_link'));
  // Refusals roll back: no revision, no audit.
  assert.deepEqual({ revision: await stack.revision(), audits: await auditCount() }, before);

  // A boundary grants nothing: bound without any HR role reaches no record (absent, 404).
  assert.equal(
    await stack.teams.addMember(bare.fresh, { teamId: team, employeeId: target, primary: true }),
    undefined,
  );
  assert.equal(await link(bare.fresh, account.id), undefined);
  // A deny rule wins over grant + boundary (not visible, like absent).
  assert.equal(
    await stack.teams.addMember(admin.fresh, { teamId: team, employeeId: target, primary: true }),
    undefined,
  );
  // Absent targets stay absent for a bound caller.
  assert.equal(await link(admin.fresh, account.id, randomUUID()), undefined);
  // Not-found outcomes commit their admin transaction (revision bump, ADR 0004) but no fact/audit.
  assert.equal(await auditCount(), before.audits);
  assert.equal(await memberships(team), '0');
  assert.equal(await accountOf(target), null);

  await stack.runner.run('admin', (tx) =>
    tx.manager.query('DELETE FROM policy_rule WHERE rule_id=$1', [rule]),
  );
  // Without the deny the same session assigns, but never itself.
  await assert.rejects(
    stack.teams.addMember(admin.fresh, {
      teamId: team,
      employeeId: admin.employee,
      primary: true,
    }),
    rejected('self_assignment'),
  );
  assert.ok(
    await stack.teams.addMember(admin.fresh, { teamId: team, employeeId: target, primary: true }),
  );
  // Revoking the binding closes the action on the same session in the next transaction.
  await stack.runner.run('admin', (tx) =>
    tx.manager.query('DELETE FROM user_boundary WHERE user_id=$1 AND permission_key=$2', [
      admin.id,
      utf8('team.assign'),
    ]),
  );
  await assert.rejects(
    stack.teams.assignLead(admin.fresh, { teamId: team, employeeId: target }),
    ProductAccessDenied,
  );
  assert.ok(await link(admin.fresh, account.id));
});
