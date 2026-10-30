// ADR-15 D9: change_iam_account_email, reset_iam_mfa and reset_iam_google_binding, the
// SECURITY DEFINER functions of the identity operations; every case runs on real PostgreSQL with
// the real logins. The HTTP service that calls them comes later.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sessionDigest } from '../dist/authentication/services/product-identity.service.js';
import { sqlState } from './setup-postgres.ts';
import {
  FIXTURE_ISSUER,
  bindAccount,
  fixtureProvider,
  oidcSession,
} from './oidc-fixture.helper.ts';
import { migration, pools, root, setupStack, teardownStack } from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

const actor = randomUUID();
const otherIssuer = 'https://idp.other.fixture';

const changeEmail = (pool: keyof typeof pools, ...args: unknown[]) =>
  pools[pool].query('SELECT public.change_iam_account_email($1,$2,$3,$4)', args);

const resetMfa = (pool: keyof typeof pools, ...args: unknown[]) =>
  pools[pool].query('SELECT public.reset_iam_mfa($1)', args);

const resetBinding = (pool: keyof typeof pools, ...args: unknown[]) =>
  pools[pool].query('SELECT public.reset_iam_google_binding($1,$2,$3)', args);

interface Seed {
  state?: 'pending' | 'active' | 'suspended';
  email?: string | null;
  bound?: boolean;
  enrollment?: 'live' | 'expired';
}

async function seed(options: Seed = {}) {
  const id = randomUUID();
  const email = options.email === undefined ? `${id}@example.test` : options.email;
  await migration.query(
    'INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,$2,$3,$4)',
    [id, email, options.state ?? 'active', (options.state ?? 'active') === 'active'],
  );
  if (options.bound ?? (options.state ?? 'active') !== 'pending')
    await bindAccount(pools.identity, id);
  if (options.enrollment)
    await migration.query(
      `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_at,created_by)
       VALUES($1,$2,$3,statement_timestamp()+$4::interval,statement_timestamp()-interval '2 days',$5)`,
      [id, FIXTURE_ISSUER, email, options.enrollment === 'live' ? '1 day' : '-1 day', randomUUID()],
    );
  return { id, email: email as string };
}

const user = async (id: string) =>
  (
    await migration.query<
      { email: string | null; verified: boolean; state: string; epoch: string }[]
    >(
      'SELECT email_canonical email,email_verified verified,state,auth_epoch::text epoch FROM app_user WHERE id=$1',
      [id],
    )
  )[0]!;

const epoch = async (id: string) => Number((await user(id)).epoch);

const enrollment = (id: string) =>
  migration.query<
    { issuer: string; email: string; days: number; createdBy: string; createdAt: Date }[]
  >(
    `SELECT issuer,email_canonical email,
       round(extract(epoch FROM expires_at-statement_timestamp())/86400)::int days,
       created_by::text "createdBy",created_at "createdAt"
     FROM oidc_email_enrollment WHERE user_id=$1`,
    [id],
  );

const bindingRows = (id: string) =>
  migration.query<{ subject: string; enabled: boolean; version: string }[]>(
    'SELECT subject,enabled,binding_version::text version FROM external_identity WHERE user_id=$1 ORDER BY subject',
    [id],
  );

const sessionRows = (secret: string) =>
  pools.authority.query<{ user_id: string }[]>('SELECT user_id FROM public.resolve_session($1)', [
    sessionDigest(secret),
  ]);

async function factor(id: string, confirmed: boolean, recoveryCodes = 2) {
  await migration.query(
    `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('cd',12),'hex'),'k1')`,
    [id],
  );
  if (confirmed)
    await migration.query(
      'UPDATE mfa_totp SET confirmed_at=statement_timestamp() WHERE user_id=$1',
      [id],
    );
  for (let i = 0; i < recoveryCodes; i += 1)
    await migration.query('INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,$2)', [
      id,
      Buffer.alloc(32, i + 1),
    ]);
}

const factorRows = async (id: string) =>
  (
    await migration.query<{ totp: string; codes: string }[]>(
      `SELECT (SELECT count(*) FROM mfa_totp WHERE user_id=$1)::text totp,
              (SELECT count(*) FROM mfa_recovery_code WHERE user_id=$1)::text codes`,
      [id],
    )
  )[0]!;

const nonAuthority = ['data', 'identity', 'sync', 'bootstrap'] as const;

