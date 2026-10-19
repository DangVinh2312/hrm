// Identity: the database rate limiter, eviction, replicas and the advisory lock.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { productDataSourceOptions } from '../dist/database/helpers/product-database.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  ProductAuthenticationError,
  ProductIdentityService,
  newSessionSecret,
} from '../dist/auth/services/product-identity.service.js';
import { TransactionConflictError } from '../dist/database/helpers/transaction-errors.helper.js';
import { withClient } from './setup-postgres.ts';
import { oidcSession } from './oidc-fixture.helper.ts';
import {
  pools,
  connections,
  identity,
  runner,
  federation,
  issuer,
  activeOidcUsers,
  setupStack,
  teardownStack,
} from './product-identity-stack.helper.ts';

before(setupStack);
after(teardownStack);

test('a limited client cannot grow the limiter or lock out other clients', async () => {
  const rows = async () =>
    (await pools.identity.query<{ n: number }[]>('SELECT count(*)::int n FROM rate_limit'))[0]!.n;

  const before = await rows();
  let rejected = 0;
  for (let i = 0; i < 100; i++)
    await identity
      .rateLimit('flooding-client', `flood${i}@example.test`, 'flood-fixture')
      .catch(() => rejected++);
  assert.equal(rejected, 80);
  // One client bucket plus the 20 identifier buckets it was allowed before being limited.
  assert.equal((await rows()) - before, 21);
  await identity.rateLimit('other-client', 'flood0@example.test', 'flood-fixture');
});

test('a full limiter evicts instead of denying every client', async () => {
  // Synthetic buckets from many sources, still inside their 15 minute window.
  await pools.identity.query(
    `INSERT INTO rate_limit(bucket_key,window_start,attempts)
     SELECT sha256(convert_to('saturation-fixture:'||g,'UTF8')),statement_timestamp()-interval '1 minute',1
     FROM generate_series(1,10000) g ON CONFLICT DO NOTHING`,
  );
  await identity.rateLimit('fresh-client', 'fresh@example.test', 'saturation-fixture');
  const [count] = await pools.identity.query<{ n: number }[]>(
    'SELECT count(*)::int n FROM rate_limit',
  );
  assert.ok(count!.n <= 10000, `limiter holds ${count!.n} rows`);
  await pools.identity.query(
    `DELETE FROM rate_limit WHERE bucket_key IN
     (SELECT sha256(convert_to('saturation-fixture:'||g,'UTF8')) FROM generate_series(1,10000) g)`,
  );
});

test('eviction drops the fewest attempts first: a flood cannot reset a used or locked bucket', async () => {
  for (let i = 0; i < 19; i++)
    await identity.rateLimit(`near-${i}`, 'near@example.test', 'lock-fixture');
  for (let i = 0; i < 20; i++)
    await identity.rateLimit(`locker-${i}`, 'locked@example.test', 'lock-fixture');
  await assert.rejects(
    identity.rateLimit('locker-next', 'locked@example.test', 'lock-fixture'),
    ProductAuthenticationError,
  );
  // Newer unlocked buckets from many sources fill the table.
  await pools.identity.query(
    `INSERT INTO rate_limit(bucket_key,window_start,attempts)
     SELECT sha256(convert_to('lock-flood:'||g,'UTF8')),statement_timestamp(),1
     FROM generate_series(1,10000) g ON CONFLICT DO NOTHING`,
  );
  await identity.rateLimit('fresh-locker', 'other@example.test', 'lock-fixture');
  // The bucket at 19 attempts survived: one more is allowed, then it locks.
  await identity.rateLimit('near-last', 'near@example.test', 'lock-fixture');
  await assert.rejects(
    identity.rateLimit('near-over', 'near@example.test', 'lock-fixture'),
    ProductAuthenticationError,
  );
  await assert.rejects(
    identity.rateLimit('another-locker', 'locked@example.test', 'lock-fixture'),
    ProductAuthenticationError,
  );
  await pools.identity.query(
    `DELETE FROM rate_limit WHERE bucket_key IN
     (SELECT sha256(convert_to('lock-flood:'||g,'UTF8')) FROM generate_series(1,10000) g)`,
  );
});

