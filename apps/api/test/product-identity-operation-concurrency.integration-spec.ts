// ADR-15 D11: the three identity commands against each other and against suspend, reactivate and
// assignRole on the same account, plus the savepoint that keeps the transaction usable when the
// function answers "absent" or "not IAM" after the lookup. Real PostgreSQL, one file.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  ProductAuthorization,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductIdentityOperationService } from '../dist/authorization/services/product-identity-operation.service.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import {
  ProductTransactionRunner,
  type ProductTransaction,
  type ProductTransactionMode,
} from '../dist/database/product-transaction.runner.js';
import { FIXTURE_ISSUER, bindAccount } from './oidc-fixture.helper.ts';
import {
  accounts,
  appended,
  audit,
  bindAccountBoundary,
  bindings,
  freshRoot,
  grantViaRole,
  iamUser,
  identityOperations,
  migration,
  pools,
  root,
  setupStack,
  teardownStack,
  validators,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

async function target(state: 'active' | 'suspended' = 'active') {
  const id = randomUUID();
  const email = `${id}@example.test`;
  await migration.query(
    'INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,$2,$3,$4)',
    [id, email, state, state === 'active'],
  );
  await bindAccount(pools.identity, id);
  await migration.query(
    `INSERT INTO mfa_totp(user_id,secret_ciphertext,nonce,key_id) VALUES($1,decode(repeat('ab',36),'hex'),decode(repeat('cd',12),'hex'),'k1')`,
    [id],
  );
  await migration.query('UPDATE mfa_totp SET confirmed_at=statement_timestamp() WHERE user_id=$1', [
    id,
  ]);
  await migration.query('INSERT INTO mfa_recovery_code(user_id,code_hash) VALUES($1,$2)', [
    id,
    Buffer.alloc(32, 3),
  ]);
  return { id, email };
}

interface AccountRow {
  email: string;
  verified: boolean;
  state: string;
  epoch: string;
  totp: number;
  bindings: number;
  invitations: number;
}

const row = async (id: string): Promise<AccountRow> => {
  const [found] = await migration.query<AccountRow[]>(
    `SELECT email_canonical email,email_verified verified,state,auth_epoch::text epoch,
      (SELECT count(*) FROM mfa_totp WHERE user_id=$1)::int totp,
      (SELECT count(*) FROM external_identity e WHERE e.user_id=$1 AND e.enabled)::int bindings,
      (SELECT count(*) FROM oidc_email_enrollment n WHERE n.user_id=$1)::int invitations
     FROM app_user WHERE id=$1`,
    [id],
  );
  if (!found) throw new Error('account row missing');
  return found;
};

const fulfilled = (results: PromiseSettledResult<unknown>[]) =>
  results.filter((r) => r.status === 'fulfilled').length;

test('two changeEmail to the same address: exactly one wins, the other is 409, the epoch moves once', async () => {
  const user = await target();
  const [one, two] = [await freshRoot(), await freshRoot()];
  const before = Number((await row(user.id)).epoch);
  const results = await Promise.allSettled([
    identityOperations().changeEmail(one, user.id, 'same@example.test', FIXTURE_ISSUER),
    identityOperations().changeEmail(two, user.id, 'same@example.test', FIXTURE_ISSUER),
  ]);
  assert.equal(fulfilled(results), 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && failed.reason instanceof ProductCommandRejected);
  assert.equal((await row(user.id)).email, 'same@example.test');
  assert.equal(Number((await row(user.id)).epoch), before + 1);
});

test('two changeEmail to different addresses are serialized: both succeed, the epoch moves twice, one address remains', async () => {
  const user = await target();
  const [one, two] = [await freshRoot(), await freshRoot()];
  const before = Number((await row(user.id)).epoch);
  const results = await Promise.allSettled([
    identityOperations().changeEmail(one, user.id, 'first@example.test', FIXTURE_ISSUER),
    identityOperations().changeEmail(two, user.id, 'second@example.test', FIXTURE_ISSUER),
  ]);
  assert.equal(fulfilled(results), 2);
  assert.ok(['first@example.test', 'second@example.test'].includes((await row(user.id)).email));
  assert.equal(Number((await row(user.id)).epoch), before + 2);
});

test('two resetMfa on one account: exactly one finds a factor, the other is 409; two resetGoogleBinding both succeed and the binding is disabled once', async () => {
  const mfa = await target();
  const [one, two] = [await freshRoot(), await freshRoot()];
  const mfaBefore = Number((await row(mfa.id)).epoch);
  const mfaResults = await Promise.allSettled([
    identityOperations().resetMfa(one, mfa.id),
    identityOperations().resetMfa(two, mfa.id),
  ]);
  assert.equal(fulfilled(mfaResults), 1);
  const failed = mfaResults.find((r) => r.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && failed.reason instanceof ProductCommandRejected);
  // A confirmed factor moves the epoch twice (trigger and function); a second run would add more.
  assert.equal(Number((await row(mfa.id)).epoch), mfaBefore + 2);

  const binding = await target();
  const bindingBefore = Number((await row(binding.id)).epoch);
  const results = await Promise.allSettled([
    identityOperations().resetGoogleBinding(one, binding.id, FIXTURE_ISSUER),
    identityOperations().resetGoogleBinding(two, binding.id, FIXTURE_ISSUER),
  ]);
  assert.equal(fulfilled(results), 2);
  const after = await row(binding.id);
  assert.deepEqual([after.state, after.bindings, after.invitations], ['pending', 0, 1]);
  assert.equal(Number(after.epoch), bindingBefore + 2);
  const versions = await migration.query<{ v: string }[]>(
    'SELECT binding_version::text v FROM external_identity WHERE user_id=$1',
    [binding.id],
  );
  assert.deepEqual(versions, [{ v: '2' }]);
});

test('identity commands interleaved with suspend, reactivate and assignRole end in the one state either order allows', async () => {
  for (let round = 0; round < 3; round += 1) {
    const [a, b, c, d] = [
      await freshRoot(),
      await freshRoot(),
      await freshRoot(),
      await freshRoot(),
    ];

    const emailTarget = await target();
    const emailBefore = Number((await row(emailTarget.id)).epoch);
    const emailRun = await Promise.all([
      identityOperations().changeEmail(
        a,
        emailTarget.id,
        `after-${round}@example.test`,
        FIXTURE_ISSUER,
      ),
      accounts().suspendUser(b, emailTarget.id),
    ]);
    assert.deepEqual(emailRun, [true, true]);
    const emailAfter = await row(emailTarget.id);
    assert.deepEqual(
      [emailAfter.state, emailAfter.email, emailAfter.verified],
      ['suspended', `after-${round}@example.test`, false],
    );
    assert.equal(Number(emailAfter.epoch), emailBefore + 2);

    const bindingTarget = await target();
    const bindingRun = await Promise.all([
      identityOperations().resetGoogleBinding(c, bindingTarget.id, FIXTURE_ISSUER),
      accounts().suspendUser(d, bindingTarget.id),
    ]);
    assert.deepEqual(bindingRun, [true, true]);
    const bindingAfter = await row(bindingTarget.id);
    assert.deepEqual(
      [bindingAfter.state, bindingAfter.bindings, bindingAfter.invitations],
      ['suspended', 0, 1],
    );

    const [e, f, g, h] = [
      await freshRoot(),
      await freshRoot(),
      await freshRoot(),
      await freshRoot(),
    ];
    const suspended = await target('suspended');
    const reactivateRun = await Promise.all([
      identityOperations().resetGoogleBinding(e, suspended.id, FIXTURE_ISSUER),
      accounts().reactivateUser(f, suspended.id),
    ]);
    assert.deepEqual(reactivateRun, [true, true]);
    const reactivated = await row(suspended.id);
    assert.deepEqual(
      [reactivated.state, reactivated.bindings, reactivated.invitations],
      ['pending', 0, 1],
    );

    const roleTarget = await target();
    const roleRun = await Promise.all([
      identityOperations().resetMfa(g, roleTarget.id),
      accounts().assignRole(h, roleTarget.id, 'hr.admin'),
    ]);
    assert.deepEqual(roleRun, [true, true]);
    assert.equal((await row(roleTarget.id)).totp, 0);
    assert.deepEqual(
      await migration.query(
        "SELECT convert_from(role_key,'UTF8') r FROM user_role WHERE user_id=$1",
        [roleTarget.id],
      ),
      [{ r: 'hr.admin' }],
    );
  }
});

/** Rewrites the account argument of the identity functions: the row vanished or became Root after the lookup. */
class Substituting extends ProductTransactionRunner {
  readonly #replacement: string;

  constructor(replacement: string) {
    super(pools);
    this.#replacement = replacement;
  }

  override run<T>(
    mode: ProductTransactionMode,
    work: (tx: ProductTransaction) => Promise<T>,
    options: { readonly serialize?: number } = {},
  ): Promise<T> {
    return super.run(
      mode,
      (tx) => {
        const manager: EntityManager = tx.manager;
        const query = manager.query.bind(manager);
        manager.query = ((sql: string, parameters?: unknown[]) =>
          /public\.(change_iam_account_email|reset_iam_mfa|reset_iam_google_binding)\(/.test(sql) &&
          parameters
            ? query(sql, [this.#replacement, ...parameters.slice(1)])
            : query(sql, parameters)) as typeof manager.query;
        return work(tx);
      },
      options,
    );
  }
}

test('the function answering "absent" or "not IAM" after the lookup is "not found" and the transaction stays usable', async () => {
  const admin = await iamUser(true);
  const permissions = ['account.changeEmail', 'account.resetMfa', 'account.resetGoogleBinding'];
  await grantViaRole(admin.id, permissions);
  await bindAccountBoundary(admin.id, permissions, 'identityAdministration');
  for (const replacement of [randomUUID(), root.id]) {
    const authority = new ProductAuthorization(new Substituting(replacement), audit, bindings, {
      validators,
      obligations: createProductObligations(audit),
    });
    const ops = new ProductIdentityOperationService(authority, audit, bindings);
    const runs: [string, (secret: string, id: string) => Promise<boolean>][] = [
      [
        'identity.email-change',
        (s, id) => ops.changeEmail(s, id, 'raced@example.test', FIXTURE_ISSUER),
      ],
      ['identity.mfa-reset-by-permission', (s, id) => ops.resetMfa(s, id)],
      ['identity.binding-reset', (s, id) => ops.resetGoogleBinding(s, id, FIXTURE_ISSUER)],
    ];
    for (const [kind, run] of runs) {
      const user = await target();
      const before = await row(user.id);
      const rootRootBefore = await row(root.id);
      const asRoot = await appended(async () =>
        assert.equal(await run(await freshRoot(), user.id), false),
      );
      // The Root audit event is written after the rollback to the savepoint, in the same transaction.
      assert.deepEqual(
        asRoot.added.map((e) => [e[0], e[4].outcome]),
        [[kind, 'absent']],
      );
      const asIam = await appended(async () =>
        assert.equal(await run(admin.secret, user.id), false),
      );
      assert.deepEqual(
        asIam.added.filter((e) => e[0] === kind),
        [],
      );
      assert.equal(asIam.added.length, 1, 'the access event of the committed transaction');
      assert.deepEqual(await row(user.id), before);
      assert.deepEqual(await row(root.id), rootRootBefore);
    }
  }
});

test('a business refusal (409) rolls the whole transaction back, savepoint included', async () => {
  const user = await target();
  await migration.query('DELETE FROM mfa_recovery_code WHERE user_id=$1', [user.id]);
  await migration.query('DELETE FROM mfa_totp WHERE user_id=$1', [user.id]);
  const before = await row(user.id);
  const fresh = await freshRoot();
  const result = await appended(() =>
    assert.rejects(identityOperations().resetMfa(fresh, user.id), ProductCommandRejected),
  );
  assert.deepEqual(result.added, []);
  assert.equal(result.after, result.before);
  assert.deepEqual(await row(user.id), before);
});