test('only authority may execute the three functions; every other login gets 42501 for a valid target', async () => {
  const target = await seed();
  await factor(target.id, true);
  const before = await user(target.id);
  for (const pool of nonAuthority) {
    assert.equal(
      await sqlState(changeEmail(pool, target.id, 'new@example.test', FIXTURE_ISSUER, actor)),
      '42501',
      pool,
    );
    assert.equal(await sqlState(resetMfa(pool, target.id)), '42501', pool);
    assert.equal(
      await sqlState(resetBinding(pool, target.id, FIXTURE_ISSUER, actor)),
      '42501',
      pool,
    );
  }
  assert.deepEqual(await user(target.id), before);
  assert.deepEqual(await factorRows(target.id), { totp: '1', codes: '2' });
});

test('an absent or null user is P0002 and Root is 42501, active or suspended, for all three functions', async () => {
  for (const id of [randomUUID(), null]) {
    assert.equal(
      await sqlState(changeEmail('authority', id, 'new@example.test', FIXTURE_ISSUER, actor)),
      'P0002',
    );
    assert.equal(await sqlState(resetMfa('authority', id)), 'P0002');
    assert.equal(await sqlState(resetBinding('authority', id, FIXTURE_ISSUER, actor)), 'P0002');
  }
  await factor(root.id, false);

  // The function's own kind check answers; guard_root_lifecycle behind it would be a second 42501.
  const refused = async (operation: Promise<unknown>) => {
    try {
      await operation;
    } catch (error) {
      const { code, message } = error as { code?: unknown; message?: unknown };
      assert.equal(code, '42501');
      assert.match(String(message), /^only IAM accounts/);
      return;
    }
    assert.fail('Root was accepted');
  };

  const attempt = async () => {
    const before = await user(root.id);
    await refused(
      changeEmail('authority', root.id, 'taken-over@example.test', FIXTURE_ISSUER, actor),
    );
    await refused(resetMfa('authority', root.id));
    await refused(resetBinding('authority', root.id, FIXTURE_ISSUER, actor));
    assert.deepEqual(await user(root.id), before);
    assert.deepEqual(await factorRows(root.id), { totp: '1', codes: '2' });
    assert.equal((await bindingRows(root.id))[0]?.enabled, true);
  };

  await attempt();
  await pools.bootstrap.query(
    `UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`,
    [root.id],
  );
  await attempt();
});

test('change email: one UPDATE sets email, unverified and a new epoch; the old session dies; no enrollment appears', async () => {
  const target = await seed();
  const secret = await oidcSession(pools.identity, target.id);
  assert.deepEqual(await sessionRows(secret), [{ user_id: target.id }]);
  const before = await epoch(target.id);
  await changeEmail('authority', target.id, 'changed@example.test', FIXTURE_ISSUER, actor);
  assert.deepEqual(await user(target.id), {
    email: 'changed@example.test',
    verified: false,
    state: 'active',
    epoch: String(before + 1),
  });
  assert.deepEqual(await sessionRows(secret), []);
  assert.deepEqual(await enrollment(target.id), []);
  // The binding stays: nobody can log in as the new email while it is enabled.
  assert.deepEqual(
    (await bindingRows(target.id)).map((b) => b.enabled),
    [true],
  );
});

test('change email: duplicates are 23505, the same email is 55000, bad input is 22023; nothing changes', async () => {
  const one = await seed();
  const two = await seed();
  const rootEmail = (await user(root.id)).email as string;
  const before = await user(one.id);
  for (const email of [two.email, rootEmail])
    assert.equal(
      await sqlState(changeEmail('authority', one.id, email, FIXTURE_ISSUER, actor)),
      '23505',
    );
  assert.equal(
    await sqlState(changeEmail('authority', one.id, one.email, FIXTURE_ISSUER, actor)),
    '55000',
  );
  const bad: [unknown, unknown, unknown][] = [
    [two.email.toUpperCase(), FIXTURE_ISSUER, actor],
    ['x'.repeat(250) + '@e.co', FIXTURE_ISSUER, actor],
    ['no-at-sign', FIXTURE_ISSUER, actor],
    ['a b@example.test', FIXTURE_ISSUER, actor],
    [null, FIXTURE_ISSUER, actor],
    ['ok@example.test', null, actor],
    ['ok@example.test', 'https://not-a-provider', actor],
    ['ok@example.test', FIXTURE_ISSUER, null],
  ];
  for (const args of bad)
    assert.equal(await sqlState(changeEmail('authority', one.id, ...args)), '22023', String(args));
  await fixtureProvider(migration, otherIssuer);
  await migration.query('UPDATE oidc_provider SET enabled=false WHERE issuer=$1', [otherIssuer]);
  assert.equal(
    await sqlState(changeEmail('authority', one.id, 'ok@example.test', otherIssuer, actor)),
    '22023',
  );
  assert.deepEqual(await user(one.id), before);
});

