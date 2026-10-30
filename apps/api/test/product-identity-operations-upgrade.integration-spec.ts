// ADR-15 D8/D9: a database built before IdentityOperations is upgraded by re-running provisioning
// (the only path that grants the migration login the temporary owner memberships), and the
// startup probe rejects any drift of the three functions, their owners and their ACLs.
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
import { IdentityOperations1792108800005 } from '../dist/administration/migrations/identity-operations.migration.js';
import {
  changeIamAccountEmailBody,
  resetIamGoogleBindingBody,
  resetIamMfaBody,
} from '../dist/administration/migrations/identity-operations.migration.js';
import { startPostgres, withClient, sqlState, type TestPostgres } from './setup-postgres.ts';

const runtime = ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const;
const owners = ['product_email_owner', 'product_mfa_owner', 'product_binding_owner'] as const;
const functions = {
  change_iam_account_email: [
    'uuid,text,text,uuid',
    'product_email_owner',
    changeIamAccountEmailBody,
  ],
  reset_iam_mfa: ['uuid', 'product_mfa_owner', resetIamMfaBody],
  reset_iam_google_binding: ['uuid,text,uuid', 'product_binding_owner', resetIamGoogleBindingBody],
} as const;

let pg: TestPostgres;
let pools: Record<(typeof runtime)[number], DataSource>;
let passwords: Record<ProductDatabasePurpose, string>;
let connections: Awaited<ReturnType<typeof provisionProductDatabase>>;
const legacy = productMigrations.filter((m) => m !== IdentityOperations1792108800005);

const sql = (statement: string) => withClient(pg.superuser, (c) => c.query(statement));

const existing = () =>
  withClient(
    pg.superuser,
    async (c) =>
      (
        await c.query<{ name: string; owner: string }>(
          `SELECT p.proname name,r.rolname owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
         WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1) ORDER BY 1`,
          [Object.keys(functions)],
        )
      ).rows,
  );

before(async () => {
  pg = await startPostgres();
  passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  connections = await provisionProductDatabase(pg.superuser, passwords, legacy);
  pools = {} as typeof pools;
  for (const purpose of runtime)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
});
after(async () => {
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await pg?.stop();
});

test('the pre-upgrade database has no identity operation, and db:migrate alone cannot add them (no owner membership)', async () => {
  assert.deepEqual(await existing(), []);
  const migrate = await new DataSource({
    ...productDataSourceOptions(connections.migration),
    migrations: [...productMigrations],
  }).initialize();
  try {
    assert.equal(await sqlState(migrate.runMigrations({ transaction: 'each' })), '42501');
  } finally {
    await migrate.destroy();
  }
  assert.deepEqual(await existing(), []);
  const applied = await withClient(pg.superuser, async (c) =>
    (await c.query<{ name: string }>('SELECT name FROM migrations ORDER BY id')).rows.map(
      (r) => r.name,
    ),
  );
  assert.equal(applied.includes('IdentityOperations1792108800005'), false);
});

