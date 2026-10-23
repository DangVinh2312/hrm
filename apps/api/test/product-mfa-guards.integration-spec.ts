// ADR 0026: migration 016 grants/guards/probes and the factor state machine.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { verifyProductPrivileges } from '../dist/database/services/product-privilege-verify.service.js';
import {
  guardRootLifecycleMfaBody,
  mfaEpochBody,
  protectMfaRecoveryCodeBody,
  protectMfaTotpBody,
} from '../dist/database/migrations/016-mfa-totp.migration.js';
import { sqlState } from './setup-postgres.ts';
import {
  pools,
  superuser,
  epoch,
  account,
  setupStack,
  teardownStack,
} from './product-mfa-stack.helper.ts';

before(setupStack);
after(teardownStack);

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
