// ADR 0023 binding references and ADR 0027 step 2 (one Google binding per account, no link,
// unlink or Google step-up) against real PostgreSQL logins: migrations 014/015/017 grants,
// triggers and probes, and a signed RS256 fixture provider. The last test drives the remaining
// OIDC routes over HTTP through the real AppModule (in-process).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import * as oidc from 'openid-client';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  provisionProductDatabase,
  verifyProductPrivileges,
} from '../dist/database/helpers/product-database.helper.js';
import { protectBindingRefBody } from '../dist/database/migrations/014-sign-in-methods.migration.js';
import { ProductSingleGoogleBinding1792108800017 } from '../dist/database/migrations/017-single-google-binding.migration.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  ProductAuthenticationError,
  ProductIdentityService,
  newSessionSecret,
  sessionDigest,
} from '../dist/auth/services/product-identity.service.js';
import {
  type ProductOidcProvider,
  ProductOidcService,
} from '../dist/auth/services/product-oidc.service.js';
import {
  ProductManifestReconciler,
  bootstrapProductRoot,
  setRootEmail,
} from '../dist/authorization/services/product-manifest.service.js';
import { ReleaseRejectedError } from '../dist/authorization/helpers/release-content.helper.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { AppModule } from '../dist/app.module.js';
import { loadConfig } from '../dist/config/app.config.js';
import { ProductRuntime } from '../dist/infrastructure/product-runtime.service.js';
import { sqlState, startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';

const core = createProductAuthorizationCore();
const release = createProductRelease(core);

/** Current at the DB and in the runtime configuration. */
const issuer = 'https://issuer.fixture';
/** Second current provider. */
const second = 'https://second.fixture';
/** Enabled in the DB at version 2, configured at version 1: never usable. */
const stale = 'https://stale.fixture';
/** Configured, disabled in the DB. */
const disabled = 'https://disabled.fixture';
const redirectUri = 'https://app.fixture/api/auth/oidc/callback';

let postgres: TestPostgres;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;
let identity: ProductIdentityService;
let providers: Map<string, ProductOidcProvider>;
let federation: ProductOidcService;
let server: Server;
let port = 0;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};
const codes = new Map<
  string,
  { issuer: string; nonce: string; challenge: string; claims: Record<string, unknown> }
>();

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  const input = `${part({ alg: 'RS256', kid: 'fixture-key' })}.${part(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}

/** The provider's redirect back to the app for an authorization URL `begin` returned. */
function responseFor(url: URL, claims: Record<string, unknown>): URL {
  const code = randomBytes(16).toString('hex');
  codes.set(code, {
    issuer: url.origin,
    nonce: url.searchParams.get('nonce') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
    claims,
  });
  const response = new URL(url.searchParams.get('redirect_uri') ?? '');
  response.searchParams.set('state', url.searchParams.get('state') ?? '');
  response.searchParams.set('code', code);
  return response;
}

function fixtureProvider(at: string, version: string, redirect = redirectUri): ProductOidcProvider {
  const configuration = new oidc.Configuration(
    {
      issuer: at,
      authorization_endpoint: `${at}/authorize`,
      token_endpoint: `${at}/token`,
      jwks_uri: `${at}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
    },
    'fixture-client',
    { id_token_signed_response_alg: 'RS256' },
    oidc.None(),
  );
  configuration[oidc.customFetch] = (input, init) =>
    fetch(`http://127.0.0.1:${port}${new URL(input).pathname}`, {
      ...init,
      body: init.body instanceof URLSearchParams ? init.body.toString() : init.body,
    } as RequestInit);
  return {
    settings: {
      issuer: at,
      clientId: 'fixture-client',
      redirectUri: redirect,
      version,
      assuranceMappings: [],
    },
    configuration,
  };
}

let clients = 0;

const client = () => `methods-${++clients}`;

const superuser = (sql: string, values: unknown[] = []) =>
  withClient(postgres.superuser, (c) => c.query(sql, values));

