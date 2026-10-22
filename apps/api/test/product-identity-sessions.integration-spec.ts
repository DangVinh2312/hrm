// Identity: opaque sessions, deadlines, idle activity and expired-session purge.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import {
  ProductAuthenticationError,
  newSessionSecret,
  purgeExpiredSessions,
  sessionDigest,
} from '../dist/auth/services/product-identity.service.js';
import {
  PRODUCT_OFFLINE_ACTOR,
  ProductAuditRepository,
} from '../dist/audit/product-audit.repository.js';
import { oidcSession } from './oidc-fixture.helper.ts';
import {
  pools,
  fixtureAdmin,
  identity,
  runner,
  provider,
  redirectUri,
  subject,
  responseFor,
  activeOidcUsers,
  setupStack,
  teardownStack,
} from './product-identity-stack.helper.ts';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

before(setupStack);
after(teardownStack);

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
    await assert.rejects(purgeExpiredSessions(runner, audit, retention, batch), RangeError);

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
  const purging = purgeExpiredSessions(runner, audit, 1, 2).then((n) => (purgedDuringReset = n));
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
    assert.equal(await purgeExpiredSessions(runner, audit, 1, 2), 2);
    assert.equal(await purgeExpiredSessions(runner, audit, 1, 2), 0);
  } finally {
    lock.release();
    await locking;
  }
  assert.equal(await purgeExpiredSessions(runner, audit, 1, 2), 1);
  assert.equal(await purgeExpiredSessions(runner, audit, 1, 2), 0);
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