test('re-running provisioning upgrades in place: new owners, the three functions, exact ACLs, probe passes, repeat is a no-op', async () => {
  await provisionProductDatabase(pg.superuser, passwords, productMigrations);
  assert.deepEqual(
    await existing(),
    Object.entries(functions)
      .map(([name, [, owner]]) => ({ name, owner }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  await verifyProductPrivileges(pools);
  const target = randomUUID();
  await withClient(connections.migration, (c) =>
    c.query(
      `INSERT INTO app_user(id,email_canonical,state) VALUES($1,'up@example.test','active')`,
      [target],
    ),
  );
  await pools.authority
    .query('SELECT public.reset_iam_google_binding($1,$2,$3)', [
      target,
      'https://idp.none',
      randomUUID(),
    ])
    .then(
      () => assert.fail('an unknown issuer must be refused'),
      (error: { code?: string }) => assert.equal(error.code, '22023'),
    );
  await provisionProductDatabase(pg.superuser, passwords, productMigrations);
  await verifyProductPrivileges(pools);
  assert.equal((await existing()).length, 3);
  // The owners stay NOLOGIN and keep no membership or CREATE after provisioning.
  for (const owner of owners)
    assert.deepEqual(
      (
        await withClient(pg.superuser, (c) =>
          c.query(
            `SELECT rolcanlogin,has_schema_privilege(oid,'public','CREATE') c,
               EXISTS(SELECT FROM pg_auth_members WHERE member=oid) m FROM pg_roles WHERE rolname=$1`,
            [owner],
          ),
        )
      ).rows,
      [{ rolcanlogin: false, c: false, m: false }],
    );
});

test('startup rejects a changed body, owner, SECURITY mode, search_path or ACL of the identity operations', async () => {
  const cases: (readonly [string, string])[] = [];
  for (const [name, [args, owner, body]] of Object.entries(functions)) {
    const signature = `public.${name}(${args})`;
    const params = {
      change_iam_account_email: 'p_user uuid, p_email text, p_issuer text, p_actor uuid',
      reset_iam_mfa: 'p_user uuid',
      reset_iam_google_binding: 'p_user uuid, p_issuer text, p_actor uuid',
    }[name];

    const create = (text: string) =>
      `CREATE OR REPLACE FUNCTION public.${name}(${params}) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $f$${text}$f$`;

    cases.push(
      [create('BEGIN NULL; END'), create(body)],
      [
        `ALTER FUNCTION ${signature} OWNER TO product_account_owner`,
        `ALTER FUNCTION ${signature} OWNER TO ${owner}`,
      ],
      [
        `ALTER FUNCTION ${signature} SECURITY INVOKER`,
        `ALTER FUNCTION ${signature} SECURITY DEFINER`,
      ],
      [
        `ALTER FUNCTION ${signature} SET search_path=public`,
        `ALTER FUNCTION ${signature} SET search_path=pg_catalog,pg_temp`,
      ],
    );
  }
  cases.push(
    [
      'GRANT UPDATE(state) ON app_user TO product_email_owner',
      'REVOKE UPDATE(state) ON app_user FROM product_email_owner',
    ],
    [
      'REVOKE INSERT ON oidc_email_enrollment FROM product_email_owner',
      'GRANT INSERT ON oidc_email_enrollment TO product_email_owner',
    ],
    [
      'GRANT SELECT(secret_ciphertext) ON mfa_totp TO product_mfa_owner',
      'REVOKE SELECT(secret_ciphertext) ON mfa_totp FROM product_mfa_owner',
    ],
    [
      'REVOKE DELETE ON mfa_recovery_code FROM product_mfa_owner',
      'GRANT DELETE ON mfa_recovery_code TO product_mfa_owner',
    ],
    [
      'GRANT DELETE ON external_identity TO product_binding_owner',
      'REVOKE DELETE ON external_identity FROM product_binding_owner',
    ],
    [
      'REVOKE UPDATE(binding_version) ON external_identity FROM product_binding_owner',
      'GRANT UPDATE(binding_version) ON external_identity TO product_binding_owner',
    ],
    [
      'GRANT CREATE ON SCHEMA public TO product_mfa_owner',
      'REVOKE CREATE ON SCHEMA public FROM product_mfa_owner',
    ],
    ['ALTER ROLE product_binding_owner LOGIN', 'ALTER ROLE product_binding_owner NOLOGIN'],
    ['GRANT product_data TO product_email_owner', 'REVOKE product_data FROM product_email_owner'],
  );
  for (const [alter, restore] of cases) {
    await sql(alter);
    try {
      await assert.rejects(verifyProductPrivileges(pools), /protection drift/, alter);
    } finally {
      await sql(restore);
    }
    await verifyProductPrivileges(pools).catch((error: Error) => {
      throw new Error(`restore of [${alter}] left drift: ${error.message}`);
    });
  }
});

test('startup rejects EXECUTE for any login but authority, and a missing EXECUTE for authority', async () => {
  const cases: { grant: string; revoke: string; affected: (typeof runtime)[number] }[] = [];
  for (const [name, [args]] of Object.entries(functions)) {
    const signature = `public.${name}(${args})`;
    for (const login of ['data', 'identity', 'sync', 'bootstrap'] as const)
      cases.push({
        grant: `GRANT EXECUTE ON FUNCTION ${signature} TO product_${login}`,
        revoke: `REVOKE EXECUTE ON FUNCTION ${signature} FROM product_${login}`,
        affected: login,
      });
    cases.push({
      grant: `GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`,
      revoke: `REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`,
      affected: 'data',
    });
    cases.push({
      grant: `REVOKE EXECUTE ON FUNCTION ${signature} FROM product_authority`,
      revoke: `GRANT EXECUTE ON FUNCTION ${signature} TO product_authority`,
      affected: 'authority',
    });
  }
  for (const { grant, revoke, affected } of cases) {
    await sql(grant);
    try {
      await assert.rejects(
        verifyProductPrivileges({ [affected]: pools[affected] }),
        /privilege drift/,
        grant,
      );
    } finally {
      await sql(revoke);
    }
    await verifyProductPrivileges(pools);
  }
});
