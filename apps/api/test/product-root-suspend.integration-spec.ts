// Root: suspending IAM accounts and the IAM boundary.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { oidcSession } from './oidc-fixture.helper.ts';
import {
  utf8,
  pools,
  runner,
  root,
  service,
  freshRoot,
  appended,
  iamUser,
  grantViaRole,
  account,
  setupStack,
  teardownStack,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

test('Root suspends an IAM account; itself, absent and malformed ids reveal nothing', async () => {
  const member = await iamUser();
  const s = service();
  // account.suspend's policy has fresh@1: a stale Root session is refused before any effect, with
  // no data change and no success audit (ADR 0022); after reauthentication it succeeds.
  const stale = await appended(() =>
    assert.rejects(s.suspendUser(root.stale, member.id), ProductAccessDenied),
  );
  assert.deepEqual(stale.added, []);
  assert.equal(stale.after, stale.before);
  assert.deepEqual(await account(member.id), [{ state: 'active', epoch: '1' }]);
  const fresh = await freshRoot();
  const done = await appended(async () =>
    assert.equal(await s.suspendUser(fresh, member.id), true),
  );
  assert.deepEqual(done.added, [
    [
      'account.suspend',
      root.id,
      'account.suspend',
      null,
      {
        principalKind: 'root',
        outcome: 'ok',
        targetUserId: member.id,
        resultingRevision: done.after,
      },
    ],
  ]);
  assert.deepEqual(await account(member.id), [{ state: 'suspended', epoch: '2' }]);
  for (const target of [root.id, randomUUID()]) {
    const absent = await appended(async () =>
      assert.equal(await s.suspendUser(fresh, target), false),
    );
    assert.deepEqual(absent.added, [
      [
        'account.suspend',
        root.id,
        'account.suspend',
        null,
        {
          principalKind: 'root',
          outcome: 'absent',
          targetUserId: target,
          resultingRevision: absent.after,
        },
      ],
    ]);
  }
  assert.equal((await account(root.id))[0]?.state, 'active');
  // A non-canonical id is refused before any lookup: 403 and no event.
  assert.deepEqual(
    (
      await appended(() =>
        assert.rejects(s.suspendUser(fresh, member.id.toUpperCase()), ProductAccessDenied),
      )
    ).added,
    [],
  );
});

test('IAM suspend needs a grant and a boundary; self is 403; Root is invisible to IAM', async () => {
  const admin = await iamUser(true);
  const staleAdmin = await oidcSession(pools.identity, admin.id);
  const unbounded = await iamUser(true);
  const target = await iamUser();
  // The grants come through a role: IAM actors are compared with their target by grant set.
  await grantViaRole(admin.id, ['account.suspend']);
  await grantViaRole(unbounded.id, ['account.suspend']);
  await runner.run('admin', async (tx) => {
    await tx.manager.query(
      'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)',
      [admin.id, utf8('account.suspend'), utf8('accountAll')],
    );
  });
  const s = service();
  await assert.rejects(s.suspendUser(unbounded.secret, target.id), ProductAccessDenied);
  await assert.rejects(s.suspendUser(admin.secret, admin.id), ProductAccessDenied);
  assert.equal(await s.suspendUser(admin.secret, root.id), false);
  assert.equal((await account(root.id))[0]?.state, 'active');
  // freshAuthentication@1 still decides for IAM, from the same SQL boolean.
  await assert.rejects(s.suspendUser(staleAdmin, target.id), ProductAccessDenied);
  const done = await appended(async () =>
    assert.equal(await s.suspendUser(admin.secret, target.id), true),
  );
  assert.deepEqual(done.added, [
    ['access.suspend', admin.id, 'account.suspend', null, {}],
    [
      'account.suspend',
      admin.id,
      'account.suspend',
      null,
      { targetUserId: target.id, resultingRevision: done.after },
    ],
  ]);
});
