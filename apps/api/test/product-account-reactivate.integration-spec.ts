// account.reactivate (ADR 0041 §6, wave 1): un-suspend of IAM accounts through the SECURITY DEFINER
// function reactivate_iam_account; every case runs against real PostgreSQL via the service.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductAccountService } from '../dist/authorization/services/product-account.service.js';
import { sessionDigest } from '../dist/authentication/services/product-identity.service.js';
import {
  ProductAuditRepository,
  type ProductAuditEvent,
} from '../dist/audit/product-audit.repository.js';
import type { ProductTransaction } from '../dist/database/product-transaction.runner.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { sqlState } from './setup-postgres.ts';
import {
  FIXTURE_ISSUER,
  bindAccount,
  fixtureProvider,
  oidcSession,
} from './oidc-fixture.helper.ts';
import {
  account,
  appended,
  bindAccountBoundary,
  bindings,
  freshRoot,
  grantViaRole,
  iamUser,
  migration,
  pools,
  root,
  runner,
  accounts,
  setupStack,
  teardownStack,
  validators,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

/** An IAM actor with the grant, and the boundary binding when asked, for `account.reactivate`. */
async function actor(options: { fresh: boolean; boundary: boolean }) {
  const user = await iamUser(options.fresh);
  // One role, not a rule on the user: IAM actors are compared with their target by grant set.
  await grantViaRole(user.id, ['account.reactivate']);
  if (options.boundary) await bindAccountBoundary(user.id, ['account.reactivate']);
  return user;
}

/** A bound account (it has logged in once) that Root suspended. `oldSession` died with that. */
async function suspendedBound() {
  const user = await iamUser();
  assert.equal(await accounts().suspendUser(await freshRoot(), user.id), true);
  return user;
}

/** A pending account that never logged in: provisioned, enrollment untouched, then suspended. */
async function suspendedUnbound() {
  const id = randomUUID();
  await pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
    id,
    `${id}@example.test`,
    FIXTURE_ISSUER,
    root.id,
  ]);
  assert.equal(await accounts().suspendUser(await freshRoot(), id), true);
  return id as IdentityId;
}

const sessionRows = (secret: string) =>
  pools.authority.query<{ user_id: string }[]>('SELECT user_id FROM public.resolve_session($1)', [
    sessionDigest(secret),
  ]);

test('Root reactivates a bound suspended account: active, new epoch, audited, old session dead', async () => {
  const user = await iamUser();
  const oldSession = user.secret;
  const s = accounts();
  const fresh = await freshRoot();
  assert.equal(await s.suspendUser(fresh, user.id), true);
  assert.deepEqual(await account(user.id), [{ state: 'suspended', epoch: '2' }]);
  // A stale Root session is refused before any effect (fresh@1, ADR 0022).
  const stale = await appended(() =>
    assert.rejects(s.reactivateUser(root.stale, user.id), ProductAccessDenied),
  );
  assert.deepEqual(stale.added, []);
  assert.equal(stale.after, stale.before);
  const done = await appended(async () =>
    assert.equal(await s.reactivateUser(fresh, user.id), true),
  );
  assert.deepEqual(done.added, [
    [
      'account.reactivate',
      root.id,
      'account.reactivate',
      null,
      {
        principalKind: 'root',
        outcome: 'ok',
        targetUserId: user.id,
        resultingRevision: done.after,
      },
    ],
  ]);
  assert.deepEqual(await account(user.id), [{ state: 'active', epoch: '3' }]);
  // No session is restored: the pre-suspend session never resolves again; a new login does.
  assert.deepEqual(await sessionRows(oldSession), []);
  const next = await oidcSession(pools.identity, user.id);
  assert.deepEqual(await sessionRows(next), [{ user_id: user.id }]);
});

