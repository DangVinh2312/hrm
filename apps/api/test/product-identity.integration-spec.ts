import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID, createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import * as oidc from 'openid-client';
import {
  productDataSourceOptions,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  ProductAuthenticationError,
  ProductIdentityService,
  newSessionSecret,
  purgeExpiredSessions,
  sessionDigest,
} from '../dist/auth/services/product-identity.service.js';
import { TransactionConflictError } from '../dist/database/helpers/transaction-errors.helper.js';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';

import {
  type ProductOidcProvider,
  ProductOidcService,
} from '../dist/auth/services/product-oidc.service.js';

import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { productObligations } from '../dist/authorization/helpers/product-obligations.helper.js';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
  productBindings,
} from '../dist/authorization/product.manifest.js';
import { ProductDocument1792108800002 } from '../dist/document/migrations/product-document.migration.js';
import { startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import { bindAccount, oidcSession } from './oidc-fixture.helper.ts';

let postgres: TestPostgres;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let fixtureAdmin: DataSource;
let connections: Awaited<ReturnType<typeof provisionProductDatabase>>;
let identity: ProductIdentityService;
let runner: ProductTransactionRunner;
let provider: ProductOidcProvider;
let federation: ProductOidcService;
let server: Server;
const issuer = 'https://issuer.fixture';
const redirectUri = 'https://app.fixture/oidc/callback';
const subject = 'exact-subject';
const userId = randomUUID();
const core = createProductAuthorizationCore();
const productRelease = createProductRelease(core);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  alg: 'RS256',
  use: 'sig',
};
const codes = new Map<
  string,
  { nonce: string; challenge: string; changes: Record<string, unknown>; badSignature: boolean }
>();
let tokenGate: (() => Promise<void>) | undefined;

function jwt(claims: Record<string, unknown>, badSignature: boolean): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${header}.${payload}.${badSignature ? Buffer.alloc(256).toString('base64url') : signature}`;
}

function responseFor(url: URL, changes: Record<string, unknown> = {}, badSignature = false): URL {
  const code = randomBytes(16).toString('hex');
  codes.set(code, {
    nonce: url.searchParams.get('nonce')!,
    challenge: url.searchParams.get('code_challenge')!,
    changes,
    badSignature,
  });
  const response = new URL(redirectUri);
  response.searchParams.set('state', url.searchParams.get('state')!);
  response.searchParams.set('code', code);
  return response;
}

before(async () => {
  postgres = await startPostgres();
  const secrets = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<
    'data' | 'identity' | 'authority' | 'sync' | 'bootstrap' | 'migration' | 'outbox',
    string
  >;
  connections = await provisionProductDatabase(postgres.superuser, secrets);
  pools = {} as typeof pools;
  for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[purpose] = await new DataSource(
      productDataSourceOptions(connections[purpose]),
    ).initialize();
  fixtureAdmin = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  runner = new ProductTransactionRunner(pools);
  identity = new ProductIdentityService(runner);
  await fixtureAdmin.query(
    `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,'user@example.test',true,'active')`,
    [userId],
  );
  await fixtureAdmin.query(`INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)`, [
    issuer,
  ]);
  server = createServer((req, res) => {
    void (async () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url !== '/token') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const input = new URLSearchParams(body);
      const code = input.get('code');
      const attempt = code ? codes.get(code) : undefined;
      if (
        !attempt ||
        createHash('sha256')
          .update(input.get('code_verifier') ?? '')
          .digest('base64url') !== attempt.challenge ||
        input.get('redirect_uri') !== redirectUri
      ) {
        res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      codes.delete(code!);
      await tokenGate?.();
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({
          access_token: 'fixture-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: jwt(
            {
              iss: issuer,
              sub: subject,
              aud: 'fixture-client',
              iat: now,
              exp: now + 300,
              auth_time: now,
              nonce: attempt.nonce,
              ...attempt.changes,
            },
            attempt.badSignature,
          ),
        }),
      );
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const configuration = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
    },
    'fixture-client',
    { id_token_signed_response_alg: 'RS256' },
    oidc.None(),
  );
  configuration[oidc.customFetch] = (input, init) => {
    const target = new URL(input);
    assert.equal(target.origin, issuer);
    return fetch(`http://127.0.0.1:${port}${target.pathname}`, {
      ...init,
      body:
        init.body instanceof URLSearchParams
          ? init.body.toString()
          : typeof init.body === 'string'
            ? init.body
            : init.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : undefined,
    });
  };
  provider = {
    settings: {
      issuer,
      clientId: 'fixture-client',
      redirectUri,
      version: '1',
      assuranceMappings: [{ acr: 'urn:fixture:mfa', amr: ['pwd', 'otp'], assurance: 'mfa' }],
    },
    configuration,
  };
  federation = new ProductOidcService(identity, new Map([[issuer, provider]]));
});
after(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  for (const source of Object.values(pools ?? {})) await source.destroy();
  await fixtureAdmin?.destroy();
  await postgres?.stop();
});