/** Active IAM account with a verified email unless told otherwise (bound by the caller). */
async function account(options: { email?: string | null; verified?: boolean } = {}) {
  const id = randomUUID();
  const email = options.email === undefined ? `${id}@example.test` : options.email;
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,$2,$3,'active')`,
    [id, email, options.verified ?? true],
  );
  return { id, email: email ?? '' };
}

/** Binds (issuer, subject) as the identity login does (column grant); returns its reference. */
async function bind(userId: string, at: string, subject: string): Promise<string> {
  const [row] = await pools.identity.query<{ ref: string }[]>(
    `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3) RETURNING binding_ref::text ref`,
    [at, subject, userId],
  );
  return row!.ref;
}

/** An OIDC session row for `userId` through an existing binding; fresh by default. */
async function session(
  userId: string,
  options: { fresh?: boolean; oidc: { issuer: string; subject: string } },
): Promise<string> {
  const secret = newSessionSecret();
  const reauthenticated =
    options.fresh === false ? 'NULL' : "statement_timestamp()-interval '5 seconds'";
  await pools.identity.query(
    `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,reauthenticated_at,expires_at)
       VALUES($1,$2,(SELECT auth_epoch FROM app_user WHERE id=$2),'oidc','oidc',$3,$4,
         (SELECT binding_version FROM external_identity WHERE issuer=$3 AND subject=$4),
         (SELECT version FROM oidc_provider WHERE issuer=$3),statement_timestamp(),${reauthenticated},statement_timestamp()+interval '1 hour')`,
    [sessionDigest(secret), userId, options.oidc.issuer, options.oidc.subject],
  );
  return secret;
}

const live = (secret: string) =>
  runner
    .run('read', (tx) => identity.authenticate(tx, secret))
    .then(
      () => true,
      (error: unknown) => {
        if (error instanceof ProductAuthenticationError) return false;
        throw error;
      },
    );

const verified = (sub: string, email: string) => ({ sub, email, email_verified: true });

const bindings = (userId: string) =>
  migration.query<
    { issuer: string; subject: string; enabled: boolean; ref: string; version: string }[]
  >(
    `SELECT issuer,subject,enabled,binding_ref::text ref,binding_version::text version FROM external_identity WHERE user_id=$1 ORDER BY issuer,subject`,
    [userId],
  );

const epoch = async (userId: string) =>
  (
    await migration.query<{ e: string }[]>('SELECT auth_epoch::text e FROM app_user WHERE id=$1', [
      userId,
    ])
  )[0]?.e;

const emailState = async (userId: string) =>
  (
    await migration.query<{ email: string | null; verified: boolean }[]>(
      'SELECT email_canonical email,email_verified verified FROM app_user WHERE id=$1',
      [userId],
    )
  )[0];

/** begin(login) + callback with these ID token claims at `at`. */
async function login(service: ProductOidcService, claims: Record<string, unknown>, at = issuer) {
  const browser = newSessionSecret();
  const start = await service.begin(at, browser, {}, client());
  return service.callback(at, responseFor(start, claims), browser);
}

/** The provider's error redirect (user cancelled): the attempt's state, `error`, no `code`. */
function cancelledFor(url: URL): URL {
  const response = new URL(url.searchParams.get('redirect_uri') ?? '');
  response.searchParams.set('state', url.searchParams.get('state') ?? '');
  response.searchParams.set('error', 'access_denied');
  return response;
}

const failure = (operation: Promise<unknown>) =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

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
  runner = new ProductTransactionRunner(pools);
  identity = new ProductIdentityService(runner);
  await new ProductManifestReconciler(runner, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(release);
  for (const [at, version, enabled] of [
    [issuer, 1, true],
    [second, 1, true],
    [stale, 2, true],
    [disabled, 1, false],
  ] as const)
    await migration.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,$2,$3)', [
      at,
      version,
      enabled,
    ]);
  server = createServer((req, res) => {
    (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') return void res.end(JSON.stringify({ keys: [jwk] }));
      if (req.url !== '/token') return void res.writeHead(404).end();
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      const code = input.get('code') ?? '';
      const attempt = codes.get(code);
      if (
        !attempt ||
        createHash('sha256')
          .update(input.get('code_verifier') ?? '')
          .digest('base64url') !== attempt.challenge
      )
        return void res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
      codes.delete(code);
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({
          access_token: 'fixture-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: jwt({
            iss: attempt.issuer,
            aud: 'fixture-client',
            iat: now,
            exp: now + 300,
            auth_time: now,
            nonce: attempt.nonce,
            sub: 'default-subject',
            ...attempt.claims,
          }),
        }),
      );
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  providers = new Map(
    [issuer, second, stale, disabled].map((at) => [at, fixtureProvider(at, '1')] as const),
  );
  federation = new ProductOidcService(identity, providers);
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
});

test('migration 014: unique immutable binding_ref, column grants, exact probes', async () => {
  await verifyProductPrivileges(pools);
  const owner = await account();
  const ref = await bind(owner.id, issuer, 'grant-subject');
  assert.match(ref, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Identity writes no column of a binding once it exists (migration 017: nothing re-enables or
  // disables one any more).
  assert.equal(
    await sqlState(
      pools.identity.query(
        `UPDATE external_identity SET enabled=false,binding_version=binding_version+1 WHERE binding_ref=$1`,
        [ref],
      ),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.identity.query(
        `UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE binding_ref=$1`,
        [ref],
      ),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.identity.query(`UPDATE external_identity SET user_id=$2 WHERE binding_ref=$1`, [
        ref,
        owner.id,
      ]),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      pools.identity.query(
        `INSERT INTO external_identity(issuer,subject,user_id,binding_ref) VALUES($1,'chosen-ref',$2,gen_random_uuid())`,
        [issuer, owner.id],
      ),
    ),
    '42501',
  );
  // The trigger refuses a changed reference to the table owner and to a superuser alike.
  assert.equal(
    await sqlState(
      migration.query(
        `UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE binding_ref=$1`,
        [ref],
      ),
    ),
    '42501',
  );
  assert.equal(
    await sqlState(
      superuser(`UPDATE external_identity SET binding_ref=gen_random_uuid() WHERE binding_ref=$1`, [
        ref,
      ]),
    ),
    '42501',
  );
  assert.equal((await bindings(owner.id))[0]?.ref, ref);
  const privilegeDrift = [
    [
      'GRANT UPDATE(binding_ref) ON external_identity TO product_identity',
      'REVOKE UPDATE(binding_ref) ON external_identity FROM product_identity',
    ],
    [
      'GRANT INSERT(binding_ref) ON external_identity TO product_identity',
      'REVOKE INSERT(binding_ref) ON external_identity FROM product_identity',
    ],
    [
      'GRANT UPDATE ON external_identity TO product_identity',
      'REVOKE UPDATE ON external_identity FROM product_identity',
    ],
    [
      'GRANT UPDATE(enabled,binding_version) ON external_identity TO product_identity',
      'REVOKE UPDATE(enabled,binding_version) ON external_identity FROM product_identity',
    ],
    [
      'REVOKE INSERT(user_id) ON external_identity FROM product_identity',
      'GRANT INSERT(user_id) ON external_identity TO product_identity',
    ],
    [
      'GRANT EXECUTE ON FUNCTION public.protect_binding_ref() TO PUBLIC',
      'REVOKE EXECUTE ON FUNCTION public.protect_binding_ref() FROM PUBLIC',
    ],
  ] as const;
  for (const [alter, restore] of privilegeDrift) {
    await superuser(alter);
    try {
      await assert.rejects(verifyProductPrivileges(pools), /privilege drift/, alter);
    } finally {
      await superuser(restore);
    }
    await verifyProductPrivileges(pools);
  }
  const trigger =
    'CREATE TRIGGER protect_binding_ref BEFORE UPDATE ON external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref()';

  const body = (text: string) =>
    `CREATE OR REPLACE FUNCTION public.protect_binding_ref() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$${text}$fn$`;

  const protectionDrift = [
    ['DROP TRIGGER protect_binding_ref ON external_identity', trigger],
    [
      'ALTER TABLE external_identity DISABLE TRIGGER protect_binding_ref',
      'ALTER TABLE external_identity ENABLE TRIGGER protect_binding_ref',
    ],
    [
      'DROP TRIGGER protect_binding_ref ON external_identity; CREATE TRIGGER protect_binding_ref BEFORE UPDATE OF user_id ON external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref()',
      `DROP TRIGGER protect_binding_ref ON external_identity; ${trigger}`,
    ],
    [body('BEGIN RETURN NEW; END'), body(protectBindingRefBody)],
    [
      'ALTER FUNCTION public.protect_binding_ref() SET search_path=public',
      'ALTER FUNCTION public.protect_binding_ref() SET search_path=pg_catalog,pg_temp',
    ],
    [
      'CREATE TRIGGER protect_binding_ref_copy BEFORE UPDATE ON external_identity FOR EACH ROW EXECUTE FUNCTION public.protect_binding_ref()',
      'DROP TRIGGER protect_binding_ref_copy ON external_identity',
    ],
  ] as const;
  for (const [alter, restore] of protectionDrift) {
    await superuser(alter);
    try {
      await assert.rejects(verifyProductPrivileges(pools), /protection drift/, alter);
    } finally {
      await superuser(restore);
    }
    await verifyProductPrivileges(pools);
  }
});

test('migration 015: identity never deletes bindings; an email change must advance auth_epoch for every login', async () => {
  await verifyProductPrivileges(pools);
  const owner = await account({ verified: false });
  const ref = await bind(owner.id, issuer, 'delete-subject');
  // A deleted and re-inserted tuple would come back under a new binding_ref (ADR 0023 §2).
  assert.equal(
    await sqlState(
      pools.identity.query(`DELETE FROM external_identity WHERE binding_ref=$1`, [ref]),
    ),
    '42501',
  );
  assert.equal((await bindings(owner.id))[0]?.ref, ref);
  const before = await epoch(owner.id);
  for (const sql of [
    `UPDATE app_user SET email_verified=true WHERE id=$1`,
    `UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch WHERE id=$1`,
    `UPDATE app_user SET email_canonical='moved-'||email_canonical,auth_epoch=auth_epoch WHERE id=$1`,
    `UPDATE app_user SET email_canonical=NULL WHERE id=$1`,
  ]) {
    assert.equal(await sqlState(pools.identity.query(sql, [owner.id])), '42501', sql);
    assert.equal(await sqlState(migration.query(sql, [owner.id])), '42501', sql);
    assert.equal(await sqlState(superuser(sql, [owner.id])), '42501', sql);
  }
  assert.deepEqual(await emailState(owner.id), { email: owner.email, verified: false });
  // Writing the same values is no change; a change with a new epoch passes.
  await migration.query(`UPDATE app_user SET email_verified=false WHERE id=$1`, [owner.id]);
  assert.equal(await epoch(owner.id), before);
  await pools.identity.query(
    `UPDATE app_user SET email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`,
    [owner.id],
  );
  assert.equal(await epoch(owner.id), String(BigInt(before!) + 1n));
  // Bootstrap reaches no IAM email, with or without a new epoch.
  for (const sql of [
    `UPDATE app_user SET email_canonical='boot-'||email_canonical,email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
    `UPDATE app_user SET email_verified=false WHERE id=$1`,
  ])
    assert.equal(await sqlState(pools.bootstrap.query(sql, [owner.id])), '42501', sql);
  assert.deepEqual(await emailState(owner.id), { email: owner.email, verified: true });
});