test('one IPv6 /48 shares 200 attempts across its /64 clients and all purposes', async () => {
  let accepted = 0;
  for (let i = 0; i < 220; i++)
    await identity
      .rateLimit(
        `2001:db8:48:${Math.floor(i / 19).toString(16)}::1`,
        `net${i}@example.test`,
        i % 2 ? 'net-a' : 'net-b',
      )
      .then(() => accepted++)
      .catch(() => undefined);
  assert.equal(accepted, 200);
  await identity.rateLimit('2001:db8:49::1', 'other-net@example.test', 'net-a');
});

test('database rate limiter is shared across service replicas', async () => {
  const replica = new ProductIdentityService(runner);
  for (let i = 0; i < 20; i++)
    await (i % 2 ? replica : identity).rateLimit(
      'replica-fixture',
      'limited@example.test',
      'limit-fixture',
    );
  await assert.rejects(
    replica.rateLimit('replica-fixture', 'limited@example.test', 'limit-fixture'),
    { message: 'Authentication failed' },
  );
});

test('limiter calls queued on the advisory lock do not hold the fence against a revoke', async () => {
  const [id] = await activeOidcUsers('queue', 1);
  const session = { secret: await oidcSession(pools.identity, id!) };
  await withClient(connections.identity, async (blocker) => {
    // Another session holds the limiter's advisory key, so limiter transactions queue behind it.
    await blocker.query('SELECT pg_advisory_lock(1379171467)');
    let queued: Promise<PromiseSettledResult<void>[]>;
    let revokeMs: number | undefined;
    try {
      queued = Promise.allSettled(
        [1, 2, 3].map((i) =>
          identity.rateLimit(`198.51.100.${40 + i}`, `queue${i}@example.test`, 'queue'),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const start = Date.now();
      const revoke = identity.logout(session.secret).then(() => (revokeMs = Date.now() - start));
      await Promise.race([revoke, new Promise((resolve) => setTimeout(resolve, 500))]);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(1379171467)');
    }
    const outcomes = await queued;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      revokeMs !== undefined && revokeMs < 500,
      `revoke blocked for ${revokeMs ?? '>500'} ms`,
    );
    assert.deepEqual(
      outcomes.map((o) => o.status),
      ['fulfilled', 'fulfilled', 'fulfilled'],
    );
  });
  await assert.rejects(
    runner.run('read', (tx) => identity.authenticate(tx, session.secret)),
    ProductAuthenticationError,
  );
});

test('browsers behind one NAT address share its 20 OIDC begins per 15 minutes; every begin counts', async () => {
  // Current policy (ADR0008, operations §3): every attempt counts, not only failures. Sign-in is
  // Google only (ADR 0027), so the client bucket of purpose `oidc` is the one users share.
  for (let i = 0; i < 20; i++)
    await federation.begin(issuer, newSessionSecret(), {}, '198.51.100.7');
  await assert.rejects(
    federation.begin(issuer, newSessionSecret(), {}, '198.51.100.7'),
    ProductAuthenticationError,
  );
  // Another address is not limited by this one.
  await federation.begin(issuer, newSessionSecret(), {}, '198.51.100.8');
});

test('replicas with separate pools enforce one shared limit under concurrent attempts', async () => {
  const replicaPool = await new DataSource(
    productDataSourceOptions(connections.identity),
  ).initialize();
  try {
    const replica = new ProductIdentityService(
      new ProductTransactionRunner({ identity: replicaPool }),
    );

    const attempt = (i: number) =>
      (i % 2 ? replica : identity).rateLimit(
        `192.0.2.${i + 1}`,
        'replica-concurrent@example.test',
        'replica-concurrent',
      );

    const outcomes = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => attempt(i)));
    // Under a loaded host a queued attempt can exceed lock_timeout: it rolls back without counting
    // and is retried here one at a time. The shared cap must still be exactly 20.
    let accepted = 0;
    let refused = 0;
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled') accepted++;
      else if (outcome.reason instanceof ProductAuthenticationError) refused++;
      else {
        assert.ok(outcome.reason instanceof TransactionConflictError);
        await attempt(i).then(
          () => accepted++,
          (error: unknown) => {
            assert.ok(error instanceof ProductAuthenticationError);
            refused++;
          },
        );
      }
    }
    assert.deepEqual([accepted, refused], [20, 10]);
  } finally {
    await replicaPool.destroy();
  }
});
