import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { verifyProductPrivileges } from '../dist/database/helpers/product-database.helper.js';
import { sessionDigest } from '../dist/auth/services/product-identity.service.js';
import { revokeProductRoot } from '../dist/authorization/services/product-root-lifecycle.service.js';
import { sqlState, withClient } from './setup-postgres.ts';
import { activateRootAccount, oidcSession } from './oidc-fixture.helper.ts';
import { core, startRootGuardsStack, type RootGuardsStack } from './root-guards-stack.helper.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

const runtime = ['data', 'identity', 'authority', 'sync', 'bootstrap', 'outbox'] as const;
let stack: RootGuardsStack;
let root: RootGuardsStack['root'];
let member: RootGuardsStack['member'];
let pools: RootGuardsStack['pools'];
let connections: RootGuardsStack['connections'];
let migration: RootGuardsStack['migration'];
let runner: RootGuardsStack['runner'];
let identity: RootGuardsStack['identity'];
let activationSecret: string;
let rootSession = '';
before(async () => {
  stack = await startRootGuardsStack();
  ({ root, member, pools, connections, migration, runner, identity, activationSecret } = stack);
});
after(async () => {
  await stack?.stop();
});

test('lifecycle: bootstrap never touches IAM, authority never touches Root, identity keeps its flows', async () => {
  for (const sql of [
    `UPDATE app_user SET state='suspended' WHERE id=$1`,
    'UPDATE app_user SET auth_epoch=auth_epoch+1 WHERE id=$1',
  ]) {
    await assert.rejects(pools.bootstrap.query(sql, [member]), /may not change IAM/);
    await assert.rejects(pools.authority.query(sql, [root]), /offline or identity only/);
  }
  for (const login of ['data', 'sync', 'outbox'] as const)
    await withClient(connections[login], async (c) =>
      assert.equal(
        await sqlState(c.query(`UPDATE app_user SET state='suspended' WHERE id=$1`, [root])),
        '42501',
        login,
      ),
    );
  // Identity activates the Root (state and epoch, as the Google activation does) and ends its
  // sessions; the proof of the bootstrap is consumed with it.
  assert.ok(activationSecret);
  await activateRootAccount(pools.identity, root);
  const extra = await oidcSession(pools.identity, root);
  await identity.logout(extra, true);
  rootSession = await oidcSession(pools.identity, root);
  assert.deepEqual(await migration.query('SELECT state,kind FROM app_user WHERE id=$1', [root]), [
    { state: 'active', kind: 'root' },
  ]);
});

test('iam_account hides Root, DELETE app_user is refused, resolve_session reports kind', async () => {
  assert.deepEqual(
    await pools.authority.query('SELECT id FROM iam_account WHERE id=ANY($1::uuid[])', [
      [root, member],
    ]),
    [{ id: member }],
  );
  await withClient(connections.data, async (c) =>
    assert.equal(await sqlState(c.query('SELECT id FROM iam_account')), '42501'),
  );
  for (const login of runtime)
    await withClient(connections[login], async (c) =>
      assert.equal(
        await sqlState(c.query('DELETE FROM app_user WHERE id=$1', [member])),
        '42501',
        login,
      ),
    );
  assert.deepEqual(
    await pools.data.query('SELECT user_id,kind FROM public.resolve_session($1)', [
      sessionDigest(rootSession),
    ]),
    [{ user_id: root, kind: 'root' }],
  );
});

test('no runtime login lifts a Root suspension; the approved offline repair does (spec 4.6)', async () => {
  assert.deepEqual(
    await revokeProductRoot(
      runner,
      audit,
      {
        operationId: randomUUID(),
        userId: root,
        approval: 'CHG-guard',
        reason: 'Fixture revocation',
      },
      core,
    ),
    { revoked: true },
  );
  await assert.rejects(
    pools.identity.query(`UPDATE app_user SET state='active' WHERE id=$1`, [root]),
    /identity may only activate pending accounts/,
  );
  await assert.rejects(
    pools.bootstrap.query(`UPDATE app_user SET state='active' WHERE id=$1`, [root]),
    /may only suspend Root/,
  );
  await assert.rejects(
    pools.authority.query(`UPDATE app_user SET state='active' WHERE id=$1`, [root]),
    /offline or identity only/,
  );
  // A disabled guard is drift: startup refuses it.
  await migration.query('ALTER TABLE app_user DISABLE TRIGGER guard_root_lifecycle');
  try {
    await assert.rejects(verifyProductPrivileges(pools), /protection drift/);
  } finally {
    await migration.query('ALTER TABLE app_user ENABLE TRIGGER guard_root_lifecycle');
  }
  // The repair: table owner, one transaction, exactly the Root row (ADR 0012 runbook).
  await migration.transaction(async (m) => {
    await m.query('ALTER TABLE public.app_user DISABLE TRIGGER guard_root_lifecycle');
    await m.query(
      `UPDATE public.app_user SET state='active' WHERE id=$1 AND kind='root' AND state='suspended'`,
      [root],
    );
    await m.query('ALTER TABLE public.app_user ENABLE TRIGGER guard_root_lifecycle');
  });
  assert.deepEqual(await migration.query('SELECT state FROM app_user WHERE id=$1', [root]), [
    { state: 'active' },
  ]);
  await verifyProductPrivileges(pools);
});