test('migration 017: one enabled Google binding per account, no link or reauth attempts, no link proofs', async () => {
  await verifyProductPrivileges(pools);
  const owner = await account();
  await bind(owner.id, issuer, 'single-first');
  // A second enabled binding is refused to every login, the owner and a superuser alike.
  assert.equal(
    await sqlState(
      pools.identity.query(
        `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'single-second',$2)`,
        [second, owner.id],
      ),
    ),
    '23505',
  );
  assert.equal(
    await sqlState(
      superuser(
        `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'single-second',$2)`,
        [second, owner.id],
      ),
    ),
    '23505',
  );
  // A disabled row (history of an earlier unlink) does not count.
  await migration.query(
    `INSERT INTO external_identity(issuer,subject,user_id,enabled) VALUES($1,'single-old',$2,false)`,
    [second, owner.id],
  );
  assert.deepEqual(
    (await bindings(owner.id)).map((b) => [b.subject, b.enabled]),
    [
      ['single-first', true],
      ['single-old', false],
    ],
  );
  // Only login and activation attempts remain; the session column of link/reauth is gone.
  for (const purpose of ['link', 'reauth'])
    assert.equal(
      await sqlState(
        pools.identity.query(
          `INSERT INTO oidc_login_attempt(state_hash,nonce,verifier,provider_issuer,provider_version,redirect_uri,expires_at,browser_hash,purpose)
           VALUES($1,'n','v',$2,1,$3,statement_timestamp()+interval '5 minutes',$4,$5)`,
          [randomBytes(32), issuer, redirectUri, randomBytes(32), purpose],
        ),
      ),
      '23514',
      purpose,
    );
  assert.equal(
    await sqlState(pools.identity.query('SELECT linking_session_hash FROM oidc_login_attempt')),
    '42703',
  );
  assert.equal(await sqlState(pools.identity.query('SELECT 1 FROM oidc_link_proof')), '42P01');

  // Preflight: the migration refuses a database where an account holds two enabled bindings,
  // before any change (dev data is fixed by hand first, ADR 0027 §6).
  await superuser('DROP INDEX public.uq_external_identity_one_enabled');
  try {
    await superuser(
      `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'single-second',$2)`,
      [second, owner.id],
    );
    const queryRunner = migration.createQueryRunner();
    await queryRunner.startTransaction();
    try {
      await assert.rejects(
        new ProductSingleGoogleBinding1792108800017().up(queryRunner),
        /more than one enabled Google binding/,
      );
    } finally {
      await queryRunner.rollbackTransaction();
      await queryRunner.release();
    }
  } finally {
    await superuser(`DELETE FROM external_identity WHERE issuer=$1 AND subject='single-second'`, [
      second,
    ]);
    await superuser(
      'CREATE UNIQUE INDEX uq_external_identity_one_enabled ON public.external_identity(user_id) WHERE enabled',
    );
  }
  await verifyProductPrivileges(pools);
});