test('change email of a pending account replaces its enrollment, live or expired, or creates one', async () => {
  const live = await seed({ state: 'pending', enrollment: 'live' });
  const expired = await seed({ state: 'pending', enrollment: 'expired' });
  const none = await seed({ state: 'pending' });
  for (const target of [live, expired, none]) {
    const before = await epoch(target.id);
    const email = `moved-${target.id}@example.test`;
    await changeEmail('authority', target.id, email, FIXTURE_ISSUER, actor);
    const rows = await enrollment(target.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.email, email);
    assert.equal(rows[0]?.issuer, FIXTURE_ISSUER);
    assert.equal(rows[0]?.createdBy, actor);
    assert.equal(rows[0]?.days, 7);
    assert.deepEqual(await user(target.id), {
      email,
      verified: false,
      state: 'pending',
      epoch: String(before + 1),
    });
  }
});

test('change email of an active or suspended account deletes its old invitation and frees the old email', async () => {
  for (const state of ['active', 'suspended'] as const) {
    const target = await seed({ state, enrollment: 'live' });
    assert.equal((await enrollment(target.id)).length, 1);
    await changeEmail('authority', target.id, `m-${target.id}@example.test`, FIXTURE_ISSUER, actor);
    assert.deepEqual(await enrollment(target.id), []);
    assert.equal((await user(target.id)).state, state);
    // The old (issuer, email) pair is free again: provisioning and another change both succeed.
    const provisioned = randomUUID();
    await pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
      provisioned,
      target.email,
      FIXTURE_ISSUER,
      actor,
    ]);
    assert.equal((await enrollment(provisioned)).length, 1);
    const other = await seed({ state: 'pending', enrollment: 'live' });
    await changeEmail('authority', other.id, `n-${other.id}@example.test`, FIXTURE_ISSUER, actor);
    const another = await seed({ state: 'pending' });
    await changeEmail('authority', another.id, other.email, FIXTURE_ISSUER, actor);
    assert.equal((await user(another.id)).email, other.email);
  }
});

test('reset binding: active becomes pending, the binding is disabled not deleted, a new invitation, epoch and session ended', async () => {
  const target = await seed();
  const secret = await oidcSession(pools.identity, target.id);
  const before = await epoch(target.id);
  await resetBinding('authority', target.id, FIXTURE_ISSUER, actor);
  assert.deepEqual(await bindingRows(target.id), [
    { subject: `sub-${target.id}`, enabled: false, version: '2' },
  ]);
  assert.deepEqual(await user(target.id), {
    email: target.email,
    verified: true,
    state: 'pending',
    epoch: String(before + 1),
  });
  const [invite] = await enrollment(target.id);
  assert.equal(invite?.email, target.email);
  assert.equal(invite?.createdBy, actor);
  assert.equal(invite?.days, 7);
  assert.deepEqual(await sessionRows(secret), []);
  // A second reset has no enabled binding to disable and still refreshes the invitation.
  await resetBinding('authority', target.id, FIXTURE_ISSUER, actor);
  assert.deepEqual(
    (await bindingRows(target.id)).map((b) => [b.enabled, b.version]),
    [[false, '2']],
  );
  assert.equal(await epoch(target.id), before + 2);
});

test('reset binding keeps a suspended account suspended and refreshes an expired invitation of an unbound one', async () => {
  const suspended = await seed({ state: 'suspended' });
  const before = await epoch(suspended.id);
  await resetBinding('authority', suspended.id, FIXTURE_ISSUER, actor);
  assert.equal((await user(suspended.id)).state, 'suspended');
  assert.equal(await epoch(suspended.id), before + 1);
  assert.equal((await bindingRows(suspended.id))[0]?.enabled, false);
  assert.equal((await enrollment(suspended.id)).length, 1);

  const unbound = await seed({ state: 'pending', enrollment: 'expired' });
  await resetBinding('authority', unbound.id, FIXTURE_ISSUER, actor);
  assert.equal((await user(unbound.id)).state, 'pending');
  assert.equal((await enrollment(unbound.id))[0]?.days, 7);
});

