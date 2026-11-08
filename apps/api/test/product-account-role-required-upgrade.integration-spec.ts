// A database built before AccountRoleRequired is upgraded by re-running provisioning.
// Every IAM account without a role gets hr.employee with one audit event each, the revision
// advances once, accounts with a role and Root are untouched, the provisioning function moves
// from the data login to the authority login, and a repeat is a no-op.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { DataSource } from 'typeorm';
import {
  productMigrations,
  productDataSourceOptions,
  type ProductDatabasePurpose,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { verifyProductPrivileges } from '../dist/database/services/product-privilege-verify.service.js';
import { AccountRoleRequired1792108800006 } from '../dist/administration/migrations/account-role-required.migration.js';
import {
  PRODUCT_OFFLINE_ACTOR,
  ProductAuditRepository,
} from '../dist/audit/product-audit.repository.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { bootstrapActiveRoot } from './oidc-fixture.helper.ts';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';

const runtime = ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const;
const legacy = productMigrations.filter((m) => m !== AccountRoleRequired1792108800006);

let pg: TestPostgres;
let pools: Record<(typeof runtime)[number], DataSource>;
let passwords: Record<ProductDatabasePurpose, string>;
let runner: ProductTransactionRunner;
const core = createProductAuthorizationCore();
const release = createProductRelease(core);
const issuer = 'https://issuer.fixture';

const sql = <T extends object>(statement: string, values: unknown[] = []) =>
  withClient(pg.superuser, async (c) => (await c.query<T>(statement, values)).rows);

const rolesOf = async (id: string) =>
  (
    await sql<{ role: string }>(
      `SELECT convert_from(role_key,'UTF8') role FROM user_role WHERE user_id=$1 ORDER BY 1`,
      [id],
    )
  ).map((r) => r.role);

const revision = async () =>
  (await sql<{ r: string }>('SELECT revision::text r FROM authz_state'))[0]?.r ?? '';

before(async () => {
  pg = await startPostgres();
  passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(pg.superuser, passwords, legacy);
  pools = {} as typeof pools;
  for (const purpose of runtime)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  const audit = new ProductAuditRepository();
  runner = new ProductTransactionRunner(pools);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: PRODUCT_OFFLINE_ACTOR,
    capabilities: {
      validators: ['fresh@1'],
      obligationHandlers: Object.keys(createProductObligations(audit)),
    },
  }).reconcile(release);
  await sql('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [issuer]);
});

after(async () => {
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await pg?.stop();
});

test('re-running provisioning gives every roleless IAM account hr.employee, audited, once', async () => {
  // Before: the data login provisions, the authority login cannot.
  const early = randomUUID();
  await pools.data
    .query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
      early,
      'early@example.test',
      'https://none.example.test',
      PRODUCT_OFFLINE_ACTOR,
    ])
    .then(
      () => assert.fail('the issuer is not a provider'),
      (error: { code?: string }) => assert.equal(error.code, '22023'),
    );
  const accounts = { pending: randomUUID(), active: randomUUID(), suspended: randomUUID() };
  for (const [state, id] of Object.entries(accounts))
    await sql(`INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,$3)`, [
      id,
      `${state}@example.test`,
      state,
    ]);
  const holder = randomUUID();
  await sql(
    `INSERT INTO app_user(id,email_canonical,state) VALUES($1,'holder@example.test','active')`,
    [holder],
  );
  await sql(`INSERT INTO user_role(user_id,role_key) VALUES($1,convert_to('hr.admin','UTF8'))`, [
    holder,
  ]);
  const { userId: root } = await bootstrapActiveRoot(
    runner,
    release,
    pools.identity,
    'root@example.test',
    {
      issuer,
    },
  );
  const before = await revision();

  await provisionProductDatabase(pg.superuser, passwords, productMigrations);

  for (const id of Object.values(accounts)) assert.deepEqual(await rolesOf(id), ['hr.employee']);
  assert.deepEqual(await rolesOf(holder), ['hr.admin']);
  assert.deepEqual(await rolesOf(root), []);
  const resulting = String(BigInt(before) + 1n);
  assert.equal(await revision(), resulting);
  const events = await sql<{
    actor: string;
    permission: string;
    object: string;
    policy: string;
    metadata: Record<string, string>;
  }>(
    `SELECT actor_id::text actor,convert_from(permission_key,'UTF8') permission,object_id::text object,policy_revision::text policy,safe_metadata metadata
       FROM audit_outbox WHERE event_kind=convert_to('permission.role-assign','UTF8') ORDER BY object_id`,
  );
  assert.deepEqual(
    events,
    Object.values(accounts)
      .sort()
      .map((id) => ({
        actor: PRODUCT_OFFLINE_ACTOR,
        permission: 'account.assignRole',
        object: id,
        policy: before,
        metadata: {
          targetUserId: id,
          resultingRevision: resulting,
          resource: 'account',
          keyKind: 'uuid',
          key: id,
          roleKey: 'hr.employee',
        },
      })),
  );
  await verifyProductPrivileges(pools);
  // After: only the authority login provisions (it also writes the first role).
  const args = [
    randomUUID(),
    'late@example.test',
    'https://none.example.test',
    PRODUCT_OFFLINE_ACTOR,
  ];
  assert.equal(
    await sqlState(pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', args)),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.authority.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', args),
    ),
    '22023',
  );

  // A repeat changes nothing: the migration is applied once.
  await provisionProductDatabase(pg.superuser, passwords, productMigrations);
  assert.equal(await revision(), resulting);
  assert.equal(
    (
      await sql(
        `SELECT 1 FROM audit_outbox WHERE event_kind=convert_to('permission.role-assign','UTF8')`,
      )
    ).length,
    3,
  );
});
