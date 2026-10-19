// ADR 0026: audit rollback, key coverage and the offline reset.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ProductAuthenticationError } from '../dist/auth/services/product-identity.service.js';
import { ProductMfaService, resetProductMfa } from '../dist/auth/services/product-mfa.service.js';
import { base32Decode, hotp } from '../dist/auth/helpers/totp.helper.js';
import { parseMfaKeyRing } from '../dist/auth/helpers/mfa-encryption.helper.js';
import { sqlState } from './setup-postgres.ts';
import { bootstrapActiveRoot } from './oidc-fixture.helper.ts';
import {
  core,
  release,
  issuer,
  keyA,
  keyB,
  pools,
  migration,
  runner,
  identity,
  mfa,
  ip,
  superuser,
  epoch,
  factor,
  alive,
  events,
  session,
  account,
  stableStep,
  enrolled,
  setupStack,
  teardownStack,
} from './product-mfa-stack.helper.ts';

before(setupStack);
after(teardownStack);

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
  const { userId: rootId } = await bootstrapActiveRoot(
    runner,
    release,
    pools.identity,
    'root@example.test',
    { issuer },
  );
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
