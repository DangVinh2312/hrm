// ADR 0026: TOTP second factor and recovery codes against real PostgreSQL logins: migration 016
// guards/grants/probes, the DB clock step window, replay and races, the failure counter, sessions
// after a verify, the offline reset by identity (IAM) and bootstrap (Root), and key coverage.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { ProductMfaService } from '../dist/auth/services/product-mfa.service.js';
import { base32Decode, hotp } from '../dist/auth/helpers/totp.helper.js';
import { parseMfaKeyRing } from '../dist/auth/helpers/mfa-encryption.helper.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

export const core = createProductAuthorizationCore();

export const release = createProductRelease(core);

export const issuer = 'https://issuer.fixture';

export const keyA = randomBytes(32).toString('base64');

export const keyB = randomBytes(32).toString('base64');

export const ring = parseMfaKeyRing(`k1:${keyA}`, 'k1');

export let postgres: TestPostgres;

export let connections: Awaited<ReturnType<typeof provisionProductDatabase>>;

export let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;

export let migration: DataSource;

export let runner: ProductTransactionRunner;

export let identity: ProductIdentityService;

export let mfa: ProductMfaService;

export let client = 0;

/** A distinct client address per call site: the rate limiter must not couple unrelated tests. */
export const ip = () => `10.${Math.floor(++client / 250)}.${client % 250}.1`;

export const superuser = (sql: string, values: unknown[] = []) =>
  withClient(postgres.superuser, (c) => c.query({ text: sql, values }));

export const epoch = async (userId: string) =>
  (
    await migration.query<{ e: string }[]>('SELECT auth_epoch::text e FROM app_user WHERE id=$1', [
      userId,
    ])
  )[0]?.e;

export const factor = async (userId: string) =>
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

export const alive = (secret: string) =>
  runner
    .run('identity', (tx) => identity.authenticate(tx, secret))
    .then(
      (session) => session,
      (error: unknown) => {
        assert.ok(error instanceof ProductAuthenticationError);
        return undefined;
      },
    );

export const events = async (kind: string, actor: string) =>
  await migration.query<{ metadata: Record<string, string>; reason: string | null }[]>(
    `SELECT safe_metadata metadata,reason FROM audit_outbox WHERE event_kind=convert_to($1,'UTF8') AND actor_id=$2 ORDER BY occurred_at`,
    [kind, actor],
  );

/** OIDC session bound to the account's binding; `fresh` like a step-up 5 s ago (WSL clock). */
export async function session(userId: string, fresh = false): Promise<string> {
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
export async function account(): Promise<{ userId: string; secret: string }> {
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
export async function stableStep(): Promise<bigint> {
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
export async function enrolled(): Promise<{
  userId: string;
  secret: string;
  raw: Buffer;
  step: bigint;
}> {
  const { userId, secret } = await account();
  const setup = await mfa.setup(secret, ip());
  const raw = base32Decode(setup.secret);
  const step = await stableStep();
  const confirmed = await mfa.confirm(secret, hotp(raw, step - 1n), ip());
  return { userId, secret: confirmed.session.secret, raw, step };
}

export async function setupStack(): Promise<void> {
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
  identity = new ProductIdentityService(runner, audit);
  mfa = new ProductMfaService(identity, ring);
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(release);
  await migration.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [
    issuer,
  ]);
}

export async function teardownStack(): Promise<void> {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
}
