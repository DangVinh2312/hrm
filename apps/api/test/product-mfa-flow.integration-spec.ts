// ADR 0026: setup, confirm, verify, recovery codes, failure counter, rate limit and removal.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProductAuthenticationError,
  sessionDigest,
} from '../dist/authentication/services/product-identity.service.js';
import {
  ProductMfaConflict,
  ProductStepUpRequired,
} from '../dist/authentication/services/product-mfa.service.js';
import { base32Decode, hotp } from '../dist/authentication/helpers/totp.helper.js';
import {
  migration,
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
