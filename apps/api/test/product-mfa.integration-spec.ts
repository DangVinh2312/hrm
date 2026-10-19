// ADR 0026: TOTP second factor and recovery codes against real PostgreSQL logins: migration 016
// guards/grants/probes, the DB clock step window, replay and races, the failure counter, sessions
// after a verify, the offline reset by identity (IAM) and bootstrap (Root), and key coverage.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  provisionProductDatabase,
  verifyProductPrivileges,
} from '../dist/database/helpers/product-database.helper.js';
import {
  guardRootLifecycleMfaBody,
  mfaEpochBody,
  protectMfaRecoveryCodeBody,
  protectMfaTotpBody,
} from '../dist/database/migrations/016-mfa-totp.migration.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  ProductAuthenticationError,
  ProductIdentityService,
  newSessionSecret,
  sessionDigest,
} from '../dist/auth/services/product-identity.service.js';
import {
  ProductMfaConflict,
  ProductMfaService,
  ProductStepUpRequired,
  resetProductMfa,
} from '../dist/auth/services/product-mfa.service.js';
import { base32Decode, hotp } from '../dist/auth/helpers/totp.helper.js';
import { parseMfaKeyRing } from '../dist/auth/helpers/mfa-encryption.helper.js';
import {
  ProductManifestReconciler,
  bootstrapProductRoot,
} from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { ProductOidcService } from '../dist/auth/services/product-oidc.service.js';
import { AppModule } from '../dist/app.module.js';
import { loadConfig } from '../dist/config/app.config.js';
import { ProductRuntime } from '../dist/infrastructure/product-runtime.service.js';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { createServer, type AddressInfo } from 'node:net';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';

const core = createProductAuthorizationCore();
const release = createProductRelease(core);
const issuer = 'https://issuer.fixture';
const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');
const ring = parseMfaKeyRing(`k1:${keyA}`, 'k1');

let postgres: TestPostgres;
let connections: Awaited<ReturnType<typeof provisionProductDatabase>>;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;
let identity: ProductIdentityService;
let mfa: ProductMfaService;
let client = 0;

/** A distinct client address per call site: the rate limiter must not couple unrelated tests. */
const ip = () => `10.${Math.floor(++client / 250)}.${client % 250}.1`;

const superuser = (sql: string, values: unknown[] = []) =>
  withClient(postgres.superuser, (c) => c.query({ text: sql, values }));

const epoch = async (userId: string) =>
  (
    await migration.query<{ e: string }[]>('SELECT auth_epoch::text e FROM app_user WHERE id=$1', [
      userId,
    ])
  )[0]?.e;

const factor = async (userId: string) =>
  (
    await migration.query<
      {
        confirmed: boolean;
        step: string | null;
        failed: number;
        key: string;
        version: string;
      }[]
    >(
      `SELECT confirmed_at IS NOT NULL confirmed,last_used_step::text step,failed_attempts failed,key_id key,secret_version::text version FROM mfa_totp WHERE user_id=$1`,
      [userId],
    )
  )[0];

const alive = (secret: string) =>
  runner
    .run('identity', (tx) => identity.authenticate(tx, secret))
    .then(
      (session) => session,
      (error: unknown) => {
        assert.ok(error instanceof ProductAuthenticationError);
        return undefined;
      },
    );

const events = async (kind: string, actor: string) =>
  await migration.query<{ metadata: Record<string, string>; reason: string | null }[]>(
    `SELECT safe_metadata metadata,reason FROM audit_outbox WHERE event_kind=convert_to($1,'UTF8') AND actor_id=$2 ORDER BY occurred_at`,
    [kind, actor],
  );

/** OIDC session bound to the account's binding; `fresh` like a step-up 5 s ago (WSL clock). */
async function session(userId: string, fresh = false): Promise<string> {
  const secret = newSessionSecret();
  await migration.query(
    `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
     SELECT $1,u.id,u.auth_epoch,'oidc','oidc',e.issuer,e.subject,e.binding_version,1,statement_timestamp()-interval '1 hour',
       CASE WHEN $3 THEN statement_timestamp()-interval '5 seconds' END,statement_timestamp()+interval '2 hours'
     FROM app_user u JOIN external_identity e ON e.user_id=u.id WHERE u.id=$2`,
    [sessionDigest(secret), userId, fresh],
  );
  return secret;
}