test('a provider error (no code) consumes the login attempt once and stays a login failure', async () => {
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, client());
  // Another browser does not spend the attempt; the right one does, once.
  assert.ok(
    (await failure(federation.callback(issuer, cancelledFor(start), newSessionSecret()))) instanceof
      ProductAuthenticationError,
  );
  assert.ok(
    (await failure(federation.callback(issuer, cancelledFor(start), browser))) instanceof
      ProductAuthenticationError,
  );
  assert.ok(
    (await failure(
      federation.callback(issuer, responseFor(start, { sub: 'cancel-subject' }), browser),
    )) instanceof ProductAuthenticationError,
  );
  // An error redirect carrying a code, or two states, is malformed and spends nothing.
  const user = await account();
  await bind(user.id, issuer, 'cancel-subject');
  const other = newSessionSecret();
  const next = await federation.begin(issuer, other, {}, client());
  const both = responseFor(next, { sub: 'cancel-subject' });
  both.searchParams.set('error', 'access_denied');
  assert.ok(
    (await failure(federation.callback(issuer, both, other))) instanceof ProductAuthenticationError,
  );
  const twice = cancelledFor(next);
  twice.searchParams.append('state', 'other');
  assert.ok(
    (await failure(federation.callback(issuer, twice, other))) instanceof
      ProductAuthenticationError,
  );
  assert.ok(await federation.callback(issuer, responseFor(next, { sub: 'cancel-subject' }), other));
});

