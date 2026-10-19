import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import {
  ProductAuthenticationError,
  ProductIdentityService,
} from '../dist/auth/services/product-identity.service.js';
import { PRODUCT_OFFLINE_ACTOR } from '../dist/audit/product-audit.repository.js';

import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { productDataSourceOptions } from '../dist/database/helpers/product-database.helper.js';
import { startPostgres, withClient } from './setup-postgres.ts';
import { activateAccount, oidcSession } from './oidc-fixture.helper.ts';

const cliPath = fileURLToPath(new URL('../tools/product.ts', import.meta.url));

test('offline CLI provisions, forward migrates, syncs and bootstraps once without printing activation secret', async (t) => {
  const pg = await startPostgres();
  const dir = await mkdtemp(join(tmpdir(), 'product-cli-'));
  t.after(async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const c = pg.superuser;
  const purposes = [
    'data',
    'identity',
    'authority',
    'sync',
    'migration',
    'bootstrap',
    'outbox',
  ] as const;
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    DATABASE_ADMIN_URL: `postgres://${c.username}:${c.password}@${c.host}:${c.port}/postgres`,
    PRODUCT_DATABASE_NAME: 'cli_fixture',
  };
  for (const p of purposes) {
    const password = randomBytes(24).toString('hex');
    env[`PRODUCT_${p.toUpperCase()}_PASSWORD`] = password;
    env[`PRODUCT_${p.toUpperCase()}_DATABASE_URL`] =
      `postgres://product_${p}:${password}@${c.host}:${c.port}/cli_fixture`;
  }

  function run(command: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [cliPath, command, ...args], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  }

  run('provision');
  run('migrate');
  assert.match(run('migrate'), /Applied 0/);
  run('sync');
  run('sync');
  // Session purge needs an explicit retention; nothing has expired yet.
  assert.match(run('purge-sessions', '--retention-days', '30'), /Purged 0 expired sessions/);
  const noRetention = spawnSync(process.execPath, [cliPath, 'purge-sessions'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.notEqual(noRetention.status, 0);
  assert.match(noRetention.stderr, /Product operation failed \(Error\)/);
  // The CLI publishes exactly the release the API runtime prepares (one codec composition).
  const { createProductAuthorizationCore, createProductRelease } =
    await import('../dist/authorization/product.manifest.js');
  await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
    const state = await client.query<{ hash: string }>(
      "SELECT encode(manifest_hash,'hex') hash FROM authz_state WHERE singleton",
    );
    assert.equal(state.rows[0]?.hash, createProductRelease(createProductAuthorizationCore()).hash);
  });
  // ADR 0027 §2: `--method local` is gone; the command refuses before any write or artifact.
  for (const command of ['enroll', 'invite', 'bootstrap', 'reissue-root']) {
    const local = spawnSync(
      process.execPath,
      [
        cliPath,
        command,
        '--user',
        randomUUID(),
        '--operation',
        randomUUID(),
        '--method',
        'local',
        '--email',
        'local@example.test',
        '--activation-file',
        join(dir, `local-${command}`),
      ],
      { env, encoding: 'utf8', timeout: 30000 },
    );
    assert.notEqual(local.status, 0, command);
    assert.match(local.stderr, /Product operation failed \(Error\)/, command);
    await assert.rejects(readFile(join(dir, `local-${command}`), 'utf8'));
  }
  // The fixture provider the sessions below are bound to.
  await withClient({ ...c, database: 'cli_fixture' }, (client) =>
    client.query(
      "INSERT INTO oidc_provider(issuer,version,enabled) VALUES('https://idp.example.test',1,true)",
    ),
  );
  const invited = randomUUID();
  const inviteArtifact = join(dir, 'invite-proof');
  const inviteOutput = run(
    'invite',
    '--user',
    invited,
    '--method',
    'oidc',
    '--issuer',
    'https://idp.example.test',
    '--subject',
    'invited-subject',
    '--activation-file',
    inviteArtifact,
  );
  const inviteProof = (await readFile(inviteArtifact, 'utf8')).trim();
  assert.match(inviteProof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(inviteOutput.includes(inviteProof), false);
  assert.equal((await stat(inviteArtifact)).mode & 0o777, 0o600);
  const oidcInvited = randomUUID();
  const oidcArtifact = join(dir, 'oidc-invite-proof');
  run(
    'invite',
    '--user',
    oidcInvited,
    '--method',
    'oidc',
    '--issuer',
    'https://idp.example.test',
    '--subject',
    'cli-subject',
    '--activation-file',
    oidcArtifact,
  );
  assert.match((await readFile(oidcArtifact, 'utf8')).trim(), /^[A-Za-z0-9_-]{43}$/);
  await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
    const rows = await client.query<{ purpose: string }>(
      'SELECT purpose FROM one_time_token WHERE user_id=$1',
      [oidcInvited],
    );
    assert.deepEqual(rows.rows, [{ purpose: 'oidc-activation' }]);
  });
  // An expired or lost invitation is reissued for the existing pending account.
  const reissued = join(dir, 'oidc-reissue-proof');
  assert.match(
    run('invite', '--user', oidcInvited, '--method', 'oidc', '--activation-file', reissued),
    /reissued/,
  );
  assert.notEqual(
    (await readFile(reissued, 'utf8')).trim(),
    (await readFile(oidcArtifact, 'utf8')).trim(),
  );
  await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
    // The reissue supersedes the earlier (possibly lost) invitation.
    const live = await client.query<{ n: number }>(
      'SELECT count(*)::int n FROM one_time_token WHERE user_id=$1 AND consumed_at IS NULL',
      [oidcInvited],
    );
    assert.equal(live.rows[0]?.n, 1);
  });
  const unknown = spawnSync(
    process.execPath,
    [
      cliPath,
      'invite',
      '--user',
      randomUUID(),
      '--method',
      'oidc',
      '--activation-file',
      join(dir, 'unknown-proof'),
    ],
    { env, encoding: 'utf8', timeout: 30000 },
  );
  assert.notEqual(unknown.status, 0, 'reissue needs an existing pending account');
  await assert.rejects(readFile(join(dir, 'unknown-proof'), 'utf8'));
  const userId = randomUUID();

  const cliRevision = () =>
    withClient(
      { ...c, database: 'cli_fixture' },
      async (client) =>
        (await client.query<{ r: string }>('SELECT revision::text r FROM authz_state')).rows[0]!.r,
    );

  const beforeEnroll = await cliRevision();
  // `pnpm run <script> -- <flags>` (pnpm 12) forwards the literal `--`; the CLI must accept it.
  run(
    'enroll',
    '--',
    '--user',
    userId,
    '--method',
    'oidc',
    '--issuer',
    'https://idp.example.test',
    '--subject',
    'root-cli-subject',
  );
  const afterEnroll = await cliRevision();
  assert.equal(BigInt(afterEnroll), BigInt(beforeEnroll) + 1n);
  await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
    // Offline identity events: operator sentinel as actor, the enrolled/invited account as target.
    const enrolled = await client.query<{ actor: string; revision: string; metadata: object }>(
      `SELECT actor_id::text actor,policy_revision::text revision,safe_metadata metadata FROM audit_outbox WHERE event_kind=$1 AND safe_metadata->>'targetUserId'=$2`,
      [Buffer.from('identity.enroll'), userId],
    );
    assert.deepEqual(enrolled.rows, [
      {
        actor: PRODUCT_OFFLINE_ACTOR,
        revision: beforeEnroll,
        metadata: { method: 'oidc', targetUserId: userId, resultingRevision: afterEnroll },
      },
    ]);
    const invites = await client.query<{ actor: string; target: string }>(
      `SELECT actor_id::text actor,safe_metadata->>'targetUserId' target FROM audit_outbox WHERE event_kind=$1`,
      [Buffer.from('identity.invite')],
    );
    assert.ok(invites.rows.length > 0);
    for (const row of invites.rows) {
      assert.equal(row.actor, PRODUCT_OFFLINE_ACTOR);
      assert.ok(row.target && row.target !== row.actor);
    }
  });
  const outputPath = join(dir, 'activation-proof');
  const operation = randomUUID();
  const output = run(
    'bootstrap',
    '--user',
    userId,
    '--operation',
    operation,
    '--method',
    'oidc',
    '--issuer',
    'https://idp.example.test',
    '--subject',
    'root-cli-subject',
    '--activation-file',
    outputPath,
  );
  const proof = (await readFile(outputPath, 'utf8')).trim();
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(output, new RegExp(proof));
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.match(
    run(
      'bootstrap',
      '--user',
      userId,
      '--operation',
      operation,
      '--method',
      'oidc',
      '--issuer',
      'https://idp.example.test',
      '--subject',
      'root-cli-subject',
      '--activation-file',
      join(dir, 'retry'),
    ),
    /already committed/,
  );
  await assert.rejects(readFile(join(dir, 'retry'), 'utf8'));
  await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
    assert.deepEqual(
      (await client.query('SELECT kind,state FROM app_user WHERE id=$1', [userId])).rows,
      [{ kind: 'root', state: 'pending' }],
    );
  });
  // A lost proof of the still pending Root is reissued by the bootstrap credential only.
  const reissuePath = join(dir, 'root-reissue-proof');
  assert.match(
    run(
      'reissue-root',
      '--user',
      userId,
      '--method',
      'oidc',
      '--issuer',
      'https://idp.example.test',
      '--subject',
      'root-cli-subject',
      '--activation-file',
      reissuePath,
    ),
    /reissued/,
  );
  assert.notEqual((await readFile(reissuePath, 'utf8')).trim(), proof);
  const notRoot = spawnSync(
    process.execPath,
    [
      cliPath,
      'reissue-root',
      '--user',
      invited,
      '--method',
      'oidc',
      '--issuer',
      'https://idp.example.test',
      '--subject',
      'invited-subject',
      '--activation-file',
      join(dir, 'not-root-proof'),
    ],
    { env, encoding: 'utf8', timeout: 30000 },
  );
  assert.notEqual(notRoot.status, 0);
  // Diagnosable without secrets: class and reason enum only.
  assert.match(notRoot.stderr, /\(ReleaseRejectedError collision\)/);
  await assert.rejects(readFile(join(dir, 'not-root-proof'), 'utf8'));
  // enroll → bootstrap → reissue: only the reissued proof is still live; then a Google session.
  const identitySource = await new DataSource(
    productDataSourceOptions({
      host: c.host,
      port: c.port,
      username: 'product_identity',
      password: env['PRODUCT_IDENTITY_PASSWORD'] ?? '',
      database: 'cli_fixture',
    }),
  ).initialize();
  try {
    const identityRunner = new ProductTransactionRunner({ identity: identitySource });
    const identity = new ProductIdentityService(identityRunner);
    const live = await identitySource.query<{ n: number }[]>(
      `SELECT count(*)::int n FROM one_time_token WHERE user_id=$1 AND purpose='oidc-activation' AND consumed_at IS NULL`,
      [userId],
    );
    assert.equal(live[0]?.n, 1);
    await activateAccount(identitySource, userId);
    const session = { secret: await oidcSession(identitySource, userId) };
    // Malformed set-root-email input fails without writing or printing the address.
    for (const [args, detail] of [
      [['--user', userId, '--operation', randomUUID()], undefined],
      [
        ['--user', userId, '--operation', randomUUID(), '--email', 'not-an-email'],
        'invalid_release',
      ],
      [['--user', userId, '--email', 'new-root@example.test'], undefined],
    ] as const) {
      const result = spawnSync(process.execPath, [cliPath, 'set-root-email', ...args], {
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(
        result.stderr,
        detail ? new RegExp(`\\(ReleaseRejectedError ${detail}\\)`) : /\(Error\)/,
      );
      assert.doesNotMatch(result.stderr + result.stdout, /new-root@example\.test|not-an-email/);
    }
    assert.ok(
      await identityRunner.run('identity', (tx) => identity.authenticate(tx, session.secret)),
    );

    const revoke = (...extra: string[]) =>
      run('revoke-root', '--user', userId, '--operation', randomUUID(), ...extra);

    const refused = spawnSync(
      process.execPath,
      [cliPath, 'revoke-root', '--user', userId, '--operation', randomUUID()],
      { env, encoding: 'utf8', timeout: 30000 },
    );
    assert.notEqual(refused.status, 0, 'approval and reason are mandatory');
    assert.match(revoke('--approval', 'CHG-1', '--reason', 'Fixture handover'), /Root suspended/);
    assert.match(revoke('--approval', 'CHG-1', '--reason', 'Fixture retry'), /nothing changed/);
    await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
      const rows = await client.query<{
        kind: string;
        state: string;
        marker: boolean;
        audit: number;
      }>(
        `SELECT (SELECT kind FROM app_user WHERE id=$1) kind,(SELECT state FROM app_user WHERE id=$1) state,
        (SELECT initialized_at IS NOT NULL FROM security_bootstrap_state) marker,
        (SELECT count(*)::int FROM audit_outbox WHERE event_kind=$2 AND reason='Fixture handover') audit`,
        [userId, Buffer.from('root.revoke')],
      );
      assert.deepEqual(rows.rows[0], { kind: 'root', state: 'suspended', marker: true, audit: 1 });
    });
    // The session the Root held before the revocation is dead, and so is any new one.
    await assert.rejects(
      identityRunner.run('identity', async (tx) =>
        identity.authenticate(tx, await oidcSession(identitySource, userId)),
      ),
      ProductAuthenticationError,
    );
    await assert.rejects(
      identityRunner.run('identity', (tx) => identity.authenticate(tx, session.secret)),
      ProductAuthenticationError,
    );

    // ADR 0026 §10: offline second factor reset. identity resets IAM only, bootstrap Root only.
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

    const factors = (user: string) =>
      withClient(
        { ...c, database: 'cli_fixture' },
        async (client) =>
          (await client.query('SELECT 1 FROM mfa_totp WHERE user_id=$1', [user])).rowCount,
      );

    const reset = (command: string, user: string, ...extra: string[]) =>
      spawnSync(
        process.execPath,
        [cliPath, command, '--user', user, '--operation', randomUUID(), ...extra],
        { env, encoding: 'utf8', timeout: 30000 },
      );

    const approved = ['--approval', 'CHG-2', '--reason', 'Lost device and codes'];
    await factor(userId);
    await factor(invited);
    for (const [command, user, extra] of [
      ['reset-mfa', userId, approved],
      ['reset-root-mfa', invited, approved],
      ['reset-mfa', invited, []],
      ['reset-root-mfa', userId, ['--approval', 'CHG-2']],
    ] as const) {
      const result = reset(command, user, ...extra);
      assert.notEqual(result.status, 0, `${command} ${user}`);
      assert.match(result.stderr, /Product operation failed/);
    }
    assert.equal(await factors(userId), 1);
    assert.equal(await factors(invited), 1);

    const epochs = () =>
      withClient({ ...c, database: 'cli_fixture' }, async (client) =>
        (
          await client.query<{ e: string }>(
            'SELECT auth_epoch::text e FROM app_user WHERE id = ANY($1::uuid[]) ORDER BY id',
            [[userId, invited].sort()],
          )
        ).rows.map((r) => BigInt(r.e)),
      );

    const beforeReset = await epochs();

    const succeeded = (result: ReturnType<typeof reset>, output: RegExp) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, output);
    };

    succeeded(
      reset('reset-root-mfa', userId, ...approved),
      /Second factor and recovery codes removed/,
    );
    succeeded(reset('reset-mfa', invited, ...approved), /Second factor and recovery codes removed/);
    // The trigger ended the sessions of both accounts (one epoch step each).
    assert.deepEqual(
      await epochs(),
      beforeReset.map((e) => e + 1n),
    );
    // Nothing left to reset: exit 0, nothing changed, no audit.
    succeeded(reset('reset-mfa', invited, ...approved), /No second factor; nothing changed/);
    succeeded(reset('reset-root-mfa', userId, ...approved), /No second factor; nothing changed/);
    assert.equal(await factors(userId), 0);
    assert.equal(await factors(invited), 0);
    await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
      const rows = await client.query<{
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
        rows.rows.map((r) => [r.target, r.approval, r.reason]),
        [
          [userId, 'CHG-2', 'Lost device and codes'],
          [invited, 'CHG-2', 'Lost device and codes'],
        ],
      );
      // No email (PII) in the reset audit (ADR 0026 §10, like root.revoke).
      for (const row of rows.rows) assert.ok(!row.metadata.includes('@'), row.metadata);
    });
    // The marker is permanent: no bootstrap after a revocation.
    const next = randomUUID();
    run(
      'enroll',
      '--user',
      next,
      '--method',
      'oidc',
      '--issuer',
      'https://idp.example.test',
      '--subject',
      'next-root-subject',
    );
    const again = spawnSync(
      process.execPath,
      [
        cliPath,
        'bootstrap',
        '--user',
        next,
        '--operation',
        randomUUID(),
        '--method',
        'oidc',
        '--issuer',
        'https://idp.example.test',
        '--subject',
        'next-root-subject',
        '--activation-file',
        join(dir, 'again-proof'),
      ],
      { env, encoding: 'utf8', timeout: 30000 },
    );
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /\(ReleaseRejectedError collision\)/);
    await assert.rejects(readFile(join(dir, 'again-proof'), 'utf8'));
    // root.* audit: the offline actor acts, the Root account is the target.
    await withClient({ ...c, database: 'cli_fixture' }, async (client) => {
      const rows = await client.query<{ kind: string; actor: string; target: string }>(
        `SELECT convert_from(event_kind,'UTF8') kind,actor_id::text actor,safe_metadata->>'targetUserId' target
       FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'root.%' ORDER BY occurred_at,event_id`,
      );
      assert.deepEqual(
        rows.rows.map((r) => [r.kind, r.actor, r.target]),
        [
          ['root.bootstrap', PRODUCT_OFFLINE_ACTOR, userId],
          ['root.reissue', PRODUCT_OFFLINE_ACTOR, userId],
          ['root.revoke', PRODUCT_OFFLINE_ACTOR, userId],
        ],
      );
    });
  } finally {
    await identitySource.destroy();
  }
});

