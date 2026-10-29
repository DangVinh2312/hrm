// Grant-set invariant for account.suspend and account.reactivate: an IAM actor
// may only act on a target whose effective grant set is within its own; otherwise the answer is
// the one for an absent account (false -> 404). Real PostgreSQL, service level, one file.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { GrantFactsRepository } from '../dist/authorization/repositories/grant-facts.repository.js';
import {
  account,
  appended,
  bindAccountBoundary,
  freshRoot,
  grantViaRole,
  iamUser,
  migration,
  root,
  runner,
  accounts,
  setupStack,
  teardownStack,
  utf8,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

interface Command {
  readonly name: 'suspend' | 'reactivate';
  readonly permission: string;

  /** A target in the state the command expects. */
  readonly target: () => Promise<{ id: string }>;

  readonly run: (secret: string, id: string) => Promise<boolean>;

  readonly done: string;
  readonly before: string;
}

const commands: readonly Command[] = [
  {
    name: 'suspend',
    permission: 'account.suspend',
    target: () => iamUser(),
    run: (secret, id) => accounts().suspendUser(secret, id),
    before: 'active',
    done: 'suspended',
  },
  {
    name: 'reactivate',
    permission: 'account.reactivate',
    target: async () => {
      const user = await iamUser();
      assert.equal(await accounts().suspendUser(await freshRoot(), user.id), true);
      return user;
    },
    run: (secret, id) => accounts().reactivateUser(secret, id),
    before: 'suspended',
    done: 'active',
  },
];

/** An IAM actor with a fresh session, the command grant through a role and the boundary. */
async function actor(permission: string, more: Parameters<typeof grantViaRole>[1] = []) {
  const user = await iamUser(true);
  await grantViaRole(user.id, [permission, ...more]);
  await bindAccountBoundary(user.id, [permission]);
  return user;
}

const stateOf = async (id: string) => (await account(id))[0];

for (const c of commands) {
  const refusedAndUnchanged = async (secret: string, id: string) => {
    const before = await stateOf(id);
    const result = await appended(async () => assert.equal(await c.run(secret, id), false));
    // Nothing of the command happened: no `account.<command>` event, same state and epoch.
    assert.equal(
      result.added.some((event) => event[0] === `account.${c.name}`),
      false,
    );
    assert.deepEqual(await stateOf(id), before);
  };

  test(`${c.name}: an actor whose set contains the target's set acts (equal, smaller, empty)`, async () => {
    const full = await actor(c.permission);
    const noGrants = await c.target();
    const same = await c.target();
    await grantViaRole(same.id, [c.permission]);
    const second = await c.target();
    for (const target of [noGrants, same]) {
      assert.equal(await c.run(full.secret, target.id), true);
      assert.equal((await stateOf(target.id))?.state, c.done);
    }
    // A target with only part of the actor's grants is within it too.
    const bigActor = await actor(c.permission, ['account.provision', 'account.read']);
    await grantViaRole(second.id, ['account.read']);
    assert.equal(await c.run(bigActor.secret, second.id), true);
  });

  test(`${c.name}: the union of several roles of the actor counts`, async () => {
    const user = await iamUser(true);
    await grantViaRole(user.id, [c.permission]);
    await grantViaRole(user.id, ['account.provision']);
    await bindAccountBoundary(user.id, [c.permission]);
    const target = await c.target();
    await grantViaRole(target.id, ['account.provision']);
    await grantViaRole(target.id, [c.permission]);
    assert.equal(await c.run(user.secret, target.id), true);
  });

  test(`${c.name}: a target with a grant outside the actor set is "not found", nothing changes`, async () => {
    const admin = await actor(c.permission);
    const larger = await c.target();
    await grantViaRole(larger.id, [c.permission, 'account.provision']);
    await refusedAndUnchanged(admin.secret, larger.id);
    // Revoking the extra role is seen by the very next command: no cached comparison.
    await runner.run('admin', async (tx) => {
      await tx.manager.query(
        `DELETE FROM user_role WHERE user_id=$1 AND role_key IN (SELECT role_key FROM policy_rule WHERE permission_key=$2)`,
        [larger.id, utf8('account.provision')],
      );
    });
    assert.equal(await c.run(admin.secret, larger.id), true);
  });

  test(`${c.name}: same permission with another template or parameters is incomparable: "not found"`, async () => {
    const admin = await actor(c.permission);
    for (const other of [
      { permission: c.permission, parameters: { scope: 'x' } },
      { permission: c.permission, template: 'setting' },
    ]) {
      const target = await c.target();
      await grantViaRole(target.id, [other]);
      await refusedAndUnchanged(admin.secret, target.id);
    }
  });

  test(`${c.name}: a deny or a rule on the user, on the target or on the actor, is refused`, async () => {
    const admin = await actor(c.permission);
    const denied = await c.target();
    await grantViaRole(denied.id, [{ permission: c.permission, effect: 'deny' }]);
    await refusedAndUnchanged(admin.secret, denied.id);

    const userRule = await c.target();
    await migration.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow','allAccounts',1,'{}','runtime')",
      [randomUUID(), utf8(c.permission), userRule.id],
    );
    await refusedAndUnchanged(admin.secret, userRule.id);

    // The actor's own set must be provable as well: a deny of its own makes every target 404,
    // even one without any grant, but self stays 403 (checked first).
    const tainted = await actor(c.permission, [{ permission: 'account.read', effect: 'deny' }]);
    const plain = await c.target();
    await refusedAndUnchanged(tainted.secret, plain.id);
    await assert.rejects(c.run(tainted.secret, tainted.id), ProductAccessDenied);
  });

  test(`${c.name}: Root bypasses the comparison; Root and absent targets stay "not found" for IAM`, async () => {
    const rootSecret = await freshRoot();
    const large = await c.target();
    await grantViaRole(large.id, [
      c.permission,
      'account.provision',
      { permission: 'account.read', effect: 'deny' },
    ]);
    assert.equal(await c.run(rootSecret, large.id), true);
    assert.equal((await stateOf(large.id))?.state, c.done);
    const admin = await actor(c.permission);
    assert.equal(await c.run(admin.secret, root.id), false);
    assert.equal(await c.run(admin.secret, randomUUID()), false);
  });
}

