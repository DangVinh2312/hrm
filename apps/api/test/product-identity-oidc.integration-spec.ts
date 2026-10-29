// Identity: real signed OIDC code+PKCE flow, DB-clock freshness and provider revoke.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ProductAuthenticationError,
  newSessionSecret,
  sessionDigest,
} from '../dist/authentication/services/product-identity.service.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { productBindings } from '../dist/authorization/product.manifest.js';
import { documentFixtureSql } from '../dist/database/migrations/002-application-baseline.migration.js';
import { withClient } from './setup-postgres.ts';
import { oidcSession } from './oidc-fixture.helper.ts';
import {
  postgres,
  pools,
  fixtureAdmin,
  identity,
  runner,
  federation,
  issuer,
  subject,
  userId,
  core,
  productRelease,
  setTokenGate,
  responseFor,
  setupStack,
  teardownStack,
} from './product-identity-stack.helper.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();
const productObligations = createProductObligations(audit);

before(setupStack);
after(teardownStack);

test('real signed OIDC code+PKCE, claims rejection, state/browser replay, and no email linking', async () => {
  await pools.identity.query(
    `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`,
    [issuer, subject, userId],
  );
  const browser = newSessionSecret();
  const authorization = await federation.begin(issuer, browser, {}, 'oidc-success');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  // User decision: openid email profile; only email/email_verified are ever read.
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
  await new ProductManifestReconciler(runner, audit, {
    core,
    actor: userId as IdentityId,
    capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
  }).reconcile(productRelease);
  const migration = fixtureAdmin.createQueryRunner();
  await migration.query(documentFixtureSql);
  await migration.release();
  const objectId = randomUUID();
  await runner.run('admin', async (tx) => {
    await tx.manager.query(
      "INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$2,'uuid',$3)",
      [objectId, Buffer.from('document'), Buffer.from(objectId)],
    );
  });
  await fixtureAdmin.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
    [randomUUID(), Buffer.from('document.read'), userId, Buffer.from('ownedDocuments')],
  );
  await fixtureAdmin.query(
    "INSERT INTO document(id,object_id,owner_id,title,state) VALUES($1,$1,$2,'same authorization','draft')",
    [objectId, userId],
  );
  const authorizationService = new ProductAuthorization(
    runner,
    audit,
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
  await fixtureAdmin.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
    [randomUUID(), Buffer.from('document.read'), userId, Buffer.from('ownedDocuments')],
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

test('OIDC sessions and the fresh window are decided by the DB clock', async () => {
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
  // A login never sets reauthenticated_at, however recent auth_time is.
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

test('provider revoke racing network exchange denies new session', async () => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const hold = new Promise<void>((resolve) => (release = resolve));
  setTokenGate(async () => {
    entered();
    await hold;
  });
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
    setTokenGate(undefined);
    // Later tests sign in at this issuer: restore the row the provider config names (version 1).
    await fixtureAdmin.query(`UPDATE oidc_provider SET enabled=true,version=1 WHERE issuer=$1`, [
      issuer,
    ]);
  }
});
