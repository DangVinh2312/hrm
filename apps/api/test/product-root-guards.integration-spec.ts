import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { bootstrapProductRoot } from '../dist/authorization/services/product-root.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';

import {
  createProductAuthorizationCore,
  productDeclarations,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import { fixtureProvider, FIXTURE_ISSUER } from './oidc-fixture.helper.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

const core = createProductAuthorizationCore();

const utf8 = (value: string) => Buffer.from(value);

// Release 2 plus one boundary on document.read, so user_boundary facts can be written at all.
const release = prepareProductRelease(
  {
    ...productReleaseSource,
    declarations: {
      ...productDeclarations,
      boundaries: [
        ...productDeclarations.boundaries,
        {
          key: 'documentLimit',
          version: 1,
          entries: [
            {
              permission: 'document.read',
              contextRequirements: [],
              requiredScope: { op: 'constant', value: true },
            },
          ],
        },
      ],
    },
  },
  core,
);
type Runtime = 'data' | 'identity' | 'authority' | 'sync' | 'bootstrap';
const runtime = ['data', 'identity', 'authority', 'sync', 'bootstrap', 'outbox'] as const;
let pg: TestPostgres;
let connections: Awaited<ReturnType<typeof provisionProductDatabase>>;
let pools: Record<Runtime, DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;
const object = randomUUID();
// Created by the bootstrap test below, from the email.
let root: IdentityId;
const member = randomUUID() as IdentityId;

const pending = async (email?: string): Promise<IdentityId> => {
  const id = randomUUID() as IdentityId;
  await migration.query(`INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,'pending')`, [
    id,
    email ?? `${id}@example.test`,
  ]);
  return id;
};

const promote = (id: string) =>
  runner.run('bootstrap', (tx) =>
    tx.manager.query(`UPDATE app_user SET kind='root' WHERE id=$1`, [id]),
  );

/** Writes one IAM fact for `user` through the authority (or sync) credential. */
const facts: Record<string, (user: string) => Promise<unknown>> = {
  user_role: (user) =>
    runner.run('admin', (tx) =>
      tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
        user,
        utf8('reviewer'),
      ]),
    ),

  user_boundary: (user) =>
    runner.run('admin', (tx) =>
      tx.manager.query(
        'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)',
        [user, utf8('document.read'), utf8('documentLimit')],
      ),
    ),

  policy_rule: (user) =>
    runner.run('admin', (tx) =>
      tx.manager.query(
        "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
        [randomUUID(), utf8('document.read'), user, utf8('ownedDocuments')],
      ),
    ),

  record_exception: (user) =>
    runner.run('admin', (tx) =>
      tx.manager.query(
        "INSERT INTO record_exception(exception_id,object_id,type_key,permission_key,user_id,effect,purpose,starts_at,reason,issued_by) VALUES($1,$2,$3,$4,$5,'allow','manual',statement_timestamp(),'fixture',$6)",
        [randomUUID(), object, utf8('document'), utf8('document.read'), user, member],
      ),
    ),
};