test('offline CLI refuses the offline actor id as a user for enroll, invite, bootstrap and reissue-root', async (t) => {
  const pg = await startPostgres();
  const dir = await mkdtemp(join(tmpdir(), 'product-cli-actor-'));
  t.after(async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const c = pg.superuser;
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    DATABASE_ADMIN_URL: `postgres://${c.username}:${c.password}@${c.host}:${c.port}/postgres`,
    PRODUCT_DATABASE_NAME: 'cli_actor_fixture',
  };
  for (const p of ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox']) {
    const password = randomBytes(24).toString('hex');
    env[`PRODUCT_${p.toUpperCase()}_PASSWORD`] = password;
    env[`PRODUCT_${p.toUpperCase()}_DATABASE_URL`] =
      `postgres://product_${p}:${password}@${c.host}:${c.port}/cli_actor_fixture`;
  }

  const cli = (command: string, ...args: string[]) =>
    spawnSync(process.execPath, [cliPath, command, ...args], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });

  for (const setup of ['provision', 'migrate', 'sync']) assert.equal(cli(setup).status, 0, setup);
  const user = ['--user', PRODUCT_OFFLINE_ACTOR];

  const artifact = (name: string) => ['--activation-file', join(dir, name)];

  const google = ['--method', 'oidc', '--issuer', 'https://idp.example.test', '--subject', 's'];
  const attempts: [string, string[], RegExp][] = [
    ['enroll', [...user, ...google], /\(Error\)/],
    ['invite', [...user, ...google, ...artifact('invite-proof')], /\(Error\)/],
    [
      'bootstrap',
      [...user, '--operation', randomUUID(), ...google, ...artifact('b-proof')],
      /ReleaseRejectedError invalid_release/,
    ],
    [
      'reissue-root',
      [...user, ...google, ...artifact('r-proof')],
      /ReleaseRejectedError invalid_release/,
    ],
  ];
  for (const [command, args, failure] of attempts) {
    const result = cli(command, ...args);
    assert.notEqual(result.status, 0, `${command} must refuse the offline actor id`);
    assert.match(result.stderr, failure, command);
  }
  await withClient({ ...c, database: 'cli_actor_fixture' }, async (client) => {
    const rows = await client.query('SELECT 1 FROM app_user WHERE id=$1', [PRODUCT_OFFLINE_ACTOR]);
    assert.equal(rows.rowCount, 0);
  });
});