test('reset binding: no email is 55000, an unknown or disabled issuer is 22023, a clashing invitation rolls everything back', async () => {
  const noEmail = await seed({ email: null });
  assert.equal(
    await sqlState(resetBinding('authority', noEmail.id, FIXTURE_ISSUER, actor)),
    '55000',
  );
  const target = await seed();
  const before = await user(target.id);
  assert.equal(
    await sqlState(resetBinding('authority', target.id, 'https://not-a-provider', actor)),
    '22023',
  );
  await fixtureProvider(migration, otherIssuer);
  await migration.query('UPDATE oidc_provider SET enabled=false WHERE issuer=$1', [otherIssuer]);
  assert.equal(await sqlState(resetBinding('authority', target.id, otherIssuer, actor)), '22023');
  assert.equal(await sqlState(resetBinding('authority', target.id, null, actor)), '22023');
  assert.equal(await sqlState(resetBinding('authority', target.id, FIXTURE_ISSUER, null)), '22023');
  // Another account holds the invitation for (issuer, email): the INSERT fails after the binding UPDATE.
  const holder = await seed({ state: 'pending', email: `holder-${randomUUID()}@example.test` });
  await migration.query(
    `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by)
     VALUES($1,$2,$3,statement_timestamp()+interval '1 day',$4)`,
    [holder.id, FIXTURE_ISSUER, target.email, actor],
  );
  assert.equal(
    await sqlState(resetBinding('authority', target.id, FIXTURE_ISSUER, actor)),
    '23505',
  );
  assert.deepEqual(await user(target.id), before);
  assert.equal((await bindingRows(target.id))[0]?.enabled, true);
  assert.deepEqual(await enrollment(target.id), []);
});

test('reset MFA: nothing to reset is 55000; recovery codes alone count; the epoch always advances', async () => {
  const none = await seed();
  const before = await epoch(none.id);
  assert.equal(await sqlState(resetMfa('authority', none.id)), '55000');
  assert.equal(await epoch(none.id), before);

  const codesOnly = await seed();
  await migration.query('INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,$2)', [
    codesOnly.id,
    Buffer.alloc(32, 9),
  ]);
  const codesBefore = await epoch(codesOnly.id);
  await resetMfa('authority', codesOnly.id);
  assert.deepEqual(await factorRows(codesOnly.id), { totp: '0', codes: '0' });
  assert.equal(await epoch(codesOnly.id), codesBefore + 1);
});

test('reset MFA: an unconfirmed factor does not move the epoch by trigger, so the function does it once', async () => {
  const target = await seed();
  await factor(target.id, false);
  const before = await epoch(target.id);
  await resetMfa('authority', target.id);
  assert.deepEqual(await factorRows(target.id), { totp: '0', codes: '0' });
  assert.equal(await epoch(target.id), before + 1);
});

test('reset MFA: a confirmed factor and its recovery codes go, the epoch advances, the old session dies', async () => {
  const target = await seed();
  await factor(target.id, true, 3);
  const secret = await oidcSession(pools.identity, target.id);
  const before = await epoch(target.id);
  assert.deepEqual(await sessionRows(secret), [{ user_id: target.id }]);
  await resetMfa('authority', target.id);
  assert.deepEqual(await factorRows(target.id), { totp: '0', codes: '0' });
  // mfa_epoch fires once for the confirmed factor and the function advances the epoch once more.
  assert.equal(await epoch(target.id), before + 2);
  assert.deepEqual(await sessionRows(secret), []);
  assert.equal((await user(target.id)).state, 'active');
  assert.equal((await bindingRows(target.id))[0]?.enabled, true);
});

test('authority keeps no direct write: state, email, bindings and factors are still 42501 around the definers', async () => {
  const target = await seed();
  await factor(target.id, true);
  for (const sql of [
    `UPDATE app_user SET state='pending' WHERE id=$1`,
    `UPDATE app_user SET email_canonical='x@example.test',email_verified=false,auth_epoch=auth_epoch+1 WHERE id=$1`,
    `UPDATE external_identity SET enabled=false WHERE user_id=$1`,
    `DELETE FROM mfa_totp WHERE user_id=$1`,
    `DELETE FROM mfa_recovery_code WHERE user_id=$1`,
    `DELETE FROM oidc_email_enrollment WHERE user_id=$1`,
  ])
    assert.equal(await sqlState(pools.authority.query(sql, [target.id])), '42501', sql);
});