test('OIDC fixture validates a signed token with actual PKCE and nonce checks', async () => {
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const start = oidc.buildAuthorizationUrl(provider.configuration, {
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  const response = await oidc.authorizationCodeGrant(provider.configuration, responseFor(start), {
    pkceCodeVerifier: verifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  });
  assert.equal(response.claims()?.sub, subject);
});

test('opaque hash-only sessions: the DB keeps the digest; logout and logout-all fail closed', async () => {
  const [id] = await activeOidcUsers('opaque', 1);
  const session = await oidcSession(pools.identity, id!);
  const other = await oidcSession(pools.identity, id!);
  assert.equal((await runner.run('read', (tx) => identity.authenticate(tx, session))).userId, id);
  const stored = await pools.identity.query<{ token_hash: Buffer }[]>(
    'SELECT token_hash FROM application_session WHERE user_id=$1',
    [id],
  );
  assert.ok(stored.some((r) => r.token_hash.equals(sessionDigest(session))));
  assert.ok(stored.every((r) => !r.token_hash.toString('utf8').includes(session)));
  await identity.logout(session);
  await assert.rejects(
    runner.run('read', (tx) => identity.authenticate(tx, session)),
    ProductAuthenticationError,
  );
  assert.equal((await runner.run('read', (tx) => identity.authenticate(tx, other))).userId, id);
  const third = await oidcSession(pools.identity, id!);
  await identity.logout(third, true);
  for (const secret of [other, third])
    await assert.rejects(
      runner.run('read', (tx) => identity.authenticate(tx, secret)),
      ProductAuthenticationError,
    );
});

test('a limited client cannot grow the limiter or lock out other clients', async () => {
  const rows = async () =>
    (await pools.identity.query<{ n: number }[]>('SELECT count(*)::int n FROM rate_limit'))[0]!.n;

  const before = await rows();
  let rejected = 0;
  for (let i = 0; i < 100; i++)
    await identity
      .rateLimit('flooding-client', `flood${i}@example.test`, 'flood-fixture')
      .catch(() => rejected++);
  assert.equal(rejected, 80);
  // One client bucket plus the 20 identifier buckets it was allowed before being limited.
  assert.equal((await rows()) - before, 21);
  await identity.rateLimit('other-client', 'flood0@example.test', 'flood-fixture');
});

test('a full limiter evicts instead of denying every client', async () => {
  // Synthetic buckets from many sources, still inside their 15 minute window.
  await pools.identity.query(
    `INSERT INTO rate_limit(bucket_key,window_start,attempts)
     SELECT sha256(convert_to('saturation-fixture:'||g,'UTF8')),statement_timestamp()-interval '1 minute',1
     FROM generate_series(1,10000) g ON CONFLICT DO NOTHING`,
  );
  await identity.rateLimit('fresh-client', 'fresh@example.test', 'saturation-fixture');
  const [count] = await pools.identity.query<{ n: number }[]>(
    'SELECT count(*)::int n FROM rate_limit',
  );
  assert.ok(count!.n <= 10000, `limiter holds ${count!.n} rows`);
  await pools.identity.query(
    `DELETE FROM rate_limit WHERE bucket_key IN
     (SELECT sha256(convert_to('saturation-fixture:'||g,'UTF8')) FROM generate_series(1,10000) g)`,
  );
});

test('eviction drops the fewest attempts first: a flood cannot reset a used or locked bucket', async () => {
  for (let i = 0; i < 19; i++)
    await identity.rateLimit(`near-${i}`, 'near@example.test', 'lock-fixture');
  for (let i = 0; i < 20; i++)
    await identity.rateLimit(`locker-${i}`, 'locked@example.test', 'lock-fixture');
  await assert.rejects(
    identity.rateLimit('locker-next', 'locked@example.test', 'lock-fixture'),
    ProductAuthenticationError,
  );
  // Newer unlocked buckets from many sources fill the table.
  await pools.identity.query(
    `INSERT INTO rate_limit(bucket_key,window_start,attempts)
     SELECT sha256(convert_to('lock-flood:'||g,'UTF8')),statement_timestamp(),1
     FROM generate_series(1,10000) g ON CONFLICT DO NOTHING`,
  );
  await identity.rateLimit('fresh-locker', 'other@example.test', 'lock-fixture');
  // The bucket at 19 attempts survived: one more is allowed, then it locks.
  await identity.rateLimit('near-last', 'near@example.test', 'lock-fixture');
  await assert.rejects(
    identity.rateLimit('near-over', 'near@example.test', 'lock-fixture'),
    ProductAuthenticationError,
  );
  await assert.rejects(
    identity.rateLimit('another-locker', 'locked@example.test', 'lock-fixture'),
    ProductAuthenticationError,
  );
  await pools.identity.query(
    `DELETE FROM rate_limit WHERE bucket_key IN
     (SELECT sha256(convert_to('lock-flood:'||g,'UTF8')) FROM generate_series(1,10000) g)`,
  );
});

test('one IPv6 /48 shares 200 attempts across its /64 clients and all purposes', async () => {
  let accepted = 0;
  for (let i = 0; i < 220; i++)
    await identity
      .rateLimit(
        `2001:db8:48:${Math.floor(i / 19).toString(16)}::1`,
        `net${i}@example.test`,
        i % 2 ? 'net-a' : 'net-b',
      )
      .then(() => accepted++)
      .catch(() => undefined);
  assert.equal(accepted, 200);
  await identity.rateLimit('2001:db8:49::1', 'other-net@example.test', 'net-a');
});

test('database rate limiter is shared across service replicas', async () => {
  const replica = new ProductIdentityService(runner);
  for (let i = 0; i < 20; i++)
    await (i % 2 ? replica : identity).rateLimit(
      'replica-fixture',
      'limited@example.test',
      'limit-fixture',
    );
  await assert.rejects(
    replica.rateLimit('replica-fixture', 'limited@example.test', 'limit-fixture'),
    { message: 'Authentication failed' },
  );
});

test('limiter calls queued on the advisory lock do not hold the fence against a revoke', async () => {
  const [id] = await activeOidcUsers('queue', 1);
  const session = { secret: await oidcSession(pools.identity, id!) };
  await withClient(connections.identity, async (blocker) => {
    // Another session holds the limiter's advisory key, so limiter transactions queue behind it.
    await blocker.query('SELECT pg_advisory_lock(1379171467)');
    let queued: Promise<PromiseSettledResult<void>[]>;
    let revokeMs: number | undefined;
    try {
      queued = Promise.allSettled(
        [1, 2, 3].map((i) =>
          identity.rateLimit(`198.51.100.${40 + i}`, `queue${i}@example.test`, 'queue'),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const start = Date.now();
      const revoke = identity.logout(session.secret).then(() => (revokeMs = Date.now() - start));
      await Promise.race([revoke, new Promise((resolve) => setTimeout(resolve, 500))]);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(1379171467)');
    }
    const outcomes = await queued;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      revokeMs !== undefined && revokeMs < 500,
      `revoke blocked for ${revokeMs ?? '>500'} ms`,
    );
    assert.deepEqual(
      outcomes.map((o) => o.status),
      ['fulfilled', 'fulfilled', 'fulfilled'],
    );
  });
  await assert.rejects(
    runner.run('read', (tx) => identity.authenticate(tx, session.secret)),
    ProductAuthenticationError,
  );
});

test('real signed OIDC code+PKCE, claims rejection, state/browser replay, and no email linking', async () => {
  await pools.identity.query(
    `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`,
    [issuer, subject, userId],
  );
  const browser = newSessionSecret();
  const authorization = await federation.begin(issuer, browser, {}, 'oidc-success');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  // User decision (ADR 0020): openid email profile; only email/email_verified are ever read.
  assert.equal(authorization.searchParams.get('scope'), 'openid email profile');
  assert.equal(authorization.searchParams.get('claims'), null);
  const callback = responseFor(authorization);
  await assert.rejects(
    federation.callback(issuer, callback, newSessionSecret()),
    ProductAuthenticationError,
  );
  const session = await federation.callback(undefined, callback, browser);
  assert.ok(session);
  const actor = await runner.run('read', (tx) => identity.authenticate(tx, session.secret));
  assert.equal(actor.userId, userId);
  assert.equal(actor.assurance, 'oidc');
  await new ProductManifestReconciler(runner, {
    core,
    actor: userId as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(productRelease);
  const migration = fixtureAdmin.createQueryRunner();
  await new ProductDocument1792108800002().up(migration);
  await migration.release();
  const objectId = randomUUID();
  await runner.run('admin', async (tx) => {
    await tx.manager.query(
      "INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$2,'uuid',$3)",
      [objectId, Buffer.from('document'), Buffer.from(objectId)],
    );
    await tx.manager.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
      [randomUUID(), Buffer.from('document.read'), userId, Buffer.from('ownedDocuments')],
    );
  });
  await fixtureAdmin.query(
    "INSERT INTO document(id,object_id,owner_id,title,state) VALUES($1,$1,$2,'same authorization','draft')",
    [objectId, userId],
  );
  const authorizationService = new ProductAuthorization(
    runner,
    new ProductBindingRegistry(core, productRelease.declarations, productBindings),
    {
      validators: { 'fresh@1': (_parameters, input) => input.context.freshAuthentication === true },
      obligations: productObligations,
    },
  );
  // Another session of the same binding with baseline assurance: same authorization result.
  const baseline = await oidcSession(pools.identity, userId);
  assert.deepEqual(
    await authorizationService.list(session.secret, 'document', 'read'),
    await authorizationService.list(baseline, 'document', 'read'),
  );
  await runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
      [randomUUID(), Buffer.from('document.read'), userId, Buffer.from('ownedDocuments')],
    ),
  );
  assert.equal((await authorizationService.list(session.secret, 'document', 'read')).total, '0');
  assert.equal((await authorizationService.list(baseline, 'document', 'read')).total, '0');

  await assert.rejects(federation.callback(issuer, callback, browser), ProductAuthenticationError);
  for (const [index, changes, badSignature] of [
    [0, { iss: 'https://evil.fixture' }, false],
    [1, { aud: 'wrong-client' }, false],
    [2, { nonce: 'wrong-nonce' }, false],
    [3, { exp: 1 }, false],
    [4, {}, true],
    [
      5,
      {
        sub: 'unbound-subject',
        email: 'user@example.test',
        email_verified: true,
        groups: ['system.root'],
      },
      false,
    ],
    [6, { aud: ['fixture-client', 'other-client'], azp: 'other-client' }, false],
  ] as const) {
    const browserSecret = newSessionSecret();
    const start = await federation.begin(issuer, browserSecret, {}, `oidc-reject-${index}`);
    await assert.rejects(
      federation.callback(issuer, responseFor(start, changes, badSignature), browserSecret),
      ProductAuthenticationError,
    );
  }
  const mfaBrowser = newSessionSecret();
  const mfaStart = await federation.begin(issuer, mfaBrowser, {}, 'oidc-mfa');
  const mfa = await federation.callback(
    issuer,
    responseFor(mfaStart, { acr: 'urn:fixture:mfa', amr: ['pwd', 'otp'] }),
    mfaBrowser,
  );
  assert.ok(mfa);
  assert.equal(
    (await runner.run('read', (tx) => identity.authenticate(tx, mfa.secret))).assurance,
    'mfa',
  );
});

test('OIDC sessions and the fresh window are decided by the DB clock (ADR 0022)', async () => {
  const clockUser = randomUUID();
  await fixtureAdmin.query(
    `INSERT INTO app_user(id,email_canonical,state) VALUES($1,'clock@example.test','active')`,
    [clockUser],
  );
  await pools.identity.query(
    `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'clock-a',$2)`,
    [issuer, clockUser],
  );
  let attempts = 0;

  const client = () => `clock-${++attempts}`;

  const dbSeconds = async () =>
    Number(
      (
        await pools.identity.query<{ now: string }[]>(
          `SELECT floor(extract(epoch FROM statement_timestamp()))::bigint::text AS now`,
        )
      )[0]!.now,
    );

  /** Session row facts, all read and formatted by the DB. */
  const stored = async (secret: string) =>
    (
      await pools.identity.query<
        {
          expires: string;
          lifetime: number;
          authenticated: string | null;
          implicit: boolean;
          reauthenticated: boolean;
        }[]
      >(
        `SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires,
          extract(epoch FROM expires_at-created_at)::int lifetime,
          extract(epoch FROM authenticated_at)::bigint::text authenticated,
          authenticated_at=created_at implicit,
          reauthenticated_at IS NOT NULL reauthenticated
        FROM application_session WHERE token_hash=$1`,
        [sessionDigest(secret)],
      )
    )[0]!;

  /** Moves the session's reauthentication `age` into the past on the DB clock (no sleeping). */
  const reauthenticatedAgo = (secret: string, age: string | null) =>
    withClient(postgres.superuser, (c) =>
      c.query(
        `UPDATE application_session SET reauthenticated_at=statement_timestamp()-$2::interval WHERE token_hash=$1`,
        [sessionDigest(secret), age],
      ),
    );

  const live = (secret: string) => runner.run('read', (tx) => identity.authenticate(tx, secret));

  const signIn = async (changes: Record<string, unknown>) => {
    const browser = newSessionSecret();
    const start = await federation.begin(issuer, browser, {}, client());
    const session = await federation.callback(
      issuer,
      responseFor(start, { sub: 'clock-a', ...changes }),
      browser,
    );
    assert.ok(session);
    return session;
  };

  // Max-Age and expiresAt come from the creating statement; auth_time lands as to_timestamp().
  // A login never sets reauthenticated_at, however recent auth_time is (ADR 0027 §7).
  const at = (await dbSeconds()) - 10;
  const session = await signIn({ auth_time: at });
  const row = await stored(session.secret);
  assert.deepEqual(
    [session.maxAge, session.expiresAt, row.lifetime, row.authenticated, row.reauthenticated],
    [43200, row.expires, 43200, String(at), false],
  );
  assert.equal((await live(session.secret)).fresh, false);
  // No auth_time claim: authenticated_at is the statement time, not the API clock.
  const implicit = await signIn({ auth_time: undefined });
  assert.equal((await stored(implicit.secret)).implicit, true);
  // auth_time must be a non-negative safe integer; anything else fails closed.
  const now = await dbSeconds();
  for (const authTime of [now - 10 + 0.5, 2 ** 53, Number.MAX_SAFE_INTEGER, -1, String(now)])
    await assert.rejects(
      signIn({ auth_time: authTime }),
      ProductAuthenticationError,
      String(authTime),
    );

  // fresh: reauthenticated within the last 300 s by the DB clock. Never, exactly 300 s ago or in
  // the future (negative age) is not fresh; 290 s ago is.
  for (const age of [null, '300 seconds', '-60 seconds']) {
    await reauthenticatedAgo(session.secret, age);
    assert.equal((await live(session.secret)).fresh, false, String(age));
  }
  await reauthenticatedAgo(session.secret, '290 seconds');
  assert.equal((await live(session.secret)).fresh, true);
});

test('session absolute and idle deadlines fail closed; suspension ends every session', async () => {
  const [id] = await activeOidcUsers('expiry', 1);
  const expired = await oidcSession(pools.identity, id!);
  await runner.run('revoke', (tx) =>
    tx.manager.query(
      `UPDATE application_session SET last_seen_at=statement_timestamp()-interval '31 minutes' WHERE token_hash=$1`,
      [sessionDigest(expired)],
    ),
  );
  await assert.rejects(
    runner.run('read', (tx) => identity.authenticate(tx, expired)),
    ProductAuthenticationError,
  );
  const absolute = await oidcSession(pools.identity, id!);
  await runner.run('revoke', (tx) =>
    tx.manager.query(
      `UPDATE application_session SET created_at=statement_timestamp()-interval '13 hours',expires_at=statement_timestamp()-interval '1 hour' WHERE token_hash=$1`,
      [sessionDigest(absolute)],
    ),
  );
  await assert.rejects(
    runner.run('read', (tx) => identity.authenticate(tx, absolute)),
    ProductAuthenticationError,
  );
  // Suspension is an authority decision: with the new epoch no session of the account resolves.
  const live = await oidcSession(pools.identity, id!);
  await runner.run('admin', (tx) =>
    tx.manager.query(`UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`, [
      id,
    ]),
  );
  await assert.rejects(
    runner.run('read', (tx) => identity.authenticate(tx, live)),
    ProductAuthenticationError,
  );
});

test('provider revoke racing network exchange denies new session', async () => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const hold = new Promise<void>((resolve) => (release = resolve));
  tokenGate = async () => {
    entered();
    await hold;
  };
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, 'oidc-race');
  const login = federation.callback(issuer, responseFor(start), browser);
  await ready;
  await fixtureAdmin.transaction(async (manager) => {
    await manager.query('SELECT singleton FROM authz_state FOR UPDATE');
    await manager.query(
      `UPDATE oidc_provider SET enabled=false,version=version+1 WHERE issuer=$1`,
      [issuer],
    );
    await manager.query('UPDATE authz_state SET revision=revision+1');
  });
  release();
  try {
    await assert.rejects(login, ProductAuthenticationError);
  } finally {
    tokenGate = undefined;
    // Later tests sign in at this issuer: restore the row the provider config names (version 1).
    await fixtureAdmin.query(`UPDATE oidc_provider SET enabled=true,version=1 WHERE issuer=$1`, [
      issuer,
    ]);
  }
});