test('Root enrolled by subject (no email): activation and login sessions are never fresh; one binding by reference', async () => {
  const rootId = randomUUID() as IdentityId;
  await migration.query(`INSERT INTO app_user(id,state) VALUES($1,'pending')`, [rootId]);
  const rootRef = await bind(rootId, issuer, 'root-subject');
  const { activationSecret } = await bootstrapProductRoot(runner, release, {
    operationId: randomUUID(),
    userId: rootId,
    method: 'oidc',
    issuer,
    subject: 'root-subject',
  });
  assert.ok(activationSecret);
  const browser = newSessionSecret();
  const start = await federation.begin(
    issuer,
    browser,
    { purpose: 'activation', activationToken: activationSecret },
    client(),
  );
  const activated = await federation.callback(
    issuer,
    responseFor(start, { sub: 'root-subject' }),
    browser,
  );
  assert.ok(activated);
  // ADR 0027 §7: no OIDC callback sets reauthenticated_at; `fresh` only comes from 2FA.
  const signedIn = await login(federation, { sub: 'root-subject' });
  assert.ok(signedIn);
  for (const secret of [activated.secret, signedIn.secret]) {
    const [row] = await migration.query<{ reauthenticated: boolean }[]>(
      'SELECT reauthenticated_at IS NOT NULL reauthenticated FROM application_session WHERE token_hash=$1',
      [sessionDigest(secret)],
    );
    assert.equal(row?.reauthenticated, false);
  }
  assert.equal(
    (await runner.run('read', (tx) => identity.authenticate(tx, signedIn.secret))).fresh,
    false,
  );
  assert.deepEqual((await federation.ownAccount(signedIn.secret)).identities, [
    { issuer, reference: rootRef },
  ]);
});