/** Active IAM account with one Google binding and one session. */
async function account(): Promise<{ userId: string; secret: string }> {
  const userId = randomUUID();
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,$2,'active',true)`,
    [userId, `${userId}@example.test`],
  );
  await migration.query('INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)', [
    issuer,
    `sub-${userId}`,
    userId,
  ]);
  return { userId, secret: await session(userId) };
}

/** Current TOTP step by the DB clock, away from a step edge so ±1 codes stay valid for a while. */
async function stableStep(): Promise<bigint> {
  for (;;) {
    const [row] = await migration.query<{ seconds: string }[]>(
      'SELECT extract(epoch FROM statement_timestamp())::text seconds',
    );
    const seconds = Number(row?.seconds);
    if (seconds % 30 < 24) return BigInt(Math.floor(seconds / 30));
    await sleep((30 - (seconds % 30)) * 1000 + 200);
  }
}

/** Enrolled and confirmed with the code of `step - 1`; returns the raw secret and new session. */
async function enrolled(): Promise<{ userId: string; secret: string; raw: Buffer; step: bigint }> {
  const { userId, secret } = await account();
  const setup = await mfa.setup(secret, ip());
  const raw = base32Decode(setup.secret);
  const step = await stableStep();
  const confirmed = await mfa.confirm(secret, hotp(raw, step - 1n), ip());
  return { userId, secret: confirmed.session.secret, raw, step };
}

before(async () => {
  postgres = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  connections = await provisionProductDatabase(postgres.superuser, passwords);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  runner = new ProductTransactionRunner(pools);
  identity = new ProductIdentityService(runner);
  mfa = new ProductMfaService(identity, ring);
  await new ProductManifestReconciler(runner, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(release);
  await migration.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [
    issuer,
  ]);
});

after(async () => {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
});

test('migration 016: exact grants and guards pass the probe; drift fails closed', async () => {
  await verifyProductPrivileges(pools);

  const fn = (name: string, body: string, definer = '') =>
    `CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql ${definer} SET search_path=pg_catalog,pg_temp AS $fn$${body}$fn$`;

  const totpGuard =
    'CREATE TRIGGER protect_mfa_totp BEFORE INSERT OR UPDATE OR DELETE ON mfa_totp FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_totp()';
  const epochTrigger =
    'CREATE TRIGGER mfa_epoch AFTER UPDATE OR DELETE ON mfa_totp FOR EACH ROW EXECUTE FUNCTION public.mfa_epoch()';
  const codeGuard =
    'CREATE TRIGGER protect_mfa_recovery_code BEFORE INSERT OR UPDATE OR DELETE ON mfa_recovery_code FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_recovery_code()';
  const cases: (readonly [string, string])[] = [
    [fn('protect_mfa_totp', 'BEGIN RETURN NEW; END'), fn('protect_mfa_totp', protectMfaTotpBody)],
    [
      fn('protect_mfa_recovery_code', 'BEGIN RETURN NEW; END'),
      fn('protect_mfa_recovery_code', protectMfaRecoveryCodeBody),
    ],
    [fn('mfa_epoch', 'BEGIN RETURN NULL; END'), fn('mfa_epoch', mfaEpochBody)],
    [
      fn('guard_root_lifecycle', 'BEGIN RETURN NEW; END', 'SECURITY DEFINER'),
      fn('guard_root_lifecycle', guardRootLifecycleMfaBody, 'SECURITY DEFINER'),
    ],
    ['DROP TRIGGER protect_mfa_totp ON mfa_totp', totpGuard],
    ['DROP TRIGGER mfa_epoch ON mfa_totp', epochTrigger],
    ['DROP TRIGGER protect_mfa_recovery_code ON mfa_recovery_code', codeGuard],
    [
      'ALTER TABLE mfa_totp DISABLE TRIGGER mfa_epoch',
      'ALTER TABLE mfa_totp ENABLE TRIGGER mfa_epoch',
    ],
    [
      'ALTER TABLE mfa_recovery_code DISABLE TRIGGER protect_mfa_recovery_code',
      'ALTER TABLE mfa_recovery_code ENABLE TRIGGER protect_mfa_recovery_code',
    ],
    [
      'DROP TRIGGER mfa_epoch ON mfa_totp; CREATE TRIGGER mfa_epoch AFTER UPDATE ON mfa_totp FOR EACH ROW EXECUTE FUNCTION public.mfa_epoch()',
      `DROP TRIGGER mfa_epoch ON mfa_totp; ${epochTrigger}`,
    ],
    [
      'DROP TRIGGER protect_mfa_totp ON mfa_totp; CREATE TRIGGER protect_mfa_totp BEFORE INSERT OR UPDATE ON mfa_totp FOR EACH ROW EXECUTE FUNCTION public.protect_mfa_totp()',
      `DROP TRIGGER protect_mfa_totp ON mfa_totp; ${totpGuard}`,
    ],
    ['GRANT SELECT ON mfa_totp TO product_data', 'REVOKE SELECT ON mfa_totp FROM product_data'],
    [
      'GRANT INSERT ON mfa_recovery_code TO product_bootstrap',
      'REVOKE INSERT ON mfa_recovery_code FROM product_bootstrap',
    ],
    [
      'GRANT UPDATE(code_hash) ON mfa_recovery_code TO product_identity',
      'REVOKE UPDATE(code_hash) ON mfa_recovery_code FROM product_identity',
    ],
    [
      'REVOKE SELECT(user_id) ON mfa_totp FROM product_session_owner',
      'GRANT SELECT(user_id) ON mfa_totp TO product_session_owner',
    ],
    [
      'GRANT SELECT(key_id) ON mfa_totp TO product_session_owner',
      'REVOKE SELECT(key_id) ON mfa_totp FROM product_session_owner',
    ],
  ];
  for (const [alter, restore] of cases) {
    await superuser(alter);
    try {
      await assert.rejects(verifyProductPrivileges(pools), /drift/, alter);
    } finally {
      await superuser(restore);
    }
  }
  await verifyProductPrivileges(pools);
});

test('guards: a factor starts unconfirmed, only moves forward; codes are used once', async () => {
  const { userId } = await account();
  const id = pools.identity;

  const insert = (confirmed: boolean, step: number | null, failed: number) =>
    id.query(
      `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id,confirmed_at,last_used_step,failed_attempts) VALUES($1,$2,$3,'k1',$4,$5,$6)`,
      [userId, randomBytes(36), randomBytes(12), confirmed ? new Date() : null, step, failed],
    );

  assert.equal(await sqlState(insert(true, null, 0)), '42501');
  assert.equal(await sqlState(insert(false, 5, 0)), '42501');
  assert.equal(await sqlState(insert(false, null, 3)), '42501');
  await insert(false, null, 0);
  const before = await epoch(userId);
  // Setup changes (new secret, new setup time) end no session.
  await id.query(
    `UPDATE mfa_totp SET secret_ciphertext=$2,secret_version=secret_version+1,created_at=statement_timestamp() WHERE user_id=$1`,
    [userId, randomBytes(36)],
  );
  assert.equal(await epoch(userId), before);
  await id.query(
    `UPDATE mfa_totp SET confirmed_at=statement_timestamp(),last_used_step=100 WHERE user_id=$1`,
    [userId],
  );
  const confirmed = await epoch(userId);
  assert.equal(BigInt(confirmed ?? 0), BigInt(before ?? 0) + 1n);
  for (const change of [
    'confirmed_at=NULL',
    'confirmed_at=statement_timestamp()',
    'last_used_step=99',
    'last_used_step=NULL',
    'secret_version=secret_version+1',
    'created_at=statement_timestamp()',
  ])
    assert.equal(
      await sqlState(id.query(`UPDATE mfa_totp SET ${change} WHERE user_id=$1`, [userId])),
      '42501',
      change,
    );
  // Re-encryption keeps the factor: ciphertext, nonce and key id stay writable.
  await id.query(
    `UPDATE mfa_totp SET secret_ciphertext=$2,nonce=$3,key_id='k2',failed_attempts=0 WHERE user_id=$1`,
    [userId, randomBytes(36), randomBytes(12)],
  );
  assert.equal(await epoch(userId), confirmed);
  // Failures 1..9 keep sessions; the 10th and every later one end them.
  await id.query('UPDATE mfa_totp SET failed_attempts=9 WHERE user_id=$1', [userId]);
  assert.equal(await epoch(userId), confirmed);
  await id.query('UPDATE mfa_totp SET failed_attempts=10 WHERE user_id=$1', [userId]);
  const tenth = await epoch(userId);
  assert.equal(BigInt(tenth ?? 0), BigInt(confirmed ?? 0) + 1n);
  await id.query('UPDATE mfa_totp SET failed_attempts=11 WHERE user_id=$1', [userId]);
  assert.equal(BigInt((await epoch(userId)) ?? 0), BigInt(tenth ?? 0) + 1n);
  // At the cap the counter stays 1000, and a failure still ends the sessions.
  await id.query('UPDATE mfa_totp SET failed_attempts=1000 WHERE user_id=$1', [userId]);
  const capped = await epoch(userId);
  await id.query(
    'UPDATE mfa_totp SET failed_attempts=LEAST(failed_attempts+1,1000) WHERE user_id=$1',
    [userId],
  );
  assert.equal(BigInt((await epoch(userId)) ?? 0), BigInt(capped ?? 0) + 1n);
  const counted = await epoch(userId);
  await id.query('UPDATE mfa_totp SET failed_attempts=0 WHERE user_id=$1', [userId]);
  assert.equal(await epoch(userId), counted);

  const hash = randomBytes(32);
  assert.equal(
    await sqlState(
      id.query(
        'INSERT INTO mfa_recovery_code(user_id,code_hash,used_at) VALUES($1,$2,statement_timestamp())',
        [userId, hash],
      ),
    ),
    '42501',
  );
  await id.query('INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,$2)', [userId, hash]);
  assert.equal(
    await sqlState(
      id.query(
        `UPDATE mfa_recovery_code SET used_at=statement_timestamp()-interval '1 second' WHERE user_id=$1`,
        [userId],
      ),
    ),
    '42501',
  );
  await id.query(
    'UPDATE mfa_recovery_code SET used_at=statement_timestamp() WHERE user_id=$1 AND used_at IS NULL',
    [userId],
  );
  assert.equal(
    await sqlState(
      id.query('UPDATE mfa_recovery_code SET used_at=statement_timestamp() WHERE user_id=$1', [
        userId,
      ]),
    ),
    '42501',
  );
  // Other logins never read or write second factors.
  for (const login of ['data', 'authority', 'sync'] as const)
    assert.equal(
      await sqlState(pools[login].query('SELECT 1 FROM mfa_totp LIMIT 1')),
      '42501',
      login,
    );
  assert.equal(
    await sqlState(pools.bootstrap.query('SELECT key_id FROM mfa_totp LIMIT 1')),
    '42501',
  );
  // Removing a confirmed factor ends sessions; removing a setup does not.
  const removed = await epoch(userId);
  await id.query('DELETE FROM mfa_totp WHERE user_id=$1', [userId]);
  assert.equal(BigInt((await epoch(userId)) ?? 0), BigInt(removed ?? 0) + 1n);
  await insert(false, null, 0);
  const unconfirmed = await epoch(userId);
  await id.query('DELETE FROM mfa_totp WHERE user_id=$1', [userId]);
  assert.equal(await epoch(userId), unconfirmed);
});

test('setup, confirm and status: one setup at a time, confirmation ends other sessions', async () => {
  const { userId, secret } = await account();
  const other = await session(userId);
  assert.deepEqual(await mfa.status(secret), { status: 'none', recoveryCodesRemaining: 0 });
  const first = await mfa.setup(secret, ip());
  assert.match(first.secret, /^[A-Z2-7]{32}$/);
  assert.equal(
    first.uri,
    `otpauth://totp/HRM:${encodeURIComponent(`${userId}@example.test`)}?secret=${first.secret}&issuer=HRM&algorithm=SHA1&digits=6&period=30`,
  );
  const second = await mfa.setup(secret, ip());
  assert.notEqual(second.secret, first.secret);
  assert.deepEqual(await mfa.status(secret), { status: 'pending', recoveryCodesRemaining: 0 });
  assert.equal((await factor(userId))?.version, '2');
  const before = await epoch(userId);
  const step = await stableStep();
  // The replaced setup's code no longer confirms; a wrong code changes nothing.
  await assert.rejects(
    mfa.confirm(secret, hotp(base32Decode(first.secret), step), ip()),
    ProductAuthenticationError,
  );
  assert.equal((await factor(userId))?.confirmed, false);
  assert.equal(await epoch(userId), before);
  const [old] = await migration.query<Record<string, string>[]>(
    `SELECT method,assurance,external_subject,binding_version::text bv,provider_version::text pv,authenticated_at::text auth,expires_at::text exp FROM application_session WHERE token_hash=$1`,
    [sessionDigest(secret)],
  );
  const confirmed = await mfa.confirm(secret, hotp(base32Decode(second.secret), step), ip());
  assert.equal(confirmed.recoveryCodes.length, 10);
  assert.equal(new Set(confirmed.recoveryCodes).size, 10);
  for (const code of confirmed.recoveryCodes) assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  assert.equal(BigInt((await epoch(userId)) ?? 0), BigInt(before ?? 0) + 1n);
  assert.equal(await alive(secret), undefined);
  assert.equal(await alive(other), undefined);
  const now = await alive(confirmed.session.secret);
  assert.equal(now?.fresh, true);
  // The new session is the old one with a step-up: same method, binding, assurance and deadline.
  const [copy] = await migration.query<Record<string, string>[]>(
    `SELECT method,assurance,external_subject,binding_version::text bv,provider_version::text pv,authenticated_at::text auth,expires_at::text exp FROM application_session WHERE token_hash=$1`,
    [sessionDigest(confirmed.session.secret)],
  );
  assert.deepEqual(copy, old);
  assert.deepEqual(await mfa.status(confirmed.session.secret), {
    status: 'enabled',
    recoveryCodesRemaining: 10,
  });
  assert.equal((await factor(userId))?.step, String(step));
  await assert.rejects(mfa.setup(confirmed.session.secret, ip()), ProductMfaConflict);
  await assert.rejects(
    mfa.confirm(confirmed.session.secret, hotp(base32Decode(second.secret), step + 1n), ip()),
    ProductMfaConflict,
  );
  assert.equal((await events('identity.mfa-setup', userId)).length, 2);
  assert.equal((await events('identity.mfa-enroll', userId)).length, 1);
});