/** Active accounts, each with one Google binding at the fixture issuer; synthetic ids only. */
async function activeOidcUsers(prefix: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    await pools.identity.query(
      "INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,$2,true,'active')",
      [id, `${prefix}${i}-${id}@example.test`],
    );
    await bindAccount(pools.identity, id, `${prefix}-${id}`, issuer);
    ids.push(id);
  }
  return ids;
}

test('browsers behind one NAT address share its 20 OIDC begins per 15 minutes; every begin counts', async () => {
  // Current policy (ADR0008, operations §3): every attempt counts, not only failures. Sign-in is
  // Google only (ADR 0027), so the client bucket of purpose `oidc` is the one users share.
  for (let i = 0; i < 20; i++)
    await federation.begin(issuer, newSessionSecret(), {}, '198.51.100.7');
  await assert.rejects(
    federation.begin(issuer, newSessionSecret(), {}, '198.51.100.7'),
    ProductAuthenticationError,
  );
  // Another address is not limited by this one.
  await federation.begin(issuer, newSessionSecret(), {}, '198.51.100.8');
});

test('replicas with separate pools enforce one shared limit under concurrent attempts', async () => {
  const replicaPool = await new DataSource(
    productDataSourceOptions(connections.identity),
  ).initialize();
  try {
    const replica = new ProductIdentityService(
      new ProductTransactionRunner({ identity: replicaPool }),
    );

    const attempt = (i: number) =>
      (i % 2 ? replica : identity).rateLimit(
        `192.0.2.${i + 1}`,
        'replica-concurrent@example.test',
        'replica-concurrent',
      );

    const outcomes = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => attempt(i)));
    // Under a loaded host a queued attempt can exceed lock_timeout: it rolls back without counting
    // and is retried here one at a time. The shared cap must still be exactly 20.
    let accepted = 0;
    let refused = 0;
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') accepted++;
      else if (outcome.reason instanceof ProductAuthenticationError) refused++;
      else {
        assert.ok(outcome.reason instanceof TransactionConflictError);
        await attempt(i).then(
          () => accepted++,
          (error: unknown) => {
            assert.ok(error instanceof ProductAuthenticationError);
            refused++;
          },
        );
      }
    }
    assert.deepEqual([accepted, refused], [20, 10]);
  } finally {
    await replicaPool.destroy();
  }
});

