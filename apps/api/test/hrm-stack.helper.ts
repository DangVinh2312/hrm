import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId, UserId } from '../dist/authorization/core/authorization.types.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import {
  ProductManifestReconciler,
  bootstrapProductRoot,
} from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { productObligations } from '../dist/authorization/helpers/product-obligations.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  activateAccount,
  bindAccount,
  fixtureProvider,
  FIXTURE_ISSUER,
  oidcSession,
} from './oidc-fixture.helper.ts';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  productMigrations,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import { HrmAuthorization1792108800100 } from '../dist/hr/migrations/hrm-authorization.migration.js';
import { HrmEmployee1792108800101 } from '../dist/employee/migrations/hrm-employee.migration.js';
import { HrmTeam1792108800102 } from '../dist/team/migrations/hrm-team.migration.js';
import { ensureHrCompany } from '../dist/hr/hr-database.helper.js';
import {
  EmployeeService,
  employeeCommands,
  employeeQueries,
} from '../dist/employee/employee.service.js';
import { TeamService, teamCommands, teamQueries } from '../dist/team/team.service.js';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';

/** An IAM account with a plain session and a freshly reauthenticated one (synthetic data). */
export interface HrPerson {
  readonly id: UserId;
  readonly secret: string;
  readonly fresh: string;
}

export interface HrStack {
  readonly postgres: TestPostgres;
  readonly pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
  /** Owner login, for assertions on rows the runtime logins cannot read. */
  readonly migration: DataSource;
  readonly runner: ProductTransactionRunner;
  readonly authorization: ProductAuthorization;
  readonly employees: EmployeeService;
  readonly teams: TeamService;
  readonly rootId: UserId;

  person(roles: readonly string[]): Promise<HrPerson>;

  /** A new Root session with a step-up 5 s ago (write/admin need < 300 s, ADR 0012). */
  freshRoot(): Promise<string>;

  /** Business date `YYYY-MM-DD` today ± days, from the DB clock in Asia/Ho_Chi_Minh. */
  day(offset: number): Promise<string>;

  revision(): Promise<string>;

  stop(): Promise<void>;
}

const utf8 = (value: string) => Buffer.from(value, 'utf8');

const rootEmail = 'root@example.test';

/**
 * Disposable PostgreSQL with every product + HR migration, release 5 synced, the company anchor
 * and an OIDC Root (ADR 0027: Google only). The composition mirrors ProductRuntime: same
 * commands, queries and services.
 */
export async function startHrStack(): Promise<HrStack> {
  const core = createProductAuthorizationCore();
  const release = createProductRelease(core);
  const postgres = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((name) => [
      name,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(postgres.superuser, passwords, [
    ...productMigrations,
    HrmAuthorization1792108800100,
    HrmEmployee1792108800101,
    HrmTeam1792108800102,
  ]);
  const pools = {} as HrStack['pools'];
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  const migration = await new DataSource(
    productDataSourceOptions(connections.migration),
  ).initialize();
  const runner = new ProductTransactionRunner(pools);
  await fixtureProvider(migration);
  await new ProductManifestReconciler(runner, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  await runner.run('sync', (tx) => ensureHrCompany(tx));
  const authorization = new ProductAuthorization(
    runner,
    new ProductBindingRegistry(core, release.declarations, productBindings),
    {
      validators: {
        'fresh@1': (_params, input) => input.context.freshAuthentication === true,
      },
      obligations: productObligations,
    },
    [],
    [...employeeCommands, ...teamCommands],
    [...employeeQueries, ...teamQueries],
  );
  const teams = new TeamService(authorization);
  const employees = new EmployeeService(authorization);

  const rootId = randomUUID() as UserId;
  await migration.query(`INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,'pending')`, [
    rootId,
    rootEmail,
  ]);
  await bindAccount(pools.identity, rootId, 'root-subject');
  const { activationSecret } = await bootstrapProductRoot(runner, release, {
    operationId: randomUUID(),
    userId: rootId,
    method: 'oidc',
    issuer: FIXTURE_ISSUER,
    subject: 'root-subject',
  });
  assert.ok(activationSecret);
  await activateAccount(pools.identity, rootId);

  return {
    postgres,
    pools,
    migration,
    runner,
    authorization,
    employees,
    teams,
    rootId,
    person: async (roles) => {
      const id = randomUUID() as UserId;
      await migration.query(
        `INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`,
        [id],
      );
      await bindAccount(pools.identity, id);
      const secrets = [
        await oidcSession(pools.identity, id),
        await oidcSession(pools.identity, id, { fresh: true }),
      ];
      if (roles.length)
        await runner.run('admin', async (tx) => {
          for (const role of roles)
            await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
              id,
              utf8(role),
            ]);
        });
      return { id, secret: secrets[0]!, fresh: secrets[1]! };
    },
    freshRoot: () => oidcSession(pools.identity, rootId, { fresh: true }),
    day: async (offset) => {
      const [row] = await migration.query<{ day: string }[]>(
        `SELECT to_char((statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + CAST($1 AS int),'YYYY-MM-DD') AS day`,
        [offset],
      );
      return row!.day;
    },
    revision: async () =>
      (
        await migration.query<{ revision: string }[]>(
          'SELECT revision::text AS revision FROM authz_state WHERE singleton',
        )
      )[0]!.revision,
    stop: async () => {
      await migration.destroy();
      for (const pool of Object.values(pools)) await pool.destroy();
      await postgres.stop();
    },
  };
}
