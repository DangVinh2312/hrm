import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';
import { CLI_ISSUER, startCliFixture } from './cli-fixture.helper.ts';
import { activateRootAccount } from './oidc-fixture.helper.ts';

// ADR 0026 §10: offline second factor reset. identity resets IAM only, bootstrap Root only.
test('reset-mfa resets IAM accounts only and reset-root-mfa the Root only, with approval and audit', async (t) => {
  const cli = await startCliFixture(t, 'cli-mfa');
  const boot = cli.run(
    'bootstrap',
    '--operation',
    randomUUID(),
    '--issuer',
    CLI_ISSUER,
    '--email',
    'root@example.test',
    '--activation-file',
    join(cli.dir, 'proof'),
  );
  const root = /id ([0-9a-f-]{36})/.exec(boot)?.[1];
  assert.ok(root);
  const iam = randomUUID();
  cli.run('enroll', '--user', iam, '--issuer', CLI_ISSUER, '--email', 'iam@example.test');
  const identitySource = await cli.login('identity');
  t.after(() => identitySource.destroy());
  await activateRootAccount(identitySource, root, 'root-subject', CLI_ISSUER);

  const factor = async (user: string) => {
    await identitySource.query(
      `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,$2,$3,'k1')`,
      [user, randomBytes(36), randomBytes(12)],
    );
    await identitySource.query(
      'UPDATE mfa_totp SET confirmed_at=statement_timestamp() WHERE user_id=$1',
      [user],
    );
  };

  const factors = async (user: string) =>
    (await cli.query('SELECT 1 FROM mfa_totp WHERE user_id=$1', [user])).length;

  const reset = (command: string, user: string, ...extra: string[]) =>
    cli.spawn(command, '--user', user, '--operation', randomUUID(), ...extra);

  const approved = ['--approval', 'CHG-2', '--reason', 'Lost device and codes'];

  await factor(root);
  await factor(iam);
  for (const [command, user, extra] of [
    ['reset-mfa', root, approved],
    ['reset-root-mfa', iam, approved],
    ['reset-mfa', iam, []],
    ['reset-root-mfa', root, ['--approval', 'CHG-2']],
  ] as const) {
    const result = reset(command, user, ...extra);
    assert.notEqual(result.status, 0, `${command} ${user}`);
    assert.match(result.stderr, /Product operation failed/);
  }
  assert.equal(await factors(root), 1);
  assert.equal(await factors(iam), 1);

  const epochs = async () =>
    (
      await cli.query<{ e: string }>(
        'SELECT auth_epoch::text e FROM app_user WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[root, iam].sort()],
      )
    ).map((r) => BigInt(r.e));

  const beforeReset = await epochs();

  const succeeded = (result: ReturnType<typeof reset>, output: RegExp) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, output);
  };

  succeeded(reset('reset-root-mfa', root, ...approved), /Second factor and recovery codes removed/);
  succeeded(reset('reset-mfa', iam, ...approved), /Second factor and recovery codes removed/);
  // The trigger ended the sessions of both accounts (one epoch step each).
  assert.deepEqual(
    await epochs(),
    beforeReset.map((e) => e + 1n),
  );
  // Nothing left to reset: exit 0, nothing changed, no audit.
  succeeded(reset('reset-mfa', iam, ...approved), /No second factor; nothing changed/);
  succeeded(reset('reset-root-mfa', root, ...approved), /No second factor; nothing changed/);
  assert.equal(await factors(root), 0);
  assert.equal(await factors(iam), 0);
  const rows = await cli.query<{
    target: string;
    approval: string;
    reason: string;
    metadata: string;
  }>(
    `SELECT safe_metadata->>'targetUserId' target,safe_metadata->>'approval' approval,reason,safe_metadata::text metadata
     FROM audit_outbox WHERE event_kind=$1 AND actor_id=$2 ORDER BY occurred_at,event_id`,
    [Buffer.from('identity.mfa-reset'), PRODUCT_OFFLINE_ACTOR],
  );
  assert.deepEqual(
    rows.map((r) => [r.target, r.approval, r.reason]),
    [
      [root, 'CHG-2', 'Lost device and codes'],
      [iam, 'CHG-2', 'Lost device and codes'],
    ],
  );
  // No email (PII) in the reset audit (ADR 0026 §10, like root.revoke).
  for (const row of rows) assert.ok(!row.metadata.includes('@'), row.metadata);
});