test('a never-logged-in account returns to pending with its enrollment untouched', async () => {
  const id = await suspendedUnbound();
  const before = await migration.query<{ expires_at: Date; created_at: Date }[]>(
    'SELECT expires_at,created_at FROM oidc_email_enrollment WHERE user_id=$1',
    [id],
  );
  assert.equal(before.length, 1);
  assert.equal(await accounts().reactivateUser(await freshRoot(), id), true);
  assert.deepEqual(await account(id), [{ state: 'pending', epoch: '3' }]);
  assert.deepEqual(
    await migration.query(
      'SELECT expires_at,created_at FROM oidc_email_enrollment WHERE user_id=$1',
      [id],
    ),
    before,
  );
});

test('only an enabled binding makes the account active; a disabled one leaves it pending', async () => {
  const user = await suspendedBound();
  await migration.query('UPDATE external_identity SET enabled=false WHERE user_id=$1', [user.id]);
  assert.equal(await accounts().reactivateUser(await freshRoot(), user.id), true);
  assert.equal((await account(user.id))[0]?.state, 'pending');
});

test('a disabled provider leaves the account pending even with an enabled binding', async () => {
  // The target is bound at its own provider, so Root's session at the fixture provider stays valid.
  const other = 'https://idp.other.fixture';
  await fixtureProvider(migration, other);
  const id = randomUUID() as IdentityId;
  await migration.query(`INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`, [
    id,
  ]);
  await bindAccount(pools.identity, id, `sub-${id}`, other);
  const fresh = await freshRoot();
  assert.equal(await accounts().suspendUser(fresh, id), true);
  await migration.query('UPDATE oidc_provider SET enabled=false WHERE issuer=$1', [other]);
  assert.equal(await accounts().reactivateUser(fresh, id), true);
  assert.deepEqual(await account(id), [{ state: 'pending', epoch: '3' }]);
});

test('only a suspended account is reactivated: active and pending are 409, nothing changes', async () => {
  const active = await iamUser();
  const pending = await suspendedUnbound();
  assert.equal(await accounts().reactivateUser(await freshRoot(), pending), true);
  const s = accounts();
  const fresh = await freshRoot();
  for (const id of [active.id, pending]) {
    const before = await account(id);
    const refused = await appended(() =>
      assert.rejects(s.reactivateUser(fresh, id), ProductCommandRejected),
    );
    assert.deepEqual(refused.added, []);
    assert.equal(refused.after, refused.before);
    assert.deepEqual(await account(id), before);
  }
});

test('self is 403 before the state check; Root and absent ids are the same "not found"', async () => {
  const admin = await actor({ fresh: true, boundary: true });
  const s = accounts();
  await assert.rejects(s.reactivateUser(admin.secret, admin.id), ProductAccessDenied);
  const fresh = await freshRoot();
  for (const target of [root.id, randomUUID()]) {
    const absent = await appended(async () =>
      assert.equal(await s.reactivateUser(fresh, target), false),
    );
    assert.deepEqual(absent.added[0]?.slice(0, 3), [
      'account.reactivate',
      root.id,
      'account.reactivate',
    ]);
    assert.equal(absent.added[0]?.[4].outcome, 'absent');
    assert.equal(await s.reactivateUser(admin.secret, target), false);
  }
  assert.equal((await account(root.id))[0]?.state, 'active');
  // A non-canonical id is refused before any lookup.
  const target = await suspendedBound();
  assert.deepEqual(
    (
      await appended(() =>
        assert.rejects(s.reactivateUser(fresh, target.id.toUpperCase()), ProductAccessDenied),
      )
    ).added,
    [],
  );
});

test('actor matrix: IAM needs the grant, the boundary binding and a fresh session', async () => {
  const full = await actor({ fresh: true, boundary: true });
  const noBoundary = await actor({ fresh: true, boundary: false });
  const stale = await actor({ fresh: true, boundary: true });
  const staleSecret = await oidcSession(pools.identity, stale.id);
  const nothing = await iamUser(true);
  const target = await suspendedBound();
  const s = accounts();
  for (const secret of [noBoundary.secret, staleSecret, nothing.secret])
    await assert.rejects(s.reactivateUser(secret, target.id), ProductAccessDenied);
  assert.equal((await account(target.id))[0]?.state, 'suspended');
  const done = await appended(async () =>
    assert.equal(await s.reactivateUser(full.secret, target.id), true),
  );
  assert.deepEqual(done.added, [
    ['access.reactivate', full.id, 'account.reactivate', null, {}],
    [
      'account.reactivate',
      full.id,
      'account.reactivate',
      null,
      { targetUserId: target.id, resultingRevision: done.after },
    ],
  ]);
  assert.equal((await account(target.id))[0]?.state, 'active');
  // Root is invisible to an IAM actor, even a fully entitled one.
  assert.equal(await s.reactivateUser(full.secret, root.id), false);
});