test('reactivate: the comparison runs before the state check, so a larger account does not leak its state', async () => {
  const admin = await actor('account.reactivate');
  const activeLarger = await iamUser();
  await grantViaRole(activeLarger.id, ['account.reactivate', 'account.provision']);
  // Not suspended and larger: 404 (false), not the 409 an equal account would get.
  assert.equal(await accounts().reactivateUser(admin.secret, activeLarger.id), false);
  const activeEqual = await iamUser();
  await assert.rejects(accounts().reactivateUser(admin.secret, activeEqual.id), /not_suspended/);
});

test('the facts of actor and target come from one statement (no per-role or per-rule query)', async () => {
  const one = await iamUser();
  const two = await iamUser();
  await grantViaRole(one.id, ['account.suspend', 'account.read']);
  await grantViaRole(one.id, ['account.provision']);
  await grantViaRole(two.id, ['account.suspend']);
  const repository = new GrantFactsRepository();
  await runner.run('admin', async (tx) => {
    let statements = 0;
    const query = tx.manager.query.bind(tx.manager);
    tx.manager.query = ((...args: Parameters<typeof query>) => {
      statements++;
      return query(...args);
    }) as typeof tx.manager.query;
    const { facts, truncated } = await repository.read(tx.manager, [one.id, two.id]);
    assert.equal(truncated, false);
    assert.equal(statements, 1);
    assert.deepEqual((facts.get(one.id) ?? []).map((f) => f.permission).sort(), [
      'account.provision',
      'account.read',
      'account.suspend',
    ]);
    assert.deepEqual(
      (facts.get(two.id) ?? []).map((f) => [f.permission, f.source, f.effect]),
      [['account.suspend', 'role', 'allow']],
    );
  });
  // An account without any role or rule is present in the answer with an empty set.
  const empty = await iamUser();
  await runner.run('admin', async (tx) => {
    assert.deepEqual((await repository.read(tx.manager, [empty.id])).facts.get(empty.id), []);
  });
});

test('a read cut off by the row cap is reported, and a command refuses instead of comparing a cut set', async () => {
  const repository = new GrantFactsRepository();
  const holder = await iamUser();
  await grantViaRole(holder.id, ['account.suspend', 'account.read', 'account.provision']);
  await runner.run('admin', async (tx) => {
    const cut = await repository.read(tx.manager, [holder.id], 2);
    assert.equal(cut.truncated, true);
    assert.equal(cut.facts.get(holder.id)?.length, 2);
    assert.equal((await repository.read(tx.manager, [holder.id], 3)).truncated, false);
  });
  // One role of 20001 distinct rules held by actor AND target: the target is within the actor, but
  // the two sets together exceed the cap, so the answer is "not found" rather than a guess.
  const actor = await iamUser(true);
  const target = await iamUser();
  const role = await grantViaRole(actor.id, ['account.suspend']);
  await bindAccountBoundary(actor.id, ['account.suspend']);
  await runner.run('admin', async (tx) => {
    await tx.manager.query(
      `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       SELECT gen_random_uuid(), $1, $2, 'allow', $3, 1, jsonb_build_object('i', g), 'runtime' FROM generate_series(1, 20001) g`,
      [utf8('account.read'), utf8(role), utf8('allAccounts')],
    );
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      target.id,
      utf8(role),
    ]);
  });
  const before = (await stateOf(target.id))?.state;
  assert.equal(await accounts().suspendUser(actor.secret, target.id), false);
  assert.equal((await stateOf(target.id))?.state, before);
});
