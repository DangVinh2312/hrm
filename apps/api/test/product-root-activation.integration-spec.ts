// ADR 0027 §3–4 against real PostgreSQL logins and a signed fixture IdP: the Root created from an
// email is activated only by a verified claim of that email; every other answer changes nothing.
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
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  ProductAuthenticationError,
  ProductIdentityService,
  newSessionSecret,
  sessionDigest,
} from '../dist/auth/services/product-identity.service.js';
import { ProductOidcService } from '../dist/auth/services/product-oidc.service.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import {
  bootstrapProductRoot,
  reissueRootActivation,
} from '../dist/authorization/services/product-root.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';
import { startFixtureIdp, type FixtureIdp } from './oidc-idp.helper.ts';
import { bindAccount } from './oidc-fixture.helper.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

const core = createProductAuthorizationCore();
const release = createProductRelease(core);
const issuer = 'https://issuer.fixture';
const email = 'root@example.test';

let postgres: TestPostgres;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;
let identity: ProductIdentityService;
let federation: ProductOidcService;
let idp: FixtureIdp;
let rootId: IdentityId;
let token = '';

const verified = (sub: string, address = email) => ({ sub, email: address, email_verified: true });

let clients = 0;

const begin = (activationToken: string) => {
  const browser = newSessionSecret();
  return federation
    .begin(
      issuer,
      browser,
      { purpose: 'activation', activationToken },
      `root-activation-${++clients}`,
    )
    .then((url) => ({ url, browser }));
};

const attempt = async (activationToken: string, claims: Record<string, unknown>) => {
  const { url, browser } = await begin(activationToken);
  return federation.callback(issuer, idp.responseFor(url, claims), browser);
};

const refused = (operation: Promise<unknown>) =>
  assert.rejects(operation, (error) => error instanceof ProductAuthenticationError);

interface RootState {
  state: string;
  kind: string;
  verified: boolean;
  epoch: string;
  bindings: number;
  pinned: number;
  live: number;
}

const state = async () =>
  (
    await migration.query<RootState[]>(
      `SELECT u.state,u.kind,u.email_verified verified,u.auth_epoch::text epoch,
         (SELECT count(*)::int FROM external_identity WHERE user_id=u.id) bindings,
         (SELECT count(*)::int FROM oidc_email_enrollment WHERE user_id=u.id) pinned,
         (SELECT count(*)::int FROM one_time_token WHERE user_id=u.id AND consumed_at IS NULL) live
       FROM app_user u WHERE u.id=$1`,
      [rootId],
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
  await migration.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [
    issuer,
  ]);
  runner = new ProductTransactionRunner(pools);
  identity = new ProductIdentityService(runner, audit);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(release);
  idp = await startFixtureIdp();
  federation = new ProductOidcService(identity, new Map([[issuer, idp.provider(issuer)]]));
  const created = await bootstrapProductRoot(runner, audit, release, {
    operationId: randomUUID(),
    issuer,
    email,
  });
  rootId = created.userId;
  token = created.activationSecret ?? '';
});

after(async () => {
  await idp?.close();
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
});

const pending = {
  state: 'pending',
  kind: 'root',
  verified: false,
  bindings: 0,
  pinned: 1,
  live: 1,
};

const unchanged = async () => {
  const now = await state();
  assert.deepEqual({ ...now, epoch: undefined }, { ...pending, epoch: undefined });
};

test('activation needs the exact token, and an answer other than the pinned verified email changes nothing', async () => {
  const epoch = (await state())?.epoch;
  await unchanged();
  for (const wrong of ['', newSessionSecret()])
    await assert.rejects(begin(wrong), ProductAuthenticationError);
  for (const claims of [
    verified('root-subject', 'other@example.test'),
    { sub: 'root-subject', email, email_verified: false },
    { sub: 'root-subject', email, email_verified: 'true' },
    { sub: 'root-subject' },
    verified('root-subject', ` ${email}`),
  ])
    await refused(attempt(token, claims));
  assert.equal((await state())?.epoch, epoch);
  await unchanged();
  // A subject that already belongs to another account cannot activate the Root.
  const other = randomUUID();
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,'other@example.test',true,'active')`,
    [other],
  );
  await bindAccount(pools.identity, other, 'taken-subject', issuer);
  await refused(attempt(token, verified('taken-subject')));
  await unchanged();
  // An ordinary login with the Root's verified email does not activate it either.
  const browser = newSessionSecret();
  const url = await federation.begin(issuer, browser, {}, 'root-plain-login');
  await refused(
    federation.callback(issuer, idp.responseFor(url, verified('root-subject')), browser),
  );
  await unchanged();
});

test('a reissued proof voids a begun attempt; an expired enrollment cannot start until reissued', async () => {
  const stale = await begin(token);
  const { activationSecret } = await reissueRootActivation(runner, audit, { issuer });
  token = activationSecret;
  await refused(
    federation.callback(
      issuer,
      idp.responseFor(stale.url, verified('root-subject')),
      stale.browser,
    ),
  );
  await unchanged();
  await migration.query(
    `UPDATE oidc_email_enrollment SET created_at=created_at-interval '1 hour',expires_at=statement_timestamp()-interval '1 minute' WHERE user_id=$1`,
    [rootId],
  );
  await assert.rejects(begin(token), ProductAuthenticationError);
  // The token row itself cannot be aged: `protect_token_consumption` refuses any such UPDATE.
  const renewed = await reissueRootActivation(runner, audit, { issuer });
  token = renewed.activationSecret;
  await unchanged();
});

test('two concurrent callbacks with the proof leave one binding; the Root is active, verified, one epoch step on', async () => {
  const before = BigInt((await state())?.epoch ?? '0');
  const first = await begin(token);
  const second = await begin(token);
  const outcomes = await Promise.allSettled([
    federation.callback(issuer, idp.responseFor(first.url, verified('root-a')), first.browser),
    federation.callback(issuer, idp.responseFor(second.url, verified('root-b')), second.browser),
  ]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  const win = outcomes.find((o) => o.status === 'fulfilled');
  const session = win && win.status === 'fulfilled' ? win.value : undefined;
  assert.ok(session);
  const now = await state();
  assert.equal(now?.state, 'active');
  assert.equal(now?.kind, 'root');
  assert.equal(now?.verified, true);
  assert.equal(BigInt(now?.epoch ?? '0'), before + 1n);
  assert.deepEqual([now?.bindings, now?.pinned, now?.live], [1, 0, 0]);
  const actor = await runner.run('read', (tx) => identity.authenticate(tx, session.secret));
  assert.equal(actor.userId, rootId);
  assert.equal(actor.fresh, false);
  const [row] = await migration.query<{ reauthenticated: boolean }[]>(
    'SELECT reauthenticated_at IS NOT NULL reauthenticated FROM application_session WHERE token_hash=$1',
    [sessionDigest(session.secret)],
  );
  assert.equal(row?.reauthenticated, false);
  assert.equal(
    (
      await migration.query<object[]>(
        `SELECT 1 FROM audit_outbox WHERE event_kind=$1 AND actor_id=$2 AND NOT safe_metadata::text LIKE '%@%'`,
        [Buffer.from('identity.oidc-activation'), rootId],
      )
    ).length,
    1,
  );
});

test('the used proof cannot start again and nothing is left to reissue', async () => {
  await assert.rejects(begin(token), ProductAuthenticationError);
  await assert.rejects(reissueRootActivation(runner, audit, { issuer }), /pending bootstrap Root/);
});