test('two concurrent reactivations of one account: exactly one succeeds, the epoch moves once', async () => {
  const user = await suspendedBound();
  const [one, two] = [await freshRoot(), await freshRoot()];
  const results = await Promise.allSettled([
    accounts().reactivateUser(one, user.id),
    accounts().reactivateUser(two, user.id),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && failed.reason instanceof ProductCommandRejected);
  assert.deepEqual(await account(user.id), [{ state: 'active', epoch: '3' }]);
});

test('an audit failure rolls the reactivation back: state, epoch and revision unchanged', async () => {
  class FailingAudit extends ProductAuditRepository {
    override async appendProductAudit(tx: ProductTransaction, event: ProductAuditEvent) {
      if (event.kind === 'account.reactivate') throw new Error('audit unavailable');
      await super.appendProductAudit(tx, event);
    }
  }
  const failing = new FailingAudit();
  const s = new ProductAccountService(
    new ProductAuthorization(runner, failing, bindings, {
      validators,
      obligations: createProductObligations(failing),
    }),
    failing,
    bindings,
  );
  const user = await suspendedBound();
  const fresh = await freshRoot();
  const result = await appended(() =>
    assert.rejects(s.reactivateUser(fresh, user.id), /audit unavailable/),
  );
  assert.deepEqual(result.added, []);
  assert.equal(result.after, result.before);
  assert.deepEqual(await account(user.id), [{ state: 'suspended', epoch: '2' }]);
});

test('the definer: authority only, kind iam hard-coded, suspended only; the trigger still binds authority', async () => {
  const user = await suspendedBound();

  const call = (pool: keyof typeof pools, id: string) =>
    pools[pool].query('SELECT public.reactivate_iam_account($1)', [id]);

  // No other runtime login can execute it, not even for a valid target.
  for (const pool of ['data', 'identity', 'sync', 'bootstrap'] as const)
    assert.equal(await sqlState(call(pool, user.id)), '42501', pool);
  assert.equal((await account(user.id))[0]?.state, 'suspended');
  // Authority may not write the transition itself: protect_account_lifecycle is unchanged.
  assert.equal(
    await sqlState(
      pools.authority.query(`UPDATE app_user SET state='active' WHERE id=$1`, [user.id]),
    ),
    '42501',
  );
  // Absent id and a non-suspended target are refused with their own, non-permission, errors.
  assert.equal(await sqlState(call('authority', randomUUID())), 'P0002');
  const active = await iamUser();
  assert.equal(await sqlState(call('authority', active.id)), '55000');
  assert.equal((await account(active.id))[0]?.state, 'active');
});

test('Root can never be reactivated by a runtime login, even suspended (kind check, not state)', async () => {
  const message = async (pool: keyof typeof pools) => {
    try {
      await pools[pool].query('SELECT public.reactivate_iam_account($1)', [root.id]);
    } catch (error) {
      return (error as Error).message;
    }
    return 'accepted';
  };

  // Root suspended the only way a runtime login can (offline bootstrap credential, ADR 0012).
  await pools.bootstrap.query(
    `UPDATE app_user SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1`,
    [root.id],
  );
  assert.equal((await account(root.id))[0]?.state, 'suspended');
  for (const pool of ['data', 'identity', 'sync', 'bootstrap'] as const)
    assert.match(await message(pool), /permission denied/, pool);
  assert.match(await message('authority'), /only IAM accounts/);
  assert.equal((await account(root.id))[0]?.state, 'suspended');
});