test('confirm refuses an expired setup (15 minutes by the DB clock)', async () => {
  const { userId, secret } = await account();
  const setup = await mfa.setup(secret, ip());
  await superuser(
    `ALTER TABLE mfa_totp DISABLE TRIGGER protect_mfa_totp; UPDATE mfa_totp SET created_at=statement_timestamp()-interval '15 minutes' WHERE user_id='${userId}'; ALTER TABLE mfa_totp ENABLE TRIGGER protect_mfa_totp`,
  );
  const step = await stableStep();
  await assert.rejects(
    mfa.confirm(secret, hotp(base32Decode(setup.secret), step), ip()),
    ProductMfaConflict,
  );
  assert.equal((await factor(userId))?.confirmed, false);
});

test('verify: DB step ±1, strictly after the last used step, a race has one winner', async () => {
  const { userId, secret, raw, step } = await enrolled();
  const deadline = await migration.query<{ exp: string }[]>(
    'SELECT expires_at::text exp FROM application_session WHERE token_hash=$1',
    [sessionDigest(secret)],
  );
  // Confirmation used step - 1: that code again, and older ones, are replays.
  await assert.rejects(
    mfa.verify(secret, { code: hotp(raw, step - 1n) }, ip()),
    ProductAuthenticationError,
  );
  await assert.rejects(
    mfa.verify(secret, { code: hotp(raw, step - 2n) }, ip()),
    ProductAuthenticationError,
  );
  await assert.rejects(
    mfa.verify(secret, { code: hotp(raw, step + 2n) }, ip()),
    ProductAuthenticationError,
  );
  assert.equal((await factor(userId))?.failed, 3);
  const verified = await mfa.verify(secret, { code: hotp(raw, step) }, ip());
  assert.equal(await alive(secret), undefined);
  assert.equal((await alive(verified.secret))?.fresh, true);
  assert.equal((await factor(userId))?.failed, 0);
  assert.equal((await factor(userId))?.step, String(step));
  const [copy] = await migration.query<{ exp: string }[]>(
    'SELECT expires_at::text exp FROM application_session WHERE token_hash=$1',
    [sessionDigest(verified.secret)],
  );
  assert.equal(copy?.exp, deadline[0]?.exp);
  // Two sessions race the same new code: exactly one becomes fresh.
  const a = await session(userId);
  const b = await session(userId);
  const code = hotp(raw, step + 1n);
  const results = await Promise.allSettled([
    mfa.verify(a, { code }, ip()),
    mfa.verify(b, { code }, ip()),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.ok(lost?.status === 'rejected' && lost.reason instanceof ProductAuthenticationError);
  assert.equal((await events('identity.mfa-verify', userId)).length, 2);
});

test('recovery codes: each works once, a race has one winner, regeneration needs fresh', async () => {
  const { userId, secret: first } = await account();
  const setup = await mfa.setup(first, ip());
  const step = await stableStep();
  const confirmed = await mfa.confirm(first, hotp(base32Decode(setup.secret), step), ip());
  const [one, two] = confirmed.recoveryCodes;
  assert.ok(one && two);
  const used = await mfa.verify(
    confirmed.session.secret,
    { recoveryCode: one.toLowerCase() },
    ip(),
  );
  assert.equal((await alive(used.secret))?.fresh, true);
  await assert.rejects(
    mfa.verify(used.secret, { recoveryCode: one }, ip()),
    ProductAuthenticationError,
  );
  const a = await session(userId);
  const b = await session(userId);
  const results = await Promise.allSettled([
    mfa.verify(a, { recoveryCode: two }, ip()),
    mfa.verify(b, { recoveryCode: two }, ip()),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const stale = await session(userId);
  assert.deepEqual(await mfa.status(stale), { status: 'enabled', recoveryCodesRemaining: 8 });
  assert.equal((await events('identity.mfa-recovery', userId)).length, 2);
  // Regeneration: refused without a step-up, then replaces the whole set.
  await assert.rejects(mfa.regenerateRecoveryCodes(stale, ip()), ProductStepUpRequired);
  const fresh = await session(userId, true);
  const codes = await mfa.regenerateRecoveryCodes(fresh, ip());
  assert.equal(codes.length, 10);
  assert.deepEqual(await mfa.status(fresh), { status: 'enabled', recoveryCodesRemaining: 10 });
  const [third] = confirmed.recoveryCodes.slice(2);
  await assert.rejects(
    mfa.verify(fresh, { recoveryCode: third ?? '' }, ip()),
    ProductAuthenticationError,
  );
  assert.equal((await events('identity.mfa-recovery-regenerate', userId)).length, 1);
});

test('ten failures in a row end every session; each later failure too; success resets', async () => {
  const { userId, secret, raw, step } = await enrolled();
  let current = secret;
  for (let n = 1; n <= 9; n++)
    await assert.rejects(
      mfa.verify(current, { code: hotp(raw, step + 5n) }, ip()),
      ProductAuthenticationError,
    );
  assert.ok(await alive(current));
  // Every counted failure is committed with its own audit event before the 401 (ADR 0026 §6).
  assert.equal((await events('identity.mfa-verify-failed', userId)).length, 9);
  assert.equal((await events('identity.mfa-lockout', userId)).length, 0);
  const before = await epoch(userId);
  await assert.rejects(
    mfa.verify(current, { recoveryCode: 'AAAAAAAAAAAAAAAA' }, ip()),
    ProductAuthenticationError,
  );
  assert.equal(BigInt((await epoch(userId)) ?? 0), BigInt(before ?? 0) + 1n);
  assert.equal(await alive(current), undefined);
  assert.equal((await events('identity.mfa-verify-failed', userId)).length, 10);
  assert.equal((await events('identity.mfa-lockout', userId)).length, 1);
  current = await session(userId);
  await assert.rejects(
    mfa.verify(current, { code: hotp(raw, step + 5n) }, ip()),
    ProductAuthenticationError,
  );
  assert.equal(await alive(current), undefined);
  assert.equal((await factor(userId))?.failed, 11);
  assert.equal((await events('identity.mfa-verify-failed', userId)).length, 11);
  assert.equal((await events('identity.mfa-lockout', userId)).length, 2);
  current = await session(userId);
  await mfa.verify(current, { code: hotp(raw, step) }, ip());
  assert.equal((await factor(userId))?.failed, 0);
  // Like every own-account identity event: the actor and the revision, never the tried proof.
  for (const event of await events('identity.mfa-verify-failed', userId)) {
    assert.deepEqual(Object.keys(event.metadata), ['resultingRevision']);
    assert.equal(event.reason, null);
  }
});

test('rate limit purpose mfa: twenty requests per account in 15 minutes, from any client', async () => {
  const { userId, secret } = await account();
  for (let n = 1; n <= 20; n++) await mfa.setup(secret, ip());
  await assert.rejects(mfa.setup(secret, ip()), ProductAuthenticationError);
  await assert.rejects(mfa.verify(secret, { code: '123456' }, ip()), ProductAuthenticationError);
  // Refused before any fenced work: no further setup was audited, no failure was counted.
  assert.equal((await events('identity.mfa-setup', userId)).length, 20);
  assert.equal((await factor(userId))?.failed, 0);
  // Another account is not limited by this one.
  const other = await account();
  await mfa.setup(other.secret, ip());
});

test('remove needs a step-up, deletes factor and codes, and ends every session', async () => {
  const { userId, secret } = await enrolled();
  const plain = await session(userId);
  await assert.rejects(mfa.remove(plain, ip()), ProductStepUpRequired);
  const before = await epoch(userId);
  const kept = await mfa.remove(secret, ip());
  assert.equal(BigInt((await epoch(userId)) ?? 0), BigInt(before ?? 0) + 1n);
  assert.equal(await alive(plain), undefined);
  assert.equal(await alive(secret), undefined);
  assert.equal((await alive(kept.secret))?.fresh, false);
  assert.deepEqual(await mfa.status(kept.secret), { status: 'none', recoveryCodesRemaining: 0 });
  const [codes] = await migration.query<{ n: string }[]>(
    'SELECT count(*)::text n FROM mfa_recovery_code WHERE user_id=$1',
    [userId],
  );
  assert.equal(codes?.n, '0');
  await assert.rejects(mfa.verify(kept.secret, { code: '123456' }, ip()), ProductMfaConflict);
  assert.equal((await events('identity.mfa-remove', userId)).length, 1);
  // Enrolling again works after removal.
  await mfa.setup(kept.secret, ip());
});

test('a failed audit rolls the confirmation back', async () => {
  const { userId, secret } = await account();
  const setup = await mfa.setup(secret, ip());
  const before = await epoch(userId);
  await superuser('REVOKE INSERT ON audit_outbox FROM product_identity');
  try {
    const step = await stableStep();
    await assert.rejects(mfa.confirm(secret, hotp(base32Decode(setup.secret), step), ip()));
  } finally {
    await superuser('GRANT INSERT ON audit_outbox TO product_identity');
  }
  assert.equal((await factor(userId))?.confirmed, false);
  assert.equal(await epoch(userId), before);
  assert.ok(await alive(secret));
});

test('a failed audit rolls a counted failure back: no 401 without its event', async () => {
  const { userId, secret, raw, step } = await enrolled();
  await superuser('REVOKE INSERT ON audit_outbox FROM product_identity');
  let error: unknown;
  try {
    error = await mfa.verify(secret, { code: hotp(raw, step + 5n) }, ip()).then(
      () => undefined,
      (e: unknown) => e,
    );
  } finally {
    await superuser('GRANT INSERT ON audit_outbox TO product_identity');
  }
  assert.ok(error instanceof Error && !(error instanceof ProductAuthenticationError));
  assert.equal((await factor(userId))?.failed, 0);
  assert.equal((await events('identity.mfa-verify-failed', userId)).length, 0);
  assert.ok(await alive(secret));
});

test('keys: boot refuses uncovered key ids; a verify re-encrypts under the current key', async () => {
  const { userId, raw, step } = await enrolled();
  await mfa.verifyKeyCoverage();
  const other = new ProductMfaService(identity, parseMfaKeyRing(`k2:${keyB}`, 'k2'));
  await assert.rejects(other.verifyKeyCoverage(), /MFA key/);
  const rotated = new ProductMfaService(identity, parseMfaKeyRing(`k1:${keyA},k2:${keyB}`, 'k2'));
  await rotated.verify(await session(userId), { code: hotp(raw, step) }, ip());
  assert.equal((await factor(userId))?.key, 'k2');
  await rotated.verifyKeyCoverage();
  // Tampered ciphertext is a server fault: no step-up and no failure counted.
  await pools.identity.query(`UPDATE mfa_totp SET secret_ciphertext=$2 WHERE user_id=$1`, [
    userId,
    randomBytes(36),
  ]);
  const victim = await session(userId);
  const error = await rotated.verify(victim, { code: hotp(raw, step + 1n) }, ip()).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof Error && !(error instanceof ProductAuthenticationError));
  assert.equal((await factor(userId))?.failed, 0);
  assert.equal((await alive(victim))?.fresh, false);

  // A setup sealed under the old key and confirmed after the rotation is re-encrypted too.
  const pending = await account();
  const setup = await mfa.setup(pending.secret, ip());
  assert.equal((await factor(pending.userId))?.key, 'k1');
  const now = await stableStep();
  await rotated.confirm(pending.secret, hotp(base32Decode(setup.secret), now), ip());
  assert.deepEqual(
    [(await factor(pending.userId))?.key, (await factor(pending.userId))?.confirmed],
    ['k2', true],
  );
});

test('offline reset: identity resets IAM only, bootstrap resets Root only', async () => {
  const approval = { approval: 'CHG-1', reason: 'lost device and codes' };
  const iam = await enrolled();
  const before = await epoch(iam.userId);
  assert.deepEqual(
    await resetProductMfa(
      runner,
      { operationId: randomUUID(), userId: iam.userId, ...approval },
      core,
      'identity',
    ),
    { reset: true },
  );
  assert.equal(BigInt((await epoch(iam.userId)) ?? 0), BigInt(before ?? 0) + 1n);
  assert.equal(await factor(iam.userId), undefined);
  assert.deepEqual(
    await resetProductMfa(
      runner,
      { operationId: randomUUID(), userId: iam.userId, ...approval },
      core,
      'identity',
    ),
    { reset: false },
  );
  const [event] = await events('identity.mfa-reset', '00000000-0000-4000-8000-000000000001');
  assert.equal(event?.metadata.targetUserId, iam.userId);
  assert.equal(event?.metadata.approval, 'CHG-1');
  assert.equal(event?.reason, 'lost device and codes');
  // Like root.revoke: operation, approval and target only; the email (PII) stays out.
  assert.deepEqual(Object.keys(event?.metadata ?? {}).sort(), [
    'approval',
    'operationId',
    'resultingRevision',
    'targetUserId',
  ]);
  assert.ok(!JSON.stringify(event).includes('@'));
  await assert.rejects(
    resetProductMfa(
      runner,
      { operationId: randomUUID(), userId: iam.userId, ...approval },
      core,
      'bootstrap',
    ),
  );
  await assert.rejects(
    resetProductMfa(
      runner,
      { operationId: randomUUID(), userId: iam.userId, approval: '', reason: 'x' },
      core,
      'identity',
    ),
  );

  // Root: promoted by bootstrap, activated by identity, enrolled on the web like any account.
  const rootId = randomUUID();
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,'root@example.test','pending',true)`,
    [rootId],
  );
  await migration.query('INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)', [
    issuer,
    'root-subject',
    rootId,
  ]);
  await bootstrapProductRoot(runner, release, {
    operationId: randomUUID(),
    userId: rootId as IdentityId,
    method: 'oidc',
    issuer,
    subject: 'root-subject',
  });
  await pools.identity.query(`UPDATE app_user SET state='active' WHERE id=$1`, [rootId]);
  // Side effect of the reset branch (ADR 0026 §4): bootstrap may end the sessions of an active
  // Root that never held a second factor; that alone grants nothing and changes no other fact.
  const neverEnrolled = await epoch(rootId);
  await pools.bootstrap.query('UPDATE app_user SET auth_epoch=auth_epoch+1 WHERE id=$1', [rootId]);
  assert.equal(BigInt((await epoch(rootId)) ?? 0), BigInt(neverEnrolled ?? 0) + 1n);
  // Any other change by bootstrap in that UPDATE stays refused.
  assert.equal(
    await sqlState(
      pools.bootstrap.query(
        'UPDATE app_user SET auth_epoch=auth_epoch+1,email_verified=false WHERE id=$1',
        [rootId],
      ),
    ),
    '42501',
  );
  const rootSession = await session(rootId);
  const setup = await mfa.setup(rootSession, ip());
  const step = await stableStep();
  await mfa.confirm(rootSession, hotp(base32Decode(setup.secret), step), ip());
  // Bootstrap may not delete IAM factors nor end a Root's sessions while it holds a factor.
  assert.equal(
    await sqlState(
      pools.bootstrap.query('DELETE FROM mfa_totp WHERE user_id=$1', [(await enrolled()).userId]),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.bootstrap.query('UPDATE app_user SET auth_epoch=auth_epoch+1 WHERE id=$1', [rootId]),
    ),
    '42501',
  );
  await assert.rejects(
    resetProductMfa(
      runner,
      { operationId: randomUUID(), userId: rootId, ...approval },
      core,
      'identity',
    ),
  );
  assert.equal((await factor(rootId))?.confirmed, true);
  const rootEpoch = await epoch(rootId);
  assert.deepEqual(
    await resetProductMfa(
      runner,
      { operationId: randomUUID(), userId: rootId, ...approval },
      core,
      'bootstrap',
    ),
    { reset: true },
  );
  assert.equal(BigInt((await epoch(rootId)) ?? 0), BigInt(rootEpoch ?? 0) + 1n);
  assert.equal(await factor(rootId), undefined);
  const [codes] = await migration.query<{ n: string }[]>(
    'SELECT count(*)::text n FROM mfa_recovery_code WHERE user_id=$1',
    [rootId],
  );
  assert.equal(codes?.n, '0');
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('HTTP: session + CSRF on every route, exact bodies, 400/401/403/409, secrets shown once', async (t) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    MFA_ENCRYPTION_KEYS: `k1:${keyA}`,
    MFA_ENCRYPTION_KEY_ID: 'k1',
    OIDC_PROVIDERS_JSON: JSON.stringify([
      {
        issuer,
        clientId: 'fixture-client',
        redirectUri: `${origin}/api/auth/oidc/callback`,
        version: '1',
        assuranceMappings: [],
      },
    ]),
    ...Object.fromEntries(
      (['data', 'identity', 'authority', 'sync'] as const).map((p) => [
        `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
        `postgres://product_${p}:unused@127.0.0.1:1/product`,
      ]),
    ),
  });
  // The runtime as ProductRuntime.create composes it, over this file's pools (see sign-in spec).
  const Runtime = ProductRuntime as unknown as new (...args: unknown[]) => ProductRuntime;
  const runtime = new Runtime(
    config,
    core,
    pools,
    runner,
    identity,
    new ProductOidcService(identity, new Map()),
  );
  Object.assign(runtime, {
    onApplicationBootstrap: () => Promise.resolve(runtime.readiness.markReady()),
    onApplicationShutdown: () => Promise.resolve(),
  });
  const app: INestApplication = await NestFactory.create(AppModule.register(runtime), {
    logger: false,
    abortOnError: false,
  });
  t.after(() => app.close());
  await app.listen(port, '127.0.0.1');

  const jar = new Map<string, string>();
  let csrf = '';
  /** Max-Age of the last session cookie the server set (ADR 0026 §5: from the old deadline). */
  let sessionMaxAge: number | undefined;

  const request = async (path: string, method = 'POST', body?: unknown, withCsrf = true) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        origin,
        ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [first = ''] = cookie.split(';');
      const index = first.indexOf('=');
      jar.set(first.slice(0, index), first.slice(index + 1));
      const maxAge = /;\s*Max-Age=(\d+)/i.exec(cookie)?.[1];
      if (first.startsWith('authz_session=') && maxAge !== undefined)
        sessionMaxAge = Number(maxAge);
    }
    return response;
  };

  const refused = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { statusCode: status, code });
  };

  csrf = ((await (await request('/api/auth/csrf', 'GET')).json()) as { csrfToken: string })
    .csrfToken;
  const routes = [
    ['/api/auth/mfa/totp/setup', 'POST'],
    ['/api/auth/mfa/totp/confirm', 'POST'],
    ['/api/auth/mfa/verify', 'POST'],
    ['/api/auth/mfa/recovery-codes', 'POST'],
    ['/api/auth/mfa/totp', 'DELETE'],
  ] as const;
  for (const [path, method] of routes)
    await refused(await request(path, method, {}), 401, 'error.authenticationFailed');

  const { userId, secret } = await account();
  jar.set('authz_session', secret);
  for (const [path, method] of routes)
    await refused(await request(path, method, {}, false), 403, 'error.accessDenied');

  const own = async () =>
    ((await (await request('/api/auth/account', 'GET')).json()) as { mfa: unknown }).mfa;

  assert.deepEqual(await own(), { status: 'none', recoveryCodesRemaining: 0 });
  await refused(
    await request('/api/auth/mfa/totp/setup', 'POST', { extra: 1 }),
    400,
    'error.invalidRequest',
  );
  const setup = await request('/api/auth/mfa/totp/setup', 'POST');
  assert.equal(setup.status, 200);
  const { uri, secret: shown } = (await setup.json()) as { uri: string; secret: string };
  assert.ok(uri.startsWith('otpauth://totp/HRM:'));
  const account2 = await request('/api/auth/account', 'GET');
  const text = await account2.text();
  assert.ok(!text.includes(shown), 'the secret is shown by setup only');
  assert.deepEqual((JSON.parse(text) as { mfa: unknown }).mfa, {
    status: 'pending',
    recoveryCodesRemaining: 0,
  });
  for (const body of [{ code: '12345' }, { code: '１２３４５６' }, { code: '123456', x: 1 }, {}])
    await refused(
      await request('/api/auth/mfa/totp/confirm', 'POST', body),
      400,
      'error.invalidRequest',
    );
  const raw = base32Decode(shown);
  const step = await stableStep();
  await refused(
    await request('/api/auth/mfa/totp/confirm', 'POST', { code: hotp(raw, step + 3n) }),
    401,
    'error.authenticationFailed',
  );
  const confirmed = await request('/api/auth/mfa/totp/confirm', 'POST', {
    code: hotp(raw, step - 1n),
  });
  assert.equal(confirmed.status, 200);
  const confirmedText = await confirmed.text();
  assert.ok(!confirmedText.includes(shown), 'the secret is shown by setup only');
  const body = JSON.parse(confirmedText) as { expiresAt: string; recoveryCodes: string[] };
  assert.equal(body.recoveryCodes.length, 10);
  assert.notEqual(jar.get('authz_session'), secret, 'confirmation rotates the session cookie');

  // The fixture session ends in 2 h: the cookie keeps that deadline, never a new 12 h one.
  const keepsDeadline = () =>
    assert.ok(
      sessionMaxAge !== undefined && sessionMaxAge > 7000 && sessionMaxAge <= 7200,
      `Max-Age ${sessionMaxAge}`,
    );

  keepsDeadline();
  const accountText = await (await request('/api/auth/account', 'GET')).text();
  for (const code of body.recoveryCodes)
    assert.ok(!accountText.includes(code), 'recovery codes are shown by confirm only');
  assert.deepEqual(await own(), { status: 'enabled', recoveryCodesRemaining: 10 });
  await refused(await request('/api/auth/mfa/totp/setup', 'POST'), 409, 'error.conflict');
  for (const proofBody of [
    { code: hotp(raw, step), recoveryCode: body.recoveryCodes[0] },
    { recoveryCode: 'not-a-code' },
    { recoveryCode: 42 },
  ])
    await refused(
      await request('/api/auth/mfa/verify', 'POST', proofBody),
      400,
      'error.invalidRequest',
    );
  sessionMaxAge = undefined;
  const verified = await request('/api/auth/mfa/verify', 'POST', { code: hotp(raw, step) });
  assert.equal(verified.status, 200);
  assert.deepEqual(Object.keys((await verified.json()) as object), ['expiresAt']);
  keepsDeadline();
  const regenerated = await request('/api/auth/mfa/recovery-codes', 'POST');
  assert.equal(regenerated.status, 200);
  assert.equal(
    ((await regenerated.json()) as { recoveryCodes: string[] }).recoveryCodes.length,
    10,
  );
  // A session without a recent step-up: 403 for regeneration and removal.
  const fresh = jar.get('authz_session') ?? '';
  jar.set('authz_session', await session(userId));
  await refused(await request('/api/auth/mfa/recovery-codes', 'POST'), 403, 'error.accessDenied');
  await refused(await request('/api/auth/mfa/totp', 'DELETE'), 403, 'error.accessDenied');
  jar.set('authz_session', fresh);
  sessionMaxAge = undefined;
  const removed = await request('/api/auth/mfa/totp', 'DELETE');
  assert.equal(removed.status, 200);
  keepsDeadline();
  assert.deepEqual(await own(), { status: 'none', recoveryCodesRemaining: 0 });
  await refused(
    await request('/api/auth/mfa/verify', 'POST', { code: '123456' }),
    409,
    'error.conflict',
  );
});
