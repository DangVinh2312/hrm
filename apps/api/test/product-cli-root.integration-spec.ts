import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProductAuthenticationError,
  ProductIdentityService,
} from '../dist/auth/services/product-identity.service.js';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { CLI_ISSUER, startCliFixture } from './cli-fixture.helper.ts';
import { activateRootAccount, oidcSession } from './oidc-fixture.helper.ts';

const PROOF = /^[A-Za-z0-9_-]{43}$/;

test('root:bootstrap from an email, its retry, reissue, activation, revocation and the permanent marker', async (t) => {
  const cli = await startCliFixture(t, 'cli-root');
  const proofPath = join(cli.dir, 'activation-proof');
  const operation = randomUUID();

  const bootstrap = (file: string, op = operation, email = 'Root@Example.test') =>
    cli.spawn(
      'bootstrap',
      '--operation',
      op,
      '--issuer',
      CLI_ISSUER,
      '--email',
      email,
      '--activation-file',
      file,
    );

  const first = bootstrap(proofPath);
  assert.equal(first.status, 0, first.stderr);
  const proof = (await readFile(proofPath, 'utf8')).trim();
  assert.match(proof, PROOF);
  assert.equal((await stat(proofPath)).mode & 0o777, 0o600);
  // The id is printed (not a secret) for revoke/reset-mfa; the proof and the address never are.
  const userId = /id ([0-9a-f-]{36})/.exec(first.stdout)?.[1];
  assert.ok(userId);
  assert.doesNotMatch(first.stdout + first.stderr, new RegExp(`${proof}|root@example`, 'i'));
  assert.deepEqual(
    await cli.query('SELECT kind,state,email_canonical,email_verified FROM app_user'),
    [
      {
        kind: 'root',
        state: 'pending',
        email_canonical: 'root@example.test',
        email_verified: false,
      },
    ],
  );

  // Same operation and email: nothing changes and no artifact is written; anything else collides.
  const retry = bootstrap(join(cli.dir, 'retry'));
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /already committed/);
  for (const [name, op, email] of [
    ['other-op', randomUUID(), 'Root@Example.test'],
    ['other-email', operation, 'someone@example.test'],
  ] as const) {
    const again = bootstrap(join(cli.dir, name), op, email);
    assert.notEqual(again.status, 0, name);
    assert.match(again.stderr, /\(ReleaseRejectedError collision\)/, name);
  }
  for (const name of ['retry', 'other-op', 'other-email'])
    await assert.rejects(readFile(join(cli.dir, name), 'utf8'), name);
  assert.equal((await cli.query('SELECT 1 FROM app_user')).length, 1);

  // A lost proof of the still pending Root is reissued by the bootstrap credential only.
  const reissuePath = join(cli.dir, 'root-reissue-proof');
  assert.match(
    cli.run('reissue-root', '--issuer', CLI_ISSUER, '--activation-file', reissuePath),
    /reissued/,
  );
  assert.notEqual((await readFile(reissuePath, 'utf8')).trim(), proof);
  assert.deepEqual(
    await cli.query(
      `SELECT (SELECT count(*)::int FROM one_time_token WHERE user_id=$1 AND consumed_at IS NULL) live,
         (SELECT count(*)::int FROM oidc_email_enrollment WHERE user_id=$1) pinned`,
      [userId],
    ),
    [{ live: 1, pinned: 1 }],
  );
  const unknown = cli.spawn(
    'reissue-root',
    '--issuer',
    'https://unknown.example.test',
    '--activation-file',
    join(cli.dir, 'unknown-issuer'),
  );
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /\(ReleaseRejectedError missing_reference\)/);
  await assert.rejects(readFile(join(cli.dir, 'unknown-issuer'), 'utf8'));

  const identitySource = await cli.login('identity');
  t.after(() => identitySource.destroy());
  const runner = new ProductTransactionRunner({ identity: identitySource });
  const identity = new ProductIdentityService(runner);
  await activateRootAccount(identitySource, userId, 'root-cli-subject', CLI_ISSUER);
  const session = await oidcSession(identitySource, userId);
  // Activated: nothing left to reissue.
  const late = cli.spawn(
    'reissue-root',
    '--issuer',
    CLI_ISSUER,
    '--activation-file',
    join(cli.dir, 'late'),
  );
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /\(ReleaseRejectedError collision\)/);
  await assert.rejects(readFile(join(cli.dir, 'late'), 'utf8'));
  assert.ok(await runner.run('identity', (tx) => identity.authenticate(tx, session)));

  // Malformed set-root-email input fails without writing or printing the address.
  for (const [args, detail] of [
    [['--user', userId, '--operation', randomUUID()], undefined],
    [['--user', userId, '--operation', randomUUID(), '--email', 'not-an-email'], 'invalid_release'],
    [['--user', userId, '--email', 'new-root@example.test'], undefined],
  ] as const) {
    const result = cli.spawn('set-root-email', ...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(
      result.stderr,
      detail ? new RegExp(`\\(ReleaseRejectedError ${detail}\\)`) : /\(Error\)/,
    );
    assert.doesNotMatch(result.stderr + result.stdout, /new-root@example\.test|not-an-email/);
  }

  const revoke = (...extra: string[]) =>
    cli.run('revoke-root', '--user', userId, '--operation', randomUUID(), ...extra);

  assert.notEqual(
    cli.spawn('revoke-root', '--user', userId, '--operation', randomUUID()).status,
    0,
    'approval and reason are mandatory',
  );
  assert.match(revoke('--approval', 'CHG-1', '--reason', 'Fixture handover'), /Root suspended/);
  assert.match(revoke('--approval', 'CHG-1', '--reason', 'Fixture retry'), /nothing changed/);
  assert.deepEqual(
    await cli.query(
      `SELECT (SELECT kind FROM app_user WHERE id=$1) kind,(SELECT state FROM app_user WHERE id=$1) state,
         (SELECT initialized_at IS NOT NULL FROM security_bootstrap_state) marker,
         (SELECT count(*)::int FROM audit_outbox WHERE event_kind=$2 AND reason='Fixture handover') audit`,
      [userId, Buffer.from('root.revoke')],
    ),
    [{ kind: 'root', state: 'suspended', marker: true, audit: 1 }],
  );
  // The session held before the revocation is dead, and so is any new one.
  await assert.rejects(
    runner.run('identity', (tx) => identity.authenticate(tx, session)),
    ProductAuthenticationError,
  );
  await assert.rejects(
    runner.run('identity', async (tx) =>
      identity.authenticate(tx, await oidcSession(identitySource, userId)),
    ),
    ProductAuthenticationError,
  );

  // The marker is permanent: no bootstrap after a revocation.
  const next = bootstrap(join(cli.dir, 'again-proof'), randomUUID(), 'next-root@example.test');
  assert.notEqual(next.status, 0);
  assert.match(next.stderr, /\(ReleaseRejectedError collision\)/);
  await assert.rejects(readFile(join(cli.dir, 'again-proof'), 'utf8'));
  // root.* audit: the offline actor acts, the Root account is the target; no address anywhere.
  const events = await cli.query<{ kind: string; actor: string; target: string; metadata: string }>(
    `SELECT convert_from(event_kind,'UTF8') kind,actor_id::text actor,safe_metadata->>'targetUserId' target,safe_metadata::text metadata
     FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'root.%' ORDER BY occurred_at,event_id`,
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.actor, e.target]),
    [
      ['root.bootstrap', PRODUCT_OFFLINE_ACTOR, userId],
      ['root.reissue', PRODUCT_OFFLINE_ACTOR, userId],
      ['root.revoke', PRODUCT_OFFLINE_ACTOR, userId],
    ],
  );
  for (const e of events) assert.ok(!e.metadata.includes('@'), e.kind);
});
