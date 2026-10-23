import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId, UserId } from '../dist/authorization/core/authorization.types.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  productMigrations,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { HrmAuthorization1792108800100 } from '../dist/modules/hr/migrations/hrm-authorization.migration.js';
import { HrmEmployee1792108800101 } from '../dist/modules/employee/migrations/hrm-employee.migration.js';
import { HrmTeam1792108800102 } from '../dist/modules/team/migrations/hrm-team.migration.js';
import { HrmWorkCalendar1792108800103 } from '../dist/modules/work-calendar/migrations/hrm-work-calendar.migration.js';
import { HrmWorkCalendarMakeup1792108800104 } from '../dist/modules/work-calendar/migrations/hrm-work-calendar-makeup.migration.js';
import { HrmEmployeeProfile1792108800105 } from '../dist/modules/employee/migrations/hrm-employee-profile.migration.js';
import { HrmWorkRequest1792108800106 } from '../dist/modules/work-request/migrations/hrm-work-request.migration.js';
import { HrmRequestApproval1792108800107 } from '../dist/modules/work-request/migrations/hrm-request-approval.migration.js';
import { HrmRequestLeadRejected1792108800108 } from '../dist/modules/work-request/migrations/hrm-request-lead-rejected.migration.js';
import { HrmLeave1792108800109 } from '../dist/modules/leave/migrations/hrm-leave.migration.js';
import { HrmAttendance1792108800110 } from '../dist/modules/attendance/migrations/hrm-attendance.migration.js';
import { HrmRequestCancel1792108800111 } from '../dist/modules/work-request/migrations/hrm-request-cancel.migration.js';
import { HrmAttendanceAdjust1792108800112 } from '../dist/modules/attendance/migrations/hrm-attendance-adjust.migration.js';
import { HrObjectRepository } from '../dist/modules/hr/repositories/hr-object.repository.js';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';
import {
  bootstrapActiveRoot,
  bindAccount,
  fixtureProvider,
  oidcSession,
} from './oidc-fixture.helper.ts';
import { submit, commands } from './hrm-authorization-fixture-commands.helper.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

const hrObject = new HrObjectRepository();

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();
const productObligations = createProductObligations(audit);

// Fixture after docs/hrm-acceptance.md (synthetic people only): T1 lead L1 {E1, E2, L1},
// T2 lead L2 {L2, C, X, E1 secondary}, T3 lead L1 {E4, L1 secondary}, T4 without lead {E5}.
export const core = createProductAuthorizationCore();

export const release = createProductRelease(core);

export const validators = {
  'fresh@1': (_params: unknown, input: { context: { freshAuthentication?: unknown } }) =>
    input.context.freshAuthentication === true,
};

export const utf8 = (value: string) => Buffer.from(value, 'utf8');

export let postgres: TestPostgres;

export let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;

export let migration: DataSource;

export let runner: ProductTransactionRunner;

export let bindings: ProductBindingRegistry;

export let authorization: ProductAuthorization;

export interface Person {
  readonly id: UserId;
  readonly secret: string;
  employee: string;
}

export const people: Record<string, Person> = {};

export const teams: Record<string, string> = {};

export const objects = new Map<string, string>();

export const rootEmail = 'root@example.test';

export let rootId: UserId;

export async function addPerson(name: string, roles: readonly string[]): Promise<void> {
  const id = randomUUID() as UserId;
  await migration.query(`INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`, [
    id,
  ]);
  await bindAccount(pools.identity, id);
  const secret = await oidcSession(pools.identity, id);
  await runner.run('admin', async (tx) => {
    for (const role of roles)
      await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
        id,
        utf8(role),
      ]);
  });
  const employee = randomUUID();
  objects.set(
    employee,
    await runner.run('write', (tx) => hrObject.register(tx, 'employee', employee)),
  );
  await migration.query(
    "INSERT INTO employee(id,object_id,code,full_name,account_id,hired_on) VALUES($1,$2,$3,$4,$5,DATE '2026-01-05')",
    [employee, objects.get(employee), `NV-${name}`, `Fixture ${name}`, id],
  );
  people[name] = { id, secret, employee };
}

export const p = (name: string): Person => {
  const person = people[name];
  if (!person) throw new Error(`Unknown fixture person ${name}`);
  return person;
};

export const t = (name: string): string => {
  const team = teams[name];
  if (!team) throw new Error(`Unknown fixture team ${name}`);
  return team;
};

/** A Root session with a step-up 5 s ago, as a 2FA verify leaves it. */
export async function freshRoot(): Promise<string> {
  return oidcSession(pools.identity, rootId, { fresh: true });
}