test('set-root-email: the Root by subject gets an unverified email and loses every session; bootstrap may do nothing else', async () => {
  const [marker] = await migration.query<{ id: string }[]>(
    'SELECT target_user_id::text id FROM security_bootstrap_state',
  );
  const rootId = marker!.id as IdentityId;
  const rootSession = await session(rootId, { oidc: { issuer, subject: 'root-subject' } });
  const iam = await account();

  const set = (userId: string, email: string) =>
    setRootEmail(runner, { operationId: randomUUID(), userId: userId as IdentityId, email }, core);

  const reason = async (operation: Promise<unknown>) => {
    const error = await failure(operation);
    assert.ok(error instanceof ReleaseRejectedError, String(error));
    return error.reason;
  };

  const events = async () =>
    (
      await superuser(
        `SELECT safe_metadata metadata FROM audit_outbox WHERE event_kind=convert_to('root.set-email','UTF8')`,
      )
    ).rows as { metadata: Record<string, string> }[];

  const before = await epoch(rootId);

  assert.equal(await reason(set(iam.id, 'iam-target@example.test')), 'collision');
  assert.equal(await reason(set(randomUUID(), 'nobody@example.test')), 'collision');
  for (const email of ['not-an-email', ' root@example.test', `${'a'.repeat(250)}@x.test`, ''])
    assert.equal(await reason(set(rootId, email)), 'invalid_release', email);
  assert.equal(
    await reason(
      setRootEmail(
        runner,
        { operationId: 'not-a-uuid', userId: rootId, email: 'root@example.test' },
        core,
      ),
    ),
    'invalid_release',
  );
  // Another account's email: the UNIQUE constraint refuses it.
  assert.equal(await reason(set(rootId, iam.email.toUpperCase())), 'collision');
  // A failing audit write rolls everything back.
  await superuser('REVOKE INSERT ON audit_outbox FROM product_bootstrap');
  try {
    await assert.rejects(
      set(rootId, 'root.owner@example.test'),
      (error: unknown) => !(error instanceof ReleaseRejectedError),
    );
  } finally {
    await superuser('GRANT INSERT ON audit_outbox TO product_bootstrap');
  }
  assert.deepEqual(await emailState(rootId), { email: null, verified: false });
  assert.deepEqual(await emailState(iam.id), { email: iam.email, verified: true });
  assert.equal(await epoch(rootId), before);
  assert.equal(await live(rootSession), true);
  assert.deepEqual(await events(), []);

  const operationId = randomUUID();
  assert.deepEqual(
    await setRootEmail(
      runner,
      { operationId, userId: rootId, email: 'Root.Owner@Example.Test' },
      core,
    ),
    { changed: true },
  );
  assert.deepEqual(await emailState(rootId), {
    email: 'root.owner@example.test',
    verified: false,
  });
  assert.equal(await epoch(rootId), String(BigInt(before!) + 1n));
  assert.equal(await live(rootSession), false);
  const [event] = await events();
  assert.deepEqual(event?.metadata, {
    targetUserId: rootId,
    operationId,
    resultingRevision: event?.metadata.resultingRevision,
  });
  // A rerun with the same email changes nothing and audits nothing.
  assert.deepEqual(await set(rootId, 'root.owner@example.test'), { changed: false });
  assert.equal(await epoch(rootId), String(BigInt(before!) + 1n));
  assert.equal((await events()).length, 1);
  // The narrowed guard: only an email change to an unverified address, same state, new epoch.
  // (Since migration 016 an epoch-only change is allowed for a Root without a second factor,
  // ADR 0026 §4; refused while it holds one: product-mfa.integration-spec.ts.)
  for (const sql of [
    `UPDATE app_user SET email_canonical='root.other@example.test',email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1`,
    `UPDATE app_user SET email_canonical=NULL,email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
    `UPDATE app_user SET email_canonical='root.other@example.test',email_verified=false,auth_epoch=auth_epoch WHERE id=$1`,
    `UPDATE app_user SET email_canonical='root.other@example.test',email_verified=false WHERE id=$1`,
    `UPDATE app_user SET state='pending',email_canonical='root.other@example.test',email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
  ])
    assert.equal(await sqlState(pools.bootstrap.query(sql, [rootId])), '42501', sql);
  assert.deepEqual(await emailState(rootId), {
    email: 'root.owner@example.test',
    verified: false,
  });
});

