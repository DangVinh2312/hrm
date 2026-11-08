// A database built before AsciiLoginEmail is upgraded by re-running provisioning. A stored email
// outside printable ASCII stops it with 23514 and leaves the schema as it was; once corrected by
// hand, provisioning adds both constraints and both definer bodies, which the probe then pins.
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
import { AsciiLoginEmail1792108800008 } from '../dist/administration/migrations/ascii-login-email.migration.js';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';

const runtime = ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const;
const legacy = productMigrations.filter((m) => m !== AsciiLoginEmail1792108800008);
const issuer = 'https://issuer.fixture';

let pg: TestPostgres;
let pools: Record<(typeof runtime)[number], DataSource>;
let passwords: Record<ProductDatabasePurpose, string>;

const sql = <T extends object>(statement: string, values: unknown[] = []) =>
  withClient(pg.superuser, async (c) => (await c.query<T>(statement, values)).rows);

const applied = async () =>
  (
    await sql<{ name: string }>(
      "SELECT name FROM migrations WHERE name='AsciiLoginEmail1792108800008'",
    )
  ).length;

const provision = (email: string) =>
  pools.authority.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
    randomUUID(),
    email,
    issuer,
    PRODUCT_OFFLINE_ACTOR,
  ]);

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
  await sql('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [issuer]);
});

after(async () => {
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await pg?.stop();
});

test('a stored non-ASCII email stops the upgrade; corrected, the upgrade pins ASCII everywhere', async () => {
  await provision('kim@ex\u00e4mple.test');
  await assert.rejects(provisionProductDatabase(pg.superuser, passwords, productMigrations), {
    code: '23514',
    constraint: 'ck_app_user_email_ascii',
  });
  assert.equal(await applied(), 0);
  await provision('i\u0307@example.test');

  await sql(
    `UPDATE app_user SET email_canonical='fixed-'||id||'@example.test',auth_epoch=auth_epoch+1
      WHERE email_canonical !~ '^[!-~]+$'`,
  );
  await assert.rejects(provisionProductDatabase(pg.superuser, passwords, productMigrations), {
    code: '23514',
    constraint: 'ck_oidc_email_enrollment_ascii',
  });
  assert.equal(await applied(), 0);
  await sql(`DELETE FROM oidc_email_enrollment WHERE email_canonical !~ '^[!-~]+$'`);

  await provisionProductDatabase(pg.superuser, passwords, productMigrations);
  assert.equal(await applied(), 1);
  await verifyProductPrivileges(pools);
  assert.equal(await sqlState(provision('kim@ex\u00e4mple.test')), '22023');
  await provision('ascii@example.test');
  assert.deepEqual(
    (
      await sql<{ name: string }>(
        `SELECT conname name FROM pg_constraint WHERE conname IN ('ck_app_user_email_ascii','ck_oidc_email_enrollment_ascii') ORDER BY 1`,
      )
    ).map((row) => row.name),
    ['ck_app_user_email_ascii', 'ck_oidc_email_enrollment_ascii'],
  );
});