export const names = (keys: readonly string[], universe: Record<string, string>) =>
  Object.entries(universe)
    .filter(([, key]) => keys.includes(key))
    .map(([name]) => name)
    .sort();

export const employeeKeys = () =>
  Object.fromEntries(Object.entries(people).map(([name, person]) => [name, person.employee]));

export async function visible(person: string, resource: string): Promise<string[]> {
  const page = await authorization.list(p(person).secret, resource, 'read', { limit: 100 });
  assert.equal(await authorization.count(p(person).secret, resource, 'read'), page.total);
  return page.items.map((item) => item.key);
}

export async function submitAs(person: string, team: string, as = person): Promise<string> {
  const result = await authorization.execute(p(as).secret, submit, {
    employeeId: p(person).employee,
    teamId: t(team),
  });
  assert.ok(result, `${as} submits for ${person}`);
  return result.id;
}

export const stateOf = async (id: string) =>
  (
    await migration.query<{ state: string; version: string }[]>(
      'SELECT state,version::text AS version FROM work_request WHERE id=$1',
      [id],
    )
  )[0];

export const revision = async () =>
  (
    await migration.query<{ revision: string }[]>(
      'SELECT revision::text AS revision FROM authz_state WHERE singleton',
    )
  )[0]?.revision;

export let passwords: Record<ProductDatabasePurpose, string>;

export async function setupStack(): Promise<void> {
  postgres = await startPostgres();
  passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((name) => [
      name,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  // The HR migration needs the NOLOGIN object owner, so it runs through provisioning (tools).
  const connections = await provisionProductDatabase(postgres.superuser, passwords, [
    ...productMigrations,
    HrmAuthorization1792108800100,
    HrmEmployee1792108800101,
    HrmTeam1792108800102,
    HrmWorkCalendar1792108800103,
    HrmWorkCalendarMakeup1792108800104,
    HrmEmployeeProfile1792108800105,
    HrmWorkRequest1792108800106,
    HrmRequestApproval1792108800107,
    HrmRequestLeadRejected1792108800108,
    HrmLeave1792108800109,
    HrmAttendance1792108800110,
    HrmRequestCancel1792108800111,
    HrmAttendanceAdjust1792108800112,
  ]);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  await fixtureProvider(migration);
  runner = new ProductTransactionRunner(pools);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  bindings = new ProductBindingRegistry(core, release.declarations, productBindings);
  authorization = new ProductAuthorization(
    runner,
    audit,
    bindings,
    { validators, obligations: productObligations },
    [],
    commands,
  );
  for (const [name, roles] of [
    ['E1', ['hr.employee']],
    ['E2', ['hr.employee']],
    ['L1', ['hr.employee']],
    ['L2', ['hr.employee']],
    ['C', ['hr.employee', 'hr.coo']],
    ['X', ['hr.employee']],
    ['E4', ['hr.employee']],
    ['E5', ['hr.employee']],
    ['H', ['hr.employee', 'hr.admin']],
  ] as const)
    await addPerson(name, roles);
  for (const name of ['T1', 'T2', 'T3', 'T4']) {
    const id = randomUUID();
    objects.set(id, await runner.run('write', (tx) => hrObject.register(tx, 'team', id)));
    await migration.query('INSERT INTO team(id,object_id,name) VALUES($1,$2,$3)', [
      id,
      objects.get(id),
      `Team ${name}`,
    ]);
    teams[name] = id;
  }
  // Facts go through the authority login under the exclusive fence (ADR 0016 §5).
  await runner.run('admin', async (tx) => {
    for (const [person, team, primary] of [
      ['E1', 'T1', true],
      ['E1', 'T2', false],
      ['E2', 'T1', true],
      ['L1', 'T1', true],
      ['L1', 'T3', false],
      ['L2', 'T2', true],
      ['C', 'T2', true],
      ['X', 'T2', true],
      ['E4', 'T3', true],
      ['E5', 'T4', true],
    ] as const)
      await tx.manager.query(
        `INSERT INTO team_membership(id,employee_id,team_id,is_primary,starts_at) VALUES($1,$2,$3,$4,statement_timestamp()-interval '1 minute')`,
        [randomUUID(), p(person).employee, t(team), primary],
      );
    for (const [team, lead] of [
      ['T1', 'L1'],
      ['T2', 'L2'],
      ['T3', 'L1'],
    ] as const)
      await tx.manager.query(
        `INSERT INTO team_lead_assignment(id,team_id,lead_employee_id,starts_at) VALUES($1,$2,$3,statement_timestamp()-interval '1 minute')`,
        [randomUUID(), t(team), p(lead).employee],
      );
  });
  ({ userId: rootId } = await bootstrapActiveRoot(runner, release, pools.identity, rootEmail));
}

export async function teardownStack(): Promise<void> {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
}