test('data-only access does not touch idle activity; identity operations touch without extending expiry', async () => {
  const [id] = await activeOidcUsers('activity', 1);
  const session = { secret: await oidcSession(pools.identity, id!) };
  const digest = sessionDigest(session.secret);

  const stamp = async () =>
    (
      await pools.identity.query<{ seen: string; expires: string }[]>(
        `SELECT last_seen_at::text seen,expires_at::text expires FROM application_session WHERE token_hash=$1`,
        [digest],
      )
    )[0]!;

  await runner.run('revoke', (tx) =>
    tx.manager.query(
      `UPDATE application_session SET last_seen_at=statement_timestamp()-interval '10 minutes' WHERE token_hash=$1`,
      [digest],
    ),
  );
  const before = await stamp();
  for (let i = 0; i < 3; i++)
    await runner.run('read', (tx) => identity.authenticate(tx, session.secret));
  assert.deepEqual(await stamp(), before);
  await runner.run('identity', (tx) => identity.authenticate(tx, session.secret));
  const touched = await stamp();
  assert.ok(touched.seen > before.seen);
  assert.equal(touched.expires, before.expires);
  // A data-only user idle past 30 minutes is refused even while making data requests.
  await runner.run('revoke', (tx) =>
    tx.manager.query(
      `UPDATE application_session SET last_seen_at=statement_timestamp()-interval '31 minutes' WHERE token_hash=$1`,
      [digest],
    ),
  );
  await assert.rejects(
    runner.run('read', (tx) => identity.authenticate(tx, session.secret)),
    ProductAuthenticationError,
  );
});