test('a verified Google email equal to the account email verifies it once and ends other sessions', async () => {
  // Root (email set by the test above, unverified): a mismatching or unverified claim changes nothing.
  const [marker] = await migration.query<{ id: string }[]>(
    'SELECT target_user_id::text id FROM security_bootstrap_state',
  );
  const rootId = marker!.id;
  const rootEmail = (await emailState(rootId))!.email!;
  const start = await epoch(rootId);
  for (const claims of [
    { sub: 'root-subject', email: rootEmail, email_verified: false },
    { sub: 'root-subject', email: rootEmail, email_verified: 'true' },
    verified('root-subject', 'someone.else@example.test'),
    { sub: 'root-subject' },
  ])
    assert.ok(await login(federation, claims), JSON.stringify(claims));
  assert.equal(await epoch(rootId), start);
  assert.equal((await emailState(rootId))?.verified, false);
  const earlier = await session(rootId, { oidc: { issuer, subject: 'root-subject' } });
  const signedIn = await login(federation, verified('root-subject', rootEmail.toUpperCase()));
  assert.ok(signedIn);
  assert.deepEqual(await emailState(rootId), { email: rootEmail, verified: true });
  assert.equal(await epoch(rootId), String(BigInt(start!) + 1n));
  assert.equal(await live(earlier), false);
  assert.equal(await live(signedIn.secret), true);
  // Verified: later logins change nothing.
  assert.ok(await login(federation, verified('root-subject', rootEmail)));
  assert.equal(await epoch(rootId), String(BigInt(start!) + 1n));
  assert.equal(await live(signedIn.secret), true);
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

test('HTTP: fixed callback targets, removed link and reauth routes are 404, account projection without subject or removable', async (t) => {
  const appPort = await freePort();
  const origin = `http://127.0.0.1:${appPort}`;
  const callbackUri = `${origin}/api/auth/oidc/callback`;
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    MFA_ENCRYPTION_KEYS: `fixture:${randomBytes(32).toString('base64')}`,
    MFA_ENCRYPTION_KEY_ID: 'fixture',
    OIDC_PROVIDERS_JSON: JSON.stringify([
      {
        issuer,
        clientId: 'fixture-client',
        redirectUri: callbackUri,
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
  const service = new ProductOidcService(
    identity,
    new Map([[issuer, fixtureProvider(issuer, '1', callbackUri)]]),
  );
  // The runtime as ProductRuntime.create composes it, over this file's pools; its bootstrap
  // (privilege probe of application tables, manifest sync) is covered elsewhere.
  const Runtime = ProductRuntime as unknown as new (...args: unknown[]) => ProductRuntime;
  const runtime = new Runtime(config, core, pools, runner, identity, service);
  Object.assign(runtime, {
    onApplicationBootstrap: () => Promise.resolve(runtime.readiness.markReady()),
    onApplicationShutdown: () => Promise.resolve(),
  });
  const app: INestApplication = await NestFactory.create(AppModule.register(runtime), {
    logger: false,
    abortOnError: false,
  });
  t.after(() => app.close());
  await app.listen(appPort, '127.0.0.1');

  const user = await account();
  await bind(user.id, issuer, 'http-subject');
  const jar = new Map<string, string>();
  let csrf = '';

  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      redirect: 'manual',
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        origin,
        'x-csrf-token': csrf,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';')[0]!;
      const index = first.indexOf('=');
      jar.set(first.slice(0, index), first.slice(index + 1));
    }
    return response;
  };

  /** begin over HTTP, then the provider's answer (code or error) back to the callback. */
  const signIn = async (answer: (start: URL) => URL) => {
    const begun = await request('/api/auth/oidc/begin', 'POST', { issuer });
    assert.equal(begun.status, 200);
    const { authorizationUrl } = (await begun.json()) as { authorizationUrl: string };
    const back = answer(new URL(authorizationUrl));
    return request(back.pathname + back.search);
  };

  const removed = [
    ['/api/auth/oidc/link', 'POST'],
    ['/api/auth/oidc/link/pending', 'GET'],
    ['/api/auth/oidc/link/pending', 'DELETE'],
    ['/api/auth/oidc/link/confirm', 'POST'],
    ['/api/auth/oidc/unlink', 'POST'],
    ['/api/auth/oidc/reauthenticate', 'POST'],
    // ADR 0027 §2: local sign-in is gone too.
    ['/api/auth/login', 'POST'],
    ['/api/auth/activate', 'POST'],
    ['/api/auth/reauthenticate', 'POST'],
    ['/api/auth/password', 'POST'],
    ['/api/auth/recovery/request', 'POST'],
    ['/api/auth/recovery/reset', 'POST'],
  ] as const;

  const notFound = async () => {
    for (const [path, method] of removed) {
      const response = await request(path, method, method === 'GET' ? undefined : { issuer });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { statusCode: 404, code: 'error.notFound' });
    }
  };

  csrf = ((await (await request('/api/auth/csrf')).json()) as { csrfToken: string }).csrfToken;
  await notFound();
  // ADR 0027 §1: one sign-in method; the shape of the public options stays.
  const options = await request('/api/auth/options');
  assert.equal(options.status, 200);
  assert.deepEqual(await options.json(), { methods: ['oidc'] });
  // No attempt (unknown state), or a cancelled login: the login page.
  const unknown = await request('/api/auth/oidc/callback?state=unknown-state&code=x');
  assert.equal(unknown.status, 303);
  assert.equal(unknown.headers.get('location'), '/login?error=oidc');
  const cancelled = await signIn(cancelledFor);
  assert.equal(cancelled.status, 303);
  assert.equal(cancelled.headers.get('location'), '/login?error=oidc');
  const signedIn = await signIn((start) =>
    responseFor(start, verified('http-subject', user.email)),
  );
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/');
  assert.equal((await request('/api/auth/session')).status, 200);
  // Signed in, the removed routes are still unknown (not 401/403: nothing is left to refuse).
  await notFound();

  const own = await request('/api/auth/account');
  assert.equal(own.status, 200);
  const ownBody = (await own.json()) as { identities: Record<string, unknown>[] };
  assert.equal(JSON.stringify(ownBody).includes('http-subject'), false);
  // ADR 0026 §8: the projection also carries the second factor status, nothing more of it.
  assert.deepEqual(Object.keys(ownBody).sort(), ['email', 'identities', 'mfa']);
  assert.deepEqual((ownBody as { mfa?: unknown }).mfa, {
    status: 'none',
    recoveryCodesRemaining: 0,
  });
  // ADR 0027 §6: nothing is removable any more, so the flag is gone.
  assert.deepEqual(
    ownBody.identities.map((i) => Object.keys(i).sort()),
    [['issuer', 'reference']],
  );
});
