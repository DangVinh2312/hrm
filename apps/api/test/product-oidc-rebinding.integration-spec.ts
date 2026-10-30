// A pending account whose Google binding was disabled can be re-enrolled with a different Google
// (liveEnrollment ignores disabled bindings); the old (issuer, sub) pair stays dead.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ProductAuthenticationError,
  newSessionSecret,
} from '../dist/authentication/services/product-identity.service.js';
import {
  fixtureAdmin,
  federation,
  issuer,
  pools,
  responseFor,
  setTokenGate,
  setupStack,
  teardownStack,
} from './product-identity-stack.helper.ts';

before(setupStack);
after(teardownStack);

let attempt = 0;

const login = async (claims: Record<string, unknown>) => {
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, `rebind-${++attempt}`);
  return federation.callback(issuer, responseFor(start, claims), browser);
};

const verified = (sub: string, email: string) => ({ sub, email, email_verified: true });

/** An account as it stands after a binding reset: old binding disabled, pending, invited again. */
async function resetAccount(
  email: string,
  oldSub: string,
  options: { state?: 'pending' | 'suspended'; ttl?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await fixtureAdmin.query(
    `INSERT INTO app_user(id,email_canonical,email_verified,state) VALUES($1,$2,true,'active')`,
    [id, email],
  );
  await pools.identity.query(
    `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`,
    [issuer, oldSub, id],
  );
  await fixtureAdmin.query(
    `UPDATE external_identity SET enabled=false,binding_version=binding_version+1 WHERE user_id=$1`,
    [id],
  );
  await fixtureAdmin.query(`UPDATE app_user SET state=$2,auth_epoch=auth_epoch+1 WHERE id=$1`, [
    id,
    options.state ?? 'pending',
  ]);
  await fixtureAdmin.query(
    `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by)
     VALUES($1,$2,$3,statement_timestamp()+$4::interval,$1)`,
    [id, issuer, email, options.ttl ?? '7 days'],
  );
  return id;
}

const row = async (id: string) =>
  (
    await fixtureAdmin.query<{ state: string; enabled: string; subjects: string; n: string }[]>(
      `SELECT u.state,
        (SELECT count(*) FROM external_identity e WHERE e.user_id=u.id AND e.enabled)::text enabled,
        (SELECT string_agg(subject,',' ORDER BY subject) FROM external_identity e WHERE e.user_id=u.id) subjects,
        (SELECT count(*) FROM oidc_email_enrollment n WHERE n.user_id=u.id)::text n
       FROM app_user u WHERE u.id=$1`,
      [id],
    )
  )[0]!;

test('a new Google with the matching verified email activates a reset account exactly once', async () => {
  const email = 'rebind@example.test';
  const id = await resetAccount(email, 'old-a');
  const browser = newSessionSecret();
  const start = await federation.begin(issuer, browser, {}, 'rebind-replay');
  const callback = responseFor(start, verified('new-a', email));
  assert.ok(await federation.callback(issuer, callback, browser));
  assert.deepEqual(await row(id), {
    state: 'active',
    enabled: '1',
    subjects: 'new-a,old-a',
    n: '0',
  });
  await assert.rejects(federation.callback(issuer, callback, browser), ProductAuthenticationError);
  await assert.rejects(login(verified('new-b', email)), ProductAuthenticationError);
  assert.equal((await row(id)).subjects, 'new-a,old-a');
});

test('the old (issuer, sub) pair is refused both bound-branch and unbound-branch', async () => {
  const email = 'oldpair@example.test';
  const id = await resetAccount(email, 'old-b');
  // The old pair has a row: decided by the row (disabled), never by the enrollment.
  await assert.rejects(login(verified('old-b', email)), ProductAuthenticationError);
  assert.deepEqual(await row(id), { state: 'pending', enabled: '0', subjects: 'old-b', n: '1' });
  // After the new Google is bound, the old one still cannot come back.
  assert.ok(await login(verified('new-c', email)));
  await assert.rejects(login(verified('old-b', email)), ProductAuthenticationError);
  // A pending account with a fresh invitation and a free pair of the old binding is not reusable:
  // the pair of a disabled binding is rejected even when the enrollment matches.
  const other = await resetAccount('oldpair2@example.test', 'old-c');
  await assert.rejects(
    login(verified('old-c', 'oldpair2@example.test')),
    ProductAuthenticationError,
  );
  assert.equal((await row(other)).state, 'pending');
});

test('email claim, other email, expiry and suspension still refuse', async () => {
  const email = 'strict@example.test';
  const id = await resetAccount(email, 'old-d');
  for (const claims of [
    { sub: 'new-d', email, email_verified: false },
    { sub: 'new-d', email, email_verified: 'true' },
    { sub: 'new-d', email },
    { sub: 'new-d', email: 'other@example.test', email_verified: true },
  ])
    await assert.rejects(login(claims), ProductAuthenticationError, JSON.stringify(claims));
  assert.deepEqual(await row(id), { state: 'pending', enabled: '0', subjects: 'old-d', n: '1' });

  const late = await resetAccount('late-rebind@example.test', 'old-e', { ttl: '1 minute' });
  await fixtureAdmin.query(
    `UPDATE oidc_email_enrollment SET created_at=statement_timestamp()-interval '7 days',expires_at=statement_timestamp() WHERE user_id=$1`,
    [late],
  );
  await assert.rejects(
    login(verified('new-e', 'late-rebind@example.test')),
    ProductAuthenticationError,
  );

  const suspended = await resetAccount('held@example.test', 'old-f', { state: 'suspended' });
  await assert.rejects(login(verified('new-f', 'held@example.test')), ProductAuthenticationError);
  await assert.rejects(login(verified('old-f', 'held@example.test')), ProductAuthenticationError);
  assert.equal((await row(suspended)).state, 'suspended');
});

test('an account with an enabled binding does not match the enrollment', async () => {
  const email = 'enabled@example.test';
  const id = await resetAccount(email, 'old-g');
  await pools.identity.query(
    `INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,'live-g',$2)`,
    [issuer, id],
  );
  await assert.rejects(login(verified('new-g', email)), ProductAuthenticationError);
  assert.equal((await row(id)).subjects, 'live-g,old-g');
  assert.equal((await row(id)).n, '1');
});

test('two concurrent callbacks with different subs activate exactly one', async () => {
  const email = 'race-rebind@example.test';
  const id = await resetAccount(email, 'old-h');
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  setTokenGate(async () => {
    if (++arrived === 2) open();
    await gate;
  });
  try {
    const results = await Promise.allSettled([
      login(verified('race-a', email)),
      login(verified('race-b', email)),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof ProductAuthenticationError, String(rejected.reason));
  } finally {
    setTokenGate(undefined);
  }
  const final = await row(id);
  assert.equal(final.state, 'active');
  assert.equal(final.enabled, '1');
  assert.equal(final.subjects?.split(',').length, 2);
});
