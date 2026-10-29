// Against real PostgreSQL logins: `bootstrapProductRoot` creates the one Root from an
// email through the guarded promotion; refused attempts leave no account, pin or marker behind.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { verifyProductPrivileges } from '../dist/database/services/product-privilege-verify.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { bootstrapProductRoot } from '../dist/authorization/services/product-root.service.js';
import { ReleaseRejectedError } from '../dist/authorization/helpers/release-content.helper.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import {
  PRODUCT_OFFLINE_ACTOR,
  ProductAuditRepository,
} from '../dist/audit/product-audit.repository.js';
import { sqlState, startPostgres, type TestPostgres } from './setup-postgres.ts';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

const core = createProductAuthorizationCore();
const release = createProductRelease(core);
const issuer = 'https://issuer.fixture';
const disabled = 'https://disabled.fixture';

let postgres: TestPostgres;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;

const reason = (operation: Promise<unknown>) =>
  operation.then(
    () => undefined,
    (error: unknown) => (error instanceof ReleaseRejectedError ? error.reason : error),
  );

const counts = async () =>
  (
    await migration.query<object[]>(
      `SELECT (SELECT count(*)::int FROM app_user) users,(SELECT count(*)::int FROM oidc_email_enrollment) pins,
         (SELECT count(*)::int FROM one_time_token) tokens,
         (SELECT operation_id IS NULL FROM security_bootstrap_state) free`,
    )
  )[0];

before(async () => {
  postgres = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(postgres.superuser, passwords);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  await migration.query(
    'INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true),($2,1,false)',
    [issuer, disabled],
  );
  runner = new ProductTransactionRunner(pools);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(release);
});

after(async () => {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
});

const input = (extra: Partial<{ operationId: string; issuer: string; email: string }> = {}) => ({
  operationId: randomUUID(),
  issuer,
  email: 'Root@Example.test',
  ...extra,
});

test('refused bootstrap leaves no account, pin, token or marker', async () => {
  const existing = randomUUID();
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,state) VALUES($1,'root@example.test','active')`,
    [existing],
  );
  const before = await counts();
  assert.equal(await reason(bootstrapProductRoot(runner, audit, release, input())), 'collision');
  assert.equal(
    await reason(
      bootstrapProductRoot(
        runner,
        audit,
        release,
        input({ email: 'free@example.test', issuer: disabled }),
      ),
    ),
    'missing_reference',
  );
  assert.equal(
    await reason(
      bootstrapProductRoot(
        runner,
        audit,
        release,
        input({ email: 'free@example.test', issuer: 'https://none.fixture' }),
      ),
    ),
    'missing_reference',
  );
  for (const bad of [
    input({ operationId: 'not-a-uuid' }),
    input({ email: 'not-an-email' }),
    input({ email: '' }),
    input({ issuer: '' }),
  ])
    assert.equal(
      await reason(bootstrapProductRoot(runner, audit, release, bad)),
      'invalid_release',
    );
  assert.deepEqual(await counts(), before);
  await migration.query('DELETE FROM app_user WHERE id=$1', [existing]);
});

test('bootstrap creates one pending Root, its pin and proof; the guard still refuses a direct Root', async () => {
  // The bootstrap login may insert only the pending account, never a Root or an active one.
  for (const sql of [
    `INSERT INTO app_user(id,state,kind) VALUES(gen_random_uuid(),'pending','root')`,
    `INSERT INTO app_user(id,state,email_verified) VALUES(gen_random_uuid(),'pending',true)`,
    `INSERT INTO app_user(id,state,auth_epoch) VALUES(gen_random_uuid(),'pending',5)`,
  ])
    assert.equal(await sqlState(pools.bootstrap.query(sql)), '42501', sql);
  const operationId = randomUUID();
  const first = await bootstrapProductRoot(runner, audit, release, input({ operationId }));
  assert.equal(first.initialized, true);
  assert.match(first.activationSecret ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(
    await migration.query(
      `SELECT u.kind,u.state,u.email_canonical,u.email_verified,n.issuer,n.email_canonical pinned,
         n.expires_at<=statement_timestamp()+interval '15 minutes' short,n.created_by::text creator,
         (SELECT count(*)::int FROM one_time_token t WHERE t.user_id=u.id AND t.purpose='oidc-activation' AND t.consumed_at IS NULL) tokens,
         (SELECT count(*)::int FROM external_identity e WHERE e.user_id=u.id) bindings,
         (SELECT target_user_id=u.id AND operation_id=$2 FROM security_bootstrap_state) marked
       FROM app_user u JOIN oidc_email_enrollment n ON n.user_id=u.id WHERE u.id=$1`,
      [first.userId, operationId],
    ),
    [
      {
        kind: 'root',
        state: 'pending',
        email_canonical: 'root@example.test',
        email_verified: false,
        issuer,
        pinned: 'root@example.test',
        short: true,
        creator: PRODUCT_OFFLINE_ACTOR,
        tokens: 1,
        bindings: 0,
        marked: true,
      },
    ],
  );
  // The audit names the offline actor and the target, never the address.
  const events = await migration.query<{ actor: string; metadata: string }[]>(
    `SELECT actor_id::text actor,safe_metadata::text metadata FROM audit_outbox WHERE event_kind=$1`,
    [Buffer.from('root.bootstrap')],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actor, PRODUCT_OFFLINE_ACTOR);
  assert.ok(events[0]?.metadata.includes(first.userId));
  assert.ok(!events[0]?.metadata.includes('@'));

  // Same operation and email: nothing changes. Another operation or email is a collision.
  const after = await counts();
  const retry = await bootstrapProductRoot(runner, audit, release, input({ operationId }));
  assert.deepEqual(
    [retry.initialized, retry.userId, retry.activationSecret],
    [false, first.userId, undefined],
  );
  assert.equal(
    await reason(
      bootstrapProductRoot(runner, audit, release, input({ operationId, email: 'x@example.test' })),
    ),
    'collision',
  );
  assert.equal(await reason(bootstrapProductRoot(runner, audit, release, input())), 'collision');
  assert.deepEqual(await counts(), after);
  await verifyProductPrivileges(pools);
});
