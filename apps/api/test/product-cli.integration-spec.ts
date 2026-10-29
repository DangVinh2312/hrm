import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';
import { CLI_ISSUER, startCliFixture } from './cli-fixture.helper.ts';

test('offline CLI provisions, forward migrates, syncs and purges sessions', async (t) => {
  const cli = await startCliFixture(t, 'cli-setup');
  assert.match(cli.run('migrate'), /Applied 0/);
  cli.run('sync');
  // Session purge needs an explicit retention; nothing has expired yet.
  assert.match(cli.run('purge-sessions', '--retention-days', '30'), /Purged 0 expired sessions/);
  const noRetention = cli.spawn('purge-sessions');
  assert.notEqual(noRetention.status, 0);
  assert.match(noRetention.stderr, /Product operation failed \(Error\)/);
  // The CLI publishes exactly the release the API runtime prepares (one codec composition).
  const { createProductAuthorizationCore, createProductRelease } =
    await import('../dist/authorization/product.manifest.js');
  const [state] = await cli.query<{ hash: string }>(
    "SELECT encode(manifest_hash,'hex') hash FROM authz_state WHERE singleton",
  );
  assert.equal(state?.hash, createProductRelease(createProductAuthorizationCore()).hash);
});

test('offline CLI takes no subject, method or user option where Google-only sign-in removed them', async (t) => {
  const cli = await startCliFixture(t, 'cli-flags');

  const file = (name: string) => ['--activation-file', join(cli.dir, name)];

  const email = ['--email', 'someone@example.test'];
  const op = ['--operation', randomUUID()];
  const refused: [string, string, string[]][] = [
    [
      'enroll',
      'method',
      ['--user', randomUUID(), '--method', 'oidc', '--issuer', CLI_ISSUER, ...email],
    ],
    [
      'enroll',
      'subject',
      ['--user', randomUUID(), '--issuer', CLI_ISSUER, '--subject', 's', ...email],
    ],
    ['invite', 'removed', ['--user', randomUUID(), '--method', 'oidc', ...file('invite')]],
    [
      'bootstrap',
      'user',
      [...op, '--user', randomUUID(), '--issuer', CLI_ISSUER, ...email, ...file('b1')],
    ],
    [
      'bootstrap',
      'method',
      [...op, '--method', 'oidc', '--issuer', CLI_ISSUER, ...email, ...file('b2')],
    ],
    [
      'bootstrap',
      'subject',
      [...op, '--subject', 's', '--issuer', CLI_ISSUER, ...email, ...file('b3')],
    ],
    ['bootstrap', 'no email', [...op, '--issuer', CLI_ISSUER, ...file('b4')]],
    ['bootstrap', 'no issuer', [...op, ...email, ...file('b5')]],
    ['reissue-root', 'user', ['--user', randomUUID(), '--issuer', CLI_ISSUER, ...file('r1')]],
    ['reissue-root', 'subject', ['--subject', 's', '--issuer', CLI_ISSUER, ...file('r2')]],
    ['reissue-root', 'method', ['--method', 'oidc', '--issuer', CLI_ISSUER, ...file('r3')]],
  ];
  for (const [command, why, args] of refused) {
    const result = cli.spawn(command, ...args);
    assert.notEqual(result.status, 0, `${command} ${why}`);
    assert.match(result.stderr, /Product operation failed \(Error\)/, `${command} ${why}`);
  }
  for (const name of ['invite', 'b1', 'b2', 'b3', 'b4', 'b5', 'r1', 'r2', 'r3'])
    await assert.rejects(readFile(join(cli.dir, name), 'utf8'), name);
  assert.deepEqual(await cli.query('SELECT 1 FROM app_user'), []);
});

test('enroll creates a pending account that waits for the first verified Google login of its email', async (t) => {
  const cli = await startCliFixture(t, 'cli-enroll');
  const userId = randomUUID();

  const revision = async () =>
    (await cli.query<{ r: string }>('SELECT revision::text r FROM authz_state'))[0]!.r;

  const before = await revision();
  // `pnpm run <script> -- <flags>` (pnpm 12) forwards the literal `--`; the CLI must accept it.
  cli.run(
    'enroll',
    '--',
    '--user',
    userId,
    '--issuer',
    CLI_ISSUER,
    '--email',
    'Person@Example.test',
  );
  const after = await revision();
  assert.equal(BigInt(after), BigInt(before) + 1n);
  assert.deepEqual(
    await cli.query(
      `SELECT u.state,u.kind,u.email_canonical,n.issuer,n.expires_at>statement_timestamp()+interval '6 days' week,
         (SELECT count(*)::int FROM external_identity WHERE user_id=u.id) bindings,
         (SELECT count(*)::int FROM one_time_token WHERE user_id=u.id) tokens
       FROM app_user u JOIN oidc_email_enrollment n ON n.user_id=u.id WHERE u.id=$1`,
      [userId],
    ),
    [
      {
        state: 'pending',
        kind: 'iam',
        email_canonical: 'person@example.test',
        issuer: CLI_ISSUER,
        week: true,
        bindings: 0,
        tokens: 0,
      },
    ],
  );
  // Offline identity event: operator sentinel as actor, the enrolled account as target, no email.
  assert.deepEqual(
    await cli.query(
      `SELECT actor_id::text actor,policy_revision::text revision,safe_metadata metadata FROM audit_outbox WHERE event_kind=$1 AND safe_metadata->>'targetUserId'=$2`,
      [Buffer.from('identity.enroll'), userId],
    ),
    [
      {
        actor: PRODUCT_OFFLINE_ACTOR,
        revision: before,
        metadata: { method: 'oidc', targetUserId: userId, resultingRevision: after },
      },
    ],
  );
  const attempts: [string, string[]][] = [
    [
      'offline actor id',
      ['--user', PRODUCT_OFFLINE_ACTOR, '--issuer', CLI_ISSUER, '--email', 'a@example.test'],
    ],
    ['no email', ['--user', randomUUID(), '--issuer', CLI_ISSUER]],
    ['bad email', ['--user', randomUUID(), '--issuer', CLI_ISSUER, '--email', 'not-an-email']],
    [
      'duplicate email',
      ['--user', randomUUID(), '--issuer', CLI_ISSUER, '--email', 'person@example.test'],
    ],
    [
      'unknown issuer',
      ['--user', randomUUID(), '--issuer', 'https://x.example.test', '--email', 'b@example.test'],
    ],
  ];
  for (const [why, args] of attempts) {
    const result = cli.spawn('enroll', ...args);
    assert.notEqual(result.status, 0, why);
    assert.match(result.stderr, /Product operation failed/, why);
    assert.doesNotMatch(result.stderr + result.stdout, /person@example|not-an-email/, why);
  }
  assert.deepEqual(
    await cli.query('SELECT 1 FROM app_user WHERE id=$1', [PRODUCT_OFFLINE_ACTOR]),
    [],
  );
  assert.equal((await cli.query('SELECT 1 FROM app_user')).length, 1);
});