test('expired sessions are purged in bounded batches; live, revoked-unexpired, recent and locked rows survive', async () => {
  const owner = randomUUID();
  await pools.identity.query(
    "INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,'purge@example.test',true,'active')",
    [owner],
  );

  const insert = async (expires: string, revoked = false) => {
    const secret = newSessionSecret();
    await pools.identity.query(
      `INSERT INTO application_session(token_hash,user_id,auth_epoch,method,assurance,external_issuer,external_subject,binding_version,provider_version,authenticated_at,created_at,expires_at,revoked_at)
       VALUES($1,$2,1,'oidc','oidc','https://issuer.fixture','purge-subject',1,1,statement_timestamp()-interval '30 days',statement_timestamp()-interval '30 days',statement_timestamp()+$3::interval,CASE WHEN $4 THEN statement_timestamp() END)`,
      [sessionDigest(secret), owner, expires, revoked],
    );
    return sessionDigest(secret);
  };

  const live = await insert('1 hour');
  const revokedLive = await insert('1 hour', true);
  const recent = await insert('-1 hour');
  for (let i = 0; i < 5; i++) await insert('-3 days');

  const countOwner = async () =>
    (
      await pools.identity.query<{ n: number }[]>(
        'SELECT count(*)::int n FROM application_session WHERE user_id=$1',
        [owner],
      )
    )[0]!.n;

  for (const [retention, batch] of [
    [-1, 10],
    [1.5, 10],
    [3651, 10],
    [1, 0],
    [1, 1001],
  ] as const)
    await assert.rejects(purgeExpiredSessions(runner, retention, batch), RangeError);

  const hold = () => {
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { inside, gate, release, entered };
  };

  // A password reset holds the exclusive fence: purge waits for its commit, then runs.
  const reset = hold();
  const resetting = runner.run('revoke', async (tx) => {
    await identity.invalidate(tx, owner);
    reset.entered();
    await reset.gate;
  });
  await reset.inside;
  let purgedDuringReset: number | undefined;
  const purging = purgeExpiredSessions(runner, 1, 2).then((n) => (purgedDuringReset = n));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(purgedDuringReset, undefined);
  reset.release();
  await resetting;
  assert.equal(await purging, 2);
  // The reset revoked every session of the owner, live ones included; none of those is purged.
  assert.equal(await countOwner(), 6);
  // A shared-fence identity transaction holding a row lock: purge skips that row, never waits.
  const [busy] = await pools.identity.query<{ token_hash: Buffer }[]>(
    "SELECT token_hash FROM application_session WHERE user_id=$1 AND expires_at<statement_timestamp()-interval '2 days' LIMIT 1",
    [owner],
  );
  const lock = hold();
  const locking = runner.run('identity', async (tx) => {
    await tx.manager.query('SELECT 1 FROM application_session WHERE token_hash=$1 FOR UPDATE', [
      busy!.token_hash,
    ]);
    lock.entered();
    await lock.gate;
  });
  await lock.inside;
  try {
    assert.equal(await purgeExpiredSessions(runner, 1, 2), 2);
    assert.equal(await purgeExpiredSessions(runner, 1, 2), 0);
  } finally {
    lock.release();
    await locking;
  }
  assert.equal(await purgeExpiredSessions(runner, 1, 2), 1);
  assert.equal(await purgeExpiredSessions(runner, 1, 2), 0);
  const left = await pools.identity.query<{ token_hash: Buffer }[]>(
    'SELECT token_hash FROM application_session WHERE user_id=$1',
    [owner],
  );
  assert.deepEqual(
    left.map((r) => r.token_hash.toString('hex')).sort(),
    [live, revokedLive, recent].map((d) => d.toString('hex')).sort(),
  );
  const events = await fixtureAdmin.query<
    { actor_id: string; safe_metadata: Record<string, string> }[]
  >(
    "SELECT actor_id,safe_metadata FROM audit_outbox WHERE event_kind=convert_to('identity.session-purge','UTF8') ORDER BY occurred_at",
  );
  assert.deepEqual(
    events.map((e) => [e.actor_id, e.safe_metadata.deleted, e.safe_metadata.retentionDays]),
    [
      [PRODUCT_OFFLINE_ACTOR, '2', '1'],
      [PRODUCT_OFFLINE_ACTOR, '2', '1'],
      [PRODUCT_OFFLINE_ACTOR, '1', '1'],
    ],
  );
  const [index] = await fixtureAdmin.query<{ n: number }[]>(
    "SELECT count(*)::int n FROM pg_indexes WHERE tablename='application_session' AND indexdef LIKE '%(expires_at)'",
  );
  assert.equal(index!.n, 1);
});