before(async () => {
  pg = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'].map((p) => [
      p,
      randomBytes(24).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  connections = await provisionProductDatabase(pg.superuser, passwords);
  pools = {} as typeof pools;
  for (const p of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[p] = await new DataSource(productDataSourceOptions(connections[p])).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  await fixtureProvider(migration);
  runner = new ProductTransactionRunner(pools);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,'member@example.test','active',true)`,
    [member],
  );
  await runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$2,'uuid',$3)",
      [object, utf8('document'), utf8(object)],
    ),
  );
});
after(async () => {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await pg?.stop();
});

test('promotion: only bootstrap, only a pending fact-free target without a live invitation', async () => {
  const target = await pending();
  for (const login of ['data', 'identity', 'authority', 'sync', 'outbox'] as const)
    await withClient(connections[login], async (c) =>
      assert.equal(
        await sqlState(c.query(`UPDATE app_user SET kind='root' WHERE id=$1`, [target])),
        '42501',
        login,
      ),
    );
  // ACL layer: no runtime login may insert an account carrying `kind` at all.
  for (const login of runtime)
    await withClient(connections[login], async (c) =>
      assert.equal(
        await sqlState(
          c.query(`INSERT INTO app_user(id,state,kind) VALUES($1,'pending','root')`, [
            randomUUID(),
          ]),
        ),
        '42501',
        login,
      ),
    );
  // The table owner has the column privilege; the guard still refuses everyone but bootstrap.
  await assert.rejects(
    migration.query(`UPDATE app_user SET kind='root' WHERE id=$1`, [target]),
    /offline bootstrap only/,
  );
  await assert.rejects(
    migration.query(`INSERT INTO app_user(id,state,kind) VALUES($1,'pending','root')`, [
      randomUUID(),
    ]),
    /created only by promotion/,
  );
  await assert.rejects(promote(member), /must be pending/);
  for (const [name, write] of Object.entries(facts)) {
    const holder = await pending();
    await write(holder);
    await assert.rejects(promote(holder), /holds IAM facts/, name);
  }
  const invited = await pending();
  // Identity holds no INSERT on one_time_token (migration 020); the bootstrap credential is the
  // issuer of a live proof, here for an ordinary pending account.
  await pools.bootstrap.query(
    `INSERT INTO one_time_token(token_hash,user_id,purpose,expires_at) VALUES($1,$2,'oidc-activation',statement_timestamp()+interval '1 minute')`,
    [randomBytes(32), invited],
  );
  await assert.rejects(promote(invited), /live activation token/);
  // Issuing a record exception for someone else is not an IAM fact of the issuer: the guard
  // accepts the promotion (rolled back here, so the marker stays free).
  const issuer = await pending();
  await facts.record_exception!(member);
  await runner.run('admin', (tx) =>
    tx.manager.query('UPDATE record_exception SET issued_by=$1 WHERE user_id=$2', [issuer, member]),
  );
  await assert.rejects(
    runner.run('bootstrap', async (tx) => {
      await tx.manager.query(`UPDATE app_user SET kind='root' WHERE id=$1`, [issuer]);
      throw new Error('guard accepted; roll back');
    }),
    /guard accepted; roll back/,
  );
});

test('one Root: bootstrap promotes once; root→iam and a second Root are refused', async () => {
  const result = await bootstrapProductRoot(runner, audit, release, {
    operationId: randomUUID(),
    issuer: FIXTURE_ISSUER,
    email: 'root@example.test',
  });
  assert.ok(result.activationSecret);
  root = result.userId;
  assert.deepEqual(await migration.query('SELECT kind FROM app_user WHERE id=$1', [root]), [
    { kind: 'root' },
  ]);
  await assert.rejects(
    runner.run('bootstrap', (tx) =>
      tx.manager.query(`UPDATE app_user SET kind='iam' WHERE id=$1`, [root]),
    ),
    /immutable/,
  );
  await assert.rejects(
    migration.query(`UPDATE app_user SET kind='iam' WHERE id=$1`, [root]),
    /immutable/,
  );
  await assert.rejects(promote(await pending()), /one-time/);
});

test('Root holds no IAM fact: every subject change is refused; issued_by is no subject', async () => {
  for (const [name, write] of Object.entries(facts))
    await assert.rejects(write(root), /outside IAM/, name);
  await facts.user_role!(member);
  await assert.rejects(
    runner.run('admin', (tx) =>
      tx.manager.query('UPDATE user_role SET user_id=$1 WHERE user_id=$2', [root, member]),
    ),
    /outside IAM/,
  );
  await assert.rejects(
    pools.sync.query(
      'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version,seed_owner) VALUES($1,$2,$3,1,$4)',
      [root, utf8('document.read'), utf8('documentLimit'), utf8('seed')],
    ),
    /outside IAM/,
  );
  await assert.rejects(
    pools.sync.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','code')",
      [randomUUID(), utf8('document.read'), root, utf8('ownedDocuments')],
    ),
    /outside IAM/,
  );
  await runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO record_exception(exception_id,object_id,type_key,permission_key,user_id,effect,purpose,starts_at,reason,issued_by) VALUES($1,$2,$3,$4,$5,'deny','manual',statement_timestamp(),'issued by Root',$6)",
      [randomUUID(), object, utf8('document'), utf8('document.read'), member, root],
    ),
  );
  assert.deepEqual(
    await migration.query(
      `SELECT (SELECT count(*)::int FROM user_role WHERE user_id=$1)+(SELECT count(*)::int FROM user_boundary WHERE user_id=$1)+(SELECT count(*)::int FROM policy_rule WHERE user_id=$1)+(SELECT count(*)::int FROM record_exception WHERE user_id=$1) AS n`,
      [root],
    ),
    [{ n: 0 }],
  );
});
