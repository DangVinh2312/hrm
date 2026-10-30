// account.bindBoundary / account.unbindBoundary (ADR-13 D5): who may bind the package
// `accountAdministration@1`, the invariants (a), (b), (d), (e), the 409 and 403 states, the effect
// of the real boundary on the nine permissions of the package, atomic audit, the shared-fence
// pre-check and concurrency. Service level on real PostgreSQL, synthetic people only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { FIXTURE_ISSUER } from './oidc-fixture.helper.ts';
import { ProductAuthenticationError } from '../dist/authentication/services/product-identity.service.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { productReleaseSource } from '../dist/authorization/product.manifest.js';
import { AccountBoundaryService } from '../dist/authorization/services/account-boundary.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import {
  ProductTransactionRunner,
  type ProductTransaction,
  type ProductTransactionMode,
} from '../dist/database/product-transaction.runner.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import {
  AuthorityUnavailableError,
  TransactionConflictError,
} from '../dist/database/helpers/transaction-errors.helper.js';
import {
  type GrantSpec,
  accounts,
  appended,
  bindAccountBoundary,
  bindings,
  boundaryBindings,
  core,
  freshRoot,
  grantViaRole,
  iamUser,
  migration,
  pools,
  release,
  revision,
  root,
  runner,
  service,
  setupStack,
  teardownStack,
  utf8,
  validators,
} from './product-root-stack.helper.ts';

after(teardownStack);

const PACKAGE = [
  'account.assignRole',
  'account.bindBoundary',
  'account.provision',
  'account.reactivate',
  'account.revokeRole',
  'account.suspend',
  'account.unbindBoundary',
  'role.delete',
  'role.update',
];
// This stack has no role anchor table: the permits of role.update|delete run in hrm-role-write.
const ACCOUNT_PACKAGE = PACKAGE.filter((permission) => permission.startsWith('account.'));
const ADMIN = { key: 'accountAdministration', version: 1 } as const;
const COMMANDS = ['account.bindBoundary', 'account.unbindBoundary'];
const PAIR = { key: 'fixturePair', version: 1 } as const;

type Ref = { key: string; version: number };

const bind = (secret: string, id: string, ref: Ref = ADMIN) =>
  boundaryBindings().bindBoundary(secret, id, ref);

const unbind = (secret: string, id: string, ref: Ref = ADMIN) =>
  boundaryBindings().unbindBoundary(secret, id, ref);

const grantFor = (permission: string): GrantSpec => ({
  permission,
  template: permission.startsWith('role.') ? 'role' : 'allAccounts',
});

/** An IAM actor with a fresh session, the two commands granted and the whole package bound to it. */
async function admin(extra: readonly (string | GrantSpec)[] = []) {
  const user = await iamUser(true);
  const role = await grantViaRole(user.id, [...COMMANDS, ...extra]);
  await bindAccountBoundary(user.id, PACKAGE);
  return { ...user, role };
}

const bound = async (id: string) =>
  (
    await migration.query<{ permission: string; key: string; version: number; seeded: boolean }[]>(
      `SELECT convert_from(permission_key,'UTF8') AS permission, convert_from(boundary_key,'UTF8') AS key,
              boundary_version AS version, seed_owner IS NOT NULL AS seeded
         FROM user_boundary WHERE user_id=$1 ORDER BY permission_key`,
      [id],
    )
  ).map((row) => ({ ...row }));

const eventsLike = (pattern: string) =>
  migration.query<
    { kind: string; actor: string; object: string | null; metadata: Record<string, string> }[]
  >(
    `SELECT convert_from(event_kind,'UTF8') AS kind, actor_id::text AS actor, object_id::text AS object, safe_metadata AS metadata
       FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE $1 ORDER BY occurred_at, event_id`,
    [pattern],
  );

const boundaryEvents = () => eventsLike('permission.boundary-%');

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

const denied = (error: unknown) => error instanceof ProductAccessDenied;

const invalid = (error: unknown) => error instanceof ProductInvalidRequest;

/** Nothing of the command happened: same bindings on the target, no event, same revision. */
async function untouched(id: string, run: () => Promise<unknown>, check: (e: unknown) => boolean) {
  const [rows, events, before] = [
    await bound(id),
    (await boundaryEvents()).length,
    await revision(),
  ];
  await assert.rejects(run(), check);
  assert.deepEqual(await bound(id), rows);
  assert.equal((await boundaryEvents()).length, events);
  assert.equal(await revision(), before);
}

/** "Not found" (`false`): same bindings, no boundary event. */
async function notFound(id: string, run: () => Promise<boolean>) {
  const [rows, events] = [await bound(id), (await boundaryEvents()).length];
  assert.equal(await run(), false);
  assert.deepEqual(await bound(id), rows);
  assert.equal((await boundaryEvents()).length, events);
}

async function fixtureBoundary(key: string, lifecycle: string, permissions: readonly string[]) {
  await migration.query(
    "INSERT INTO permission_boundary(boundary_key,boundary_version,definition_hash,definition,lifecycle) VALUES($1,1,decode(repeat('ab',32),'hex'),'{}',$2)",
    [utf8(key), lifecycle],
  );
  for (const permission of permissions)
    await migration.query(
      "INSERT INTO permission_boundary_entry(boundary_key,boundary_version,permission_key,definition) VALUES($1,1,$2,'{}')",
      [utf8(key), utf8(permission)],
    );
}

type Fixture = readonly [key: string, lifecycle: string, permissions: readonly string[]];

/**
 * Boundary definitions only the owner could write, present for `run` alone: the protected hash of
 * the code-owned tables would call them drift and a later release publish would refuse.
 */
async function withFixtures(fixtures: readonly Fixture[], run: () => Promise<void>) {
  for (const [key, lifecycle, permissions] of fixtures)
    await fixtureBoundary(key, lifecycle, permissions);
  try {
    await run();
  } finally {
    for (const [key] of fixtures) {
      for (const table of ['user_boundary', 'permission_boundary_entry', 'permission_boundary'])
        await migration.query(`DELETE FROM ${table} WHERE boundary_key=$1`, [utf8(key)]);
    }
  }
}

const PAIR_FIXTURE: Fixture = [PAIR.key, 'active', ['account.suspend', 'account.reactivate']];

before(setupStack);

let sequence = 4;
type Seed = {
  owner: string;
  identity: IdentityId;
  permission: string;
  boundary: { key: string; version: number };
};
const seeds: Seed[] = [];
const removals: { owner: string; identity: IdentityId; permission: string }[] = [];

/** Publishes the next release with the seeds collected so far plus the ones given (what sync writes with `seed_owner`). */
async function publish(more: readonly Seed[] = [], gone: typeof removals = []) {
  const next = prepareProductRelease(
    {
      ...productReleaseSource,
      sequence: String(sequence + 1),
      predecessor: String(sequence),
      boundaryBindings: [...seeds, ...more],
      removeBoundaryBindings: [...removals, ...gone],
    },
    core,
  );
  const result = await new ProductManifestReconciler(runner, new ProductAuditRepository(), {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(next);
  sequence += 1;
  seeds.push(...more);
  removals.push(...gone);
  return result;
}

const seed = (identity: IdentityId, permission: string) =>
  publish([{ owner: 'fixtureseed', identity, permission, boundary: ADMIN }]);

test('an IAM actor binds the whole package: nine runtime rows in one INSERT, one audit event', async () => {
  const actor = await admin();
  const target = await iamUser();
  await migration.query(
    `CREATE TABLE d5_statements(n int);
     CREATE FUNCTION d5_count() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO d5_statements SELECT count(*) FROM new_rows; RETURN NULL; END $$;
     CREATE TRIGGER d5_count AFTER INSERT ON user_boundary REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION d5_count();`,
  );
  try {
    const result = await appended(async () =>
      assert.equal(await bind(actor.secret, target.id), true),
    );
    assert.equal(BigInt(result.after), BigInt(result.before) + 1n);
    assert.deepEqual(
      (await migration.query<{ n: number }[]>('SELECT n FROM d5_statements')).map((r) => r.n),
      [PACKAGE.length],
      'one INSERT statement wrote the whole package',
    );
  } finally {
    await migration.query(
      'DROP TRIGGER d5_count ON user_boundary; DROP FUNCTION d5_count; DROP TABLE d5_statements',
    );
  }
  assert.deepEqual(
    await bound(target.id),
    PACKAGE.map((permission) => ({ permission, ...ADMIN, seeded: false })),
  );
  const [event, ...others] = (await boundaryEvents()).filter((e) => e.object === target.id);
  assert.equal(others.length, 0);
  assert.equal(event?.kind, 'permission.boundary-assign');
  assert.equal(event?.actor, actor.id);
  assert.equal(event?.metadata.boundaryKey, 'accountAdministration');
  assert.equal(event?.metadata.boundaryVersion, '1');
  assert.equal(event?.metadata.targetUserId, target.id);
  assert.equal(event?.metadata.principalKind, undefined);
  assert.deepEqual(Object.keys(event?.metadata ?? {}).sort(), [
    'boundaryKey',
    'boundaryVersion',
    'key',
    'keyKind',
    'resource',
    'resultingRevision',
    'targetUserId',
  ]);
});

test('an IAM actor unbinds the package: the runtime rows go in one command, one audit event', async () => {
  const actor = await admin();
  const target = await iamUser();
  assert.equal(await bind(actor.secret, target.id), true);
  const result = await appended(async () =>
    assert.equal(await unbind(actor.secret, target.id), true),
  );
  assert.equal(BigInt(result.after), BigInt(result.before) + 1n);
  assert.deepEqual(await bound(target.id), []);
  const [event, ...others] = (await boundaryEvents()).filter(
    (e) => e.kind === 'permission.boundary-revoke' && e.object === target.id,
  );
  assert.equal(others.length, 0);
  assert.equal(event?.actor, actor.id);
  assert.equal(event?.metadata.boundaryKey, 'accountAdministration');
  assert.equal(event?.metadata.boundaryVersion, '1');
  assert.equal(event?.metadata.targetUserId, target.id);
});

test('Root binds and unbinds with the Root marker; no email reaches audit', async () => {
  const rootSecret = await freshRoot();
  const target = await iamUser();
  assert.equal(await bind(rootSecret, target.id), true);
  assert.equal((await bound(target.id)).length, PACKAGE.length);
  assert.equal(await unbind(rootSecret, target.id), true);
  const mine = (await boundaryEvents()).filter((e) => e.object === target.id);
  assert.deepEqual(
    mine.map((e) => [e.kind, e.actor, e.metadata.principalKind, e.metadata.outcome]),
    [
      ['permission.boundary-assign', root.id, 'root', 'ok'],
      ['permission.boundary-revoke', root.id, 'root', 'ok'],
    ],
  );
  for (const e of mine) assert.ok(!JSON.stringify(e).includes('@'));
});

test('first administrator: only Root can bind the first one; each then binds the next, no wider than itself', async () => {
  const first = await iamUser(true);
  await grantViaRole(first.id, COMMANDS);
  const second = await iamUser(true);
  await grantViaRole(second.id, COMMANDS);
  const third = await iamUser();
  // Grants alone reach nothing: the commands are boundary required.
  await untouched(second.id, () => bind(first.secret, second.id), denied);
  assert.equal(await bind(await freshRoot(), first.id), true);
  assert.equal(await bind(first.secret, second.id), true);
  assert.equal(await bind(second.secret, third.id), true);
  assert.equal((await bound(third.id)).length, PACKAGE.length);
  // Taking the package away from the first stops it at the next request.
  assert.equal(await unbind(await freshRoot(), first.id), true);
  await untouched(third.id, () => unbind(first.secret, third.id), denied);
});

test('any account state is allowed: a suspended and a pending account take and lose the package', async () => {
  const actor = await admin();
  const suspended = await iamUser();
  assert.equal(await accounts().suspendUser(await freshRoot(), suspended.id), true);
  assert.equal(await bind(actor.secret, suspended.id), true);
  assert.equal(await unbind(actor.secret, suspended.id), true);
  const pending = randomUUID();
  await pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
    pending,
    `${pending}@example.test`,
    FIXTURE_ISSUER,
    root.id,
  ]);
  assert.equal(await bind(actor.secret, pending), true);
  assert.equal((await bound(pending)).length, PACKAGE.length);
});

test('the real boundary decides the seven account permissions: a grant alone reaches nothing, a bound package reaches all, unbinding takes it back', async () => {
  const holder = await iamUser(true);
  await grantViaRole(holder.id, ACCOUNT_PACKAGE.map(grantFor));
  const victim = await iamUser();

  const reach = async () =>
    Promise.all(
      ACCOUNT_PACKAGE.map(async (permission) => {
        const [resource, action] = permission.split('.') as [string, string];
        return [permission, await service().permits(holder.secret, resource, action)] as const;
      }),
    );

  assert.deepEqual(
    (await reach()).filter(([, ok]) => ok),
    [],
    'no binding: nothing',
  );
  await untouched(victim.id, () => accounts().suspendUser(holder.secret, victim.id), denied);
  assert.equal(await bind(await freshRoot(), holder.id), true);
  assert.deepEqual(
    (await reach()).filter(([, ok]) => !ok),
    [],
    'bound: every permission of the package',
  );
  assert.equal(await accounts().suspendUser(holder.secret, victim.id), true);
  assert.equal(await accounts().reactivateUser(holder.secret, victim.id), true);
  assert.equal(await unbind(await freshRoot(), holder.id), true);
  assert.deepEqual(
    (await reach()).filter(([, ok]) => ok),
    [],
    'unbound: nothing again',
  );
  await untouched(victim.id, () => accounts().suspendUser(holder.secret, victim.id), denied);
});

test('a package binding does not grant: bound without a grant the plan still reaches nothing', async () => {
  const bare = await iamUser(true);
  assert.equal(await bind(await freshRoot(), bare.id), true);
  for (const permission of ACCOUNT_PACKAGE) {
    const [resource, action] = permission.split('.') as [string, string];
    assert.equal(await service().permits(bare.secret, resource, action), false, permission);
  }
});

test('(a) self: bind and unbind on oneself are 403, nothing changes, no audit, revision unchanged', async () => {
  const actor = await admin();
  await untouched(actor.id, () => bind(actor.secret, actor.id), denied);
  await untouched(actor.id, () => unbind(actor.secret, actor.id), denied);
  // Self is judged before the boundary is looked at: also for an unknown one.
  await untouched(
    actor.id,
    () => bind(actor.secret, actor.id, { key: 'nope', version: 1 }),
    denied,
  );
});

test('(b) Root, an absent id and a foreign id are the same "not found", for bind and unbind', async () => {
  const actor = await admin();
  for (const id of [root.id, randomUUID()]) {
    const before = await revision();
    assert.equal(await bind(actor.secret, id), false);
    assert.equal(await unbind(actor.secret, id), false);
    assert.equal((await boundaryEvents()).filter((e) => e.object === id).length, 0);
    assert.equal(BigInt(await revision()), BigInt(before));
  }
  // Root targeting Root or an absent id: the same answer, never a binding on the Root row.
  const rootSecret = await freshRoot();
  const seen = (await eventsLike('access.account.%oundary')).length;
  assert.equal(await bind(rootSecret, root.id), false);
  assert.equal(await bind(rootSecret, randomUUID()), false);
  assert.equal(await unbind(rootSecret, randomUUID()), false);
  assert.deepEqual(await bound(root.id), []);
  const added = (await eventsLike('access.account.%oundary')).slice(seen);
  assert.deepEqual(
    added.map((e) => [e.kind, e.metadata.principalKind, e.metadata.outcome]),
    [
      ['access.account.bindBoundary', 'root', 'absent'],
      ['access.account.bindBoundary', 'root', 'absent'],
      ['access.account.unbindBoundary', 'root', 'absent'],
    ],
  );
});

test('a non-canonical id is 403 before any query, a malformed reference is 400 before any transaction', async () => {
  for (const id of ['', 'x', root.id.toUpperCase(), `${randomUUID()} `, '../etc'])
    for (const run of [bind, unbind]) await assert.rejects(run('not-a-session', id), denied);
  const actor = await admin();
  await assert.rejects(bind('not-a-session', randomUUID()), ProductAuthenticationError);
  await assert.rejects(bind(actor.secret, 'ABC'), denied);
  for (const bad of [
    { key: '', version: 1 },
    { key: 'a b', version: 1 },
    { key: 'a'.repeat(97), version: 1 },
    { key: '1a', version: 1 },
    { key: 'a', version: 0 },
    { key: 'a', version: -1 },
    { key: 'a', version: 1.5 },
    { key: 'a', version: 2147483648 },
    { key: 5 as never, version: 1 },
    { key: 'a', version: '1' as never },
    null as never,
  ])
    for (const run of [bind, unbind])
      await assert.rejects(run('not-a-session', randomUUID(), bad), invalid);
});

test('(d) a target whose set is larger than the actor set is "not found" for bind and unbind; Root is outside the comparison', async () => {
  const actor = await admin(['account.read']);
  const larger = await iamUser();
  await grantViaRole(larger.id, ['account.provision']);
  await notFound(larger.id, () => bind(actor.secret, larger.id));
  assert.equal(await bind(await freshRoot(), larger.id), true);
  await notFound(larger.id, () => unbind(actor.secret, larger.id));
  assert.equal((await bound(larger.id)).length, PACKAGE.length);
  assert.equal(await unbind(await freshRoot(), larger.id), true);
});

test('(d) an equal or smaller set passes; a deny or a user rule on the target cannot be proven: "not found"', async () => {
  const actor = await admin(['account.read']);
  const same = await iamUser();
  await grantViaRole(same.id, ['account.read']);
  assert.equal(await bind(actor.secret, same.id), true);
  const denyTarget = await iamUser();
  await grantViaRole(denyTarget.id, [{ permission: 'account.read', effect: 'deny' }]);
  await notFound(denyTarget.id, () => bind(actor.secret, denyTarget.id));
  const userRule = await iamUser();
  await migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow','allAccounts',1,'{}','runtime')",
    [randomUUID(), utf8('account.read'), userRule.id],
  );
  await notFound(userRule.id, () => bind(actor.secret, userRule.id));
});

test('(e) an unknown, deprecated or retired boundary, an unknown version, an empty one and one with an optional entry are 400; nothing is written', async () => {
  const actor = await admin();
  const target = await iamUser();
  const rootSecret = await freshRoot();
  await withFixtures(
    [
      ['fixtureDeprecated', 'deprecated', ['account.suspend']],
      ['fixtureRetired', 'retired', ['account.suspend']],
      ['fixtureMixed', 'active', ['account.suspend', 'account.read']],
      ['fixtureEmpty', 'active', []],
    ],
    async () => {
      for (const ref of [
        { key: 'nope', version: 1 },
        { key: ADMIN.key, version: 2 },
        { key: 'fixtureDeprecated', version: 1 },
        { key: 'fixtureRetired', version: 1 },
        { key: 'fixtureMixed', version: 1 },
        { key: 'fixtureEmpty', version: 1 },
      ])
        for (const secret of [actor.secret, rootSecret])
          await untouched(target.id, () => bind(secret, target.id, ref), invalid);
    },
  );
});

test('(e) the 400 comes after (a), (b) and (d): self, absent and larger targets never learn about the boundary', async () => {
  const actor = await admin(['account.read']);
  const larger = await iamUser();
  await grantViaRole(larger.id, ['account.provision']);
  const nope = { key: 'nope', version: 1 };
  await untouched(actor.id, () => bind(actor.secret, actor.id, nope), denied);
  await notFound(larger.id, () => bind(actor.secret, larger.id, nope));
  assert.equal(await bind(actor.secret, randomUUID(), nope), false);
  assert.equal(await bind(actor.secret, root.id, nope), false);
});

test('(e) a boundary of required entries other than the shipped one binds as well: hrAdministration@1', async () => {
  const rootSecret = await freshRoot();
  const target = await iamUser();
  const ref = { key: 'hrAdministration', version: 1 };
  assert.equal(await bind(rootSecret, target.id, ref), true);
  assert.deepEqual(
    (await bound(target.id)).map((r) => [r.permission, r.key, r.version, r.seeded]),
    [
      ['employee.linkAccount', 'hrAdministration', 1, false],
      ['team.assign', 'hrAdministration', 1, false],
    ],
  );
  assert.equal(await unbind(rootSecret, target.id, ref), true);
  assert.deepEqual(await bound(target.id), []);
});

test('(e) one binding per (user, permission): a package that overlaps any binding, runtime or seeded, is 409 and writes nothing', async () => {
  const actor = await admin();
  const rootSecret = await freshRoot();
  const runtimeBound = await iamUser();
  await bindAccountBoundary(runtimeBound.id, ['account.suspend']);
  for (const secret of [actor.secret, rootSecret])
    await untouched(
      runtimeBound.id,
      () => bind(secret, runtimeBound.id),
      rejected('boundary_bound'),
    );
  assert.equal((await bound(runtimeBound.id)).length, 1);
  // The last permission of the package alone is enough, and so is a seeded row.
  const last = await iamUser();
  await bindAccountBoundary(last.id, ['role.update']);
  await untouched(last.id, () => bind(actor.secret, last.id), rejected('boundary_bound'));
  const seeded = await iamUser();
  await seed(seeded.id, 'account.revokeRole');
  await untouched(seeded.id, () => bind(rootSecret, seeded.id), rejected('boundary_bound'));
  assert.deepEqual(
    (await bound(seeded.id)).map((r) => [r.permission, r.seeded]),
    [['account.revokeRole', true]],
  );
  // Twice in a row: the second is 409 and the first stays.
  const twice = await iamUser();
  assert.equal(await bind(actor.secret, twice.id), true);
  await untouched(twice.id, () => bind(actor.secret, twice.id), rejected('boundary_bound'));
  assert.equal((await bound(twice.id)).length, PACKAGE.length);
});

test('(e) an IAM actor binds only what it holds itself: the same (key, version) for every permission of the package, else 403', async () => {
  const target = await iamUser();
  const none = await iamUser(true);
  await grantViaRole(none.id, COMMANDS);
  await bindAccountBoundary(none.id, COMMANDS);
  await untouched(target.id, () => bind(none.secret, target.id), denied);
  // Eight of nine is still 403.
  const partial = await iamUser(true);
  await grantViaRole(partial.id, COMMANDS);
  await bindAccountBoundary(
    partial.id,
    PACKAGE.filter((p) => p !== 'role.delete'),
  );
  await untouched(target.id, () => bind(partial.secret, target.id), denied);
  // The 403 comes before the 409: a target that is bound already does not show it.
  const bound9 = await iamUser();
  assert.equal(await bind(await freshRoot(), bound9.id), true);
  await untouched(bound9.id, () => bind(partial.secret, bound9.id), denied);
});

test('(e) another key holds nothing: an actor bound to the pair under fixturePair binds the pair, an actor bound under accountAdministration does not', async () => {
  await withFixtures([PAIR_FIXTURE], async () => {
    const target = await iamUser();
    const sameKey = await iamUser(true);
    await grantViaRole(sameKey.id, COMMANDS);
    await bindAccountBoundary(sameKey.id, [...COMMANDS, 'account.suspend', 'account.reactivate']);
    await untouched(target.id, () => bind(sameKey.secret, target.id, PAIR), denied);
    const holder = await iamUser(true);
    await grantViaRole(holder.id, COMMANDS);
    await bindAccountBoundary(holder.id, COMMANDS);
    await migration.query(
      'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$4,1),($1,$3,$4,1)',
      [holder.id, utf8('account.suspend'), utf8('account.reactivate'), utf8(PAIR.key)],
    );
    assert.equal(await bind(holder.secret, target.id, PAIR), true);
    assert.deepEqual(
      (await bound(target.id)).map((r) => [r.permission, r.key]),
      [
        ['account.reactivate', 'fixturePair'],
        ['account.suspend', 'fixturePair'],
      ],
    );
    // One binding per permission: the pair on top of the shipped package is the same conflict.
    const packaged = await iamUser();
    assert.equal(await bind(await freshRoot(), packaged.id), true);
    await untouched(
      packaged.id,
      async () => bind(await freshRoot(), packaged.id, PAIR),
      rejected('boundary_bound'),
    );
  });
});

test('unbind: seeded rows of the package are never deleted, runtime rows of it are; nothing to delete is 409', async () => {
  const actor = await admin();
  const rootSecret = await freshRoot();
  const mixed = await iamUser();
  await seed(mixed.id, 'account.suspend');
  await bindAccountBoundary(
    mixed.id,
    PACKAGE.filter((p) => p !== 'account.suspend'),
  );
  assert.equal(await unbind(actor.secret, mixed.id), true);
  assert.deepEqual(
    (await bound(mixed.id)).map((r) => [r.permission, r.seeded]),
    [['account.suspend', true]],
  );
  for (const secret of [actor.secret, rootSecret])
    await untouched(mixed.id, () => unbind(secret, mixed.id), rejected('boundary_not_bound'));
  // Nothing bound at all, and a boundary nobody knows: the same 409.
  const empty = await iamUser();
  for (const secret of [actor.secret, rootSecret]) {
    await untouched(empty.id, () => unbind(secret, empty.id), rejected('boundary_not_bound'));
    await untouched(
      empty.id,
      () => unbind(secret, empty.id, { key: 'nope', version: 9 }),
      rejected('boundary_not_bound'),
    );
  }
  // Another boundary of the same account is not touched by the unbind of this one.
  const other = await iamUser();
  assert.equal(await bind(rootSecret, other.id, { key: 'hrAdministration', version: 1 }), true);
  await untouched(other.id, () => unbind(actor.secret, other.id), rejected('boundary_not_bound'));
});

test('the database is the second layer: authority can neither delete, rewrite nor create a seeded binding', async () => {
  const target = await iamUser();
  await seed(target.id, 'account.provision');

  const fails = async (operation: Promise<unknown>) => {
    try {
      await operation;
    } catch (error) {
      return String((error as { code?: unknown }).code);
    }
    return 'ok';
  };

  assert.equal(
    await fails(pools.authority.query('DELETE FROM user_boundary WHERE user_id=$1', [target.id])),
    '42501',
  );
  assert.equal(
    await fails(
      pools.authority.query('UPDATE user_boundary SET seed_owner=NULL WHERE user_id=$1', [
        target.id,
      ]),
    ),
    '42501',
  );
  assert.equal(
    await fails(
      pools.authority.query(
        'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version,seed_owner) VALUES($1,$2,$3,1,$4)',
        [target.id, utf8('account.suspend'), utf8(ADMIN.key), utf8('x')],
      ),
    ),
    '42501',
  );
  const [trigger] = await migration.query<{ n: number }[]>(
    "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='user_boundary'::regclass AND tgname LIKE 'protect%' AND NOT tgisinternal",
  );
  assert.ok((trigger?.n ?? 0) >= 1);
  assert.deepEqual(
    (await bound(target.id)).map((r) => [r.permission, r.seeded]),
    [['account.provision', true]],
  );
});

test('unbind needs no holding: an actor that holds only the unbind permission removes the package; (a), (b) and (d) apply', async () => {
  const rootSecret = await freshRoot();
  const weak = await iamUser(true);
  await grantViaRole(weak.id, ['account.unbindBoundary']);
  await bindAccountBoundary(weak.id, ['account.unbindBoundary']);
  const target = await iamUser();
  assert.equal(await bind(rootSecret, target.id), true);
  assert.equal(await unbind(weak.secret, target.id), true);
  assert.deepEqual(await bound(target.id), []);
  await untouched(weak.id, () => unbind(weak.secret, weak.id), denied);
  assert.equal(await unbind(weak.secret, root.id), false);
  assert.equal(await unbind(weak.secret, randomUUID()), false);
  const larger = await iamUser();
  await grantViaRole(larger.id, ['account.provision']);
  assert.equal(await bind(rootSecret, larger.id), true);
  await notFound(larger.id, () => unbind(weak.secret, larger.id));
  // Not 409 either: a larger account does not show whether it has anything to lose.
  const largerEmpty = await iamUser();
  await grantViaRole(largerEmpty.id, ['account.provision']);
  await notFound(largerEmpty.id, () => unbind(weak.secret, largerEmpty.id));
});

test('boundary is required: a grant without a binding is denied for bind and unbind, and nothing changes', async () => {
  const unbound = await iamUser(true);
  await grantViaRole(unbound.id, COMMANDS);
  const target = await iamUser();
  await untouched(target.id, () => bind(unbound.secret, target.id), denied);
  assert.equal(await bind(await freshRoot(), target.id), true);
  await untouched(target.id, () => unbind(unbound.secret, target.id), denied);
  const half = await iamUser(true);
  await grantViaRole(half.id, COMMANDS);
  await bindAccountBoundary(half.id, ['account.unbindBoundary']);
  await untouched(target.id, () => bind(half.secret, target.id), denied);
});

test('fresh@1 is required for bind and unbind, for an IAM actor and for Root', async () => {
  const stale = await iamUser(false);
  await grantViaRole(stale.id, COMMANDS);
  await bindAccountBoundary(stale.id, PACKAGE);
  const target = await iamUser();
  await untouched(target.id, () => bind(stale.secret, target.id), denied);
  assert.equal(await bind(await freshRoot(), target.id), true);
  await untouched(target.id, () => unbind(stale.secret, target.id), denied);
  await untouched(target.id, () => unbind(root.stale, target.id), denied);
  const another = await iamUser();
  await untouched(another.id, () => bind(root.stale, another.id), denied);
});

test('the release gives no default grant to either command and no code role carries one', async () => {
  const [row] = await migration.query<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM policy_rule WHERE convert_from(permission_key,'UTF8') = ANY($1) AND managed_by='code'`,
    [COMMANDS],
  );
  assert.equal(row?.n, '0');
  // hr.admin plus the whole package bound but no grant for the commands: the plan reaches no account.
  const hr = await iamUser(true);
  await migration.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
    hr.id,
    utf8('hr.admin'),
  ]);
  await bindAccountBoundary(hr.id, PACKAGE);
  const target = await iamUser();
  await notFound(target.id, () => bind(hr.secret, target.id));
  await notFound(target.id, () => unbind(hr.secret, target.id));
});

/** An authorization over a runner whose lock wait is short, so waiting for the fence is visible. */
function impatient() {
  const audit = new ProductAuditRepository();
  const short = new ProductTransactionRunner(pools, { lockTimeoutMs: 100, maxRetries: 0 });
  const authority = new ProductAuthorization(short, audit, bindings, {
    validators,
    obligations: createProductObligations(audit),
  });
  return new AccountBoundaryService(authority, audit, bindings);
}

test('F1: an unreachable caller is answered under the shared fence: it does not wait for the exclusive fence', async () => {
  const nobody = await iamUser(true);
  const unbound = await iamUser(true);
  await grantViaRole(unbound.id, COMMANDS);
  const target = await iamUser();
  const permitted = await admin();
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const holder = runner.run('read', async () => {
    entered();
    await open;
  });
  const impatientService = impatient();
  try {
    await inside;
    await assert.rejects(
      new ProductTransactionRunner(pools, { lockTimeoutMs: 100, maxRetries: 0 }).run('admin', () =>
        Promise.resolve(),
      ),
      (e) => e instanceof TransactionConflictError || e instanceof AuthorityUnavailableError,
    );
    for (const caller of [nobody, unbound]) {
      await assert.rejects(impatientService.bindBoundary(caller.secret, target.id, ADMIN), denied);
      await assert.rejects(
        impatientService.unbindBoundary(caller.secret, target.id, ADMIN),
        denied,
      );
    }
    for (const id of [randomUUID(), root.id]) {
      assert.equal(await impatientService.bindBoundary(permitted.secret, id, ADMIN), false);
      assert.equal(await impatientService.unbindBoundary(permitted.secret, id, ADMIN), false);
    }
  } finally {
    release();
    await holder;
  }
});

test('F1: an unreachable caller or target leaves the revision unchanged', async () => {
  const permitted = await admin();
  for (const id of [randomUUID(), root.id]) {
    const before = await revision();
    assert.equal(await bind(permitted.secret, id), false);
    assert.equal(await unbind(permitted.secret, id), false);
    assert.equal(await revision(), before);
  }
  const target = await iamUser();
  for (const caller of [await iamUser(true), await iamUser(false)]) {
    const before = await revision();
    await assert.rejects(bind(caller.secret, target.id), denied);
    await assert.rejects(unbind(caller.secret, target.id), denied);
    assert.equal(await revision(), before);
  }
});

test('F1: the exclusive step decides again: a binding removed after the shared check is not honoured', async () => {
  class Hooked extends ProductTransactionRunner {
    before: (() => Promise<void>) | undefined;

    override async run<T>(
      mode: ProductTransactionMode,
      work: (tx: ProductTransaction) => Promise<T>,
      options: { readonly serialize?: number } = {},
    ): Promise<T> {
      if (mode === 'admin') await this.before?.();
      return super.run(mode, work, options);
    }
  }
  const hooked = new Hooked(pools);
  const audit = new ProductAuditRepository();
  const hookedService = new AccountBoundaryService(
    new ProductAuthorization(hooked, audit, bindings, {
      validators,
      obligations: createProductObligations(audit),
    }),
    audit,
    bindings,
  );
  const actor = await admin();
  const target = await iamUser();
  hooked.before = async () => {
    await migration.query('DELETE FROM user_boundary WHERE user_id=$1', [actor.id]);
  };
  await assert.rejects(hookedService.bindBoundary(actor.secret, target.id, ADMIN), denied);
  assert.deepEqual(await bound(target.id), []);
});

test('a failing audit rolls the whole command back, for IAM and for Root, bind and unbind', async () => {
  class Failing extends ProductAuditRepository {
    override appendProductAudit(): Promise<void> {
      return Promise.reject(new Error('audit down'));
    }
  }
  const failing = new AccountBoundaryService(
    new ProductAuthorization(runner, new ProductAuditRepository(), bindings, {
      validators,
      obligations: createProductObligations(new ProductAuditRepository()),
    }),
    new Failing(),
    bindings,
  );
  const actor = await admin();
  const rootSecret = await freshRoot();
  const target = await iamUser();

  const fault = (e: unknown) => e instanceof Error && e.message === 'audit down';

  for (const secret of [actor.secret, rootSecret])
    await untouched(target.id, () => failing.bindBoundary(secret, target.id, ADMIN), fault);
  assert.equal(await bind(rootSecret, target.id), true);
  for (const secret of [actor.secret, rootSecret])
    await untouched(target.id, () => failing.unbindBoundary(secret, target.id, ADMIN), fault);
  assert.equal((await bound(target.id)).length, PACKAGE.length);
});

test('concurrency: two binds of one target give one success and one 409; the table has one package', async () => {
  const actor = await admin();
  const other = await admin();
  const target = await iamUser();
  const results = await Promise.allSettled([
    bind(actor.secret, target.id),
    bind(other.secret, target.id),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value === true);
  const conflict = results.filter(
    (r) => r.status === 'rejected' && rejected('boundary_bound')(r.reason),
  );
  assert.equal(ok.length, 1);
  assert.equal(conflict.length, 1);
  assert.equal((await bound(target.id)).length, PACKAGE.length);
  assert.equal((await boundaryEvents()).filter((e) => e.object === target.id).length, 1);
});

test('concurrency: bind against unbind ends consistent, never a half package', async () => {
  const actor = await admin();
  const other = await admin();
  const target = await iamUser();
  const [b, u] = await Promise.allSettled([
    bind(actor.secret, target.id),
    unbind(other.secret, target.id),
  ]);
  assert.equal(b.status, 'fulfilled');
  const rows = (await bound(target.id)).length;
  if (u.status === 'fulfilled') assert.equal(rows, 0);
  else {
    assert.ok(rejected('boundary_not_bound')(u.reason));
    assert.equal(rows, PACKAGE.length);
  }
});

test('concurrency: bind against suspend of the same account: both land', async () => {
  const actor = await admin();
  const rootSecret = await freshRoot();
  const target = await iamUser();
  const [b, s] = await Promise.all([
    bind(actor.secret, target.id),
    accounts().suspendUser(rootSecret, target.id),
  ]);
  assert.equal(b, true);
  assert.equal(s, true);
  assert.equal((await bound(target.id)).length, PACKAGE.length);
  const [row] = await migration.query<{ state: string }[]>(
    'SELECT state FROM app_user WHERE id=$1',
    [target.id],
  );
  assert.equal(row?.state, 'suspended');
});

test('lock order: fence, then the target row, then the grant facts, then the bindings, then the write, then audit', async () => {
  const statements: string[] = [];
  class Spy extends ProductTransactionRunner {
    override run<T>(
      mode: ProductTransactionMode,
      work: (tx: ProductTransaction) => Promise<T>,
      options: { readonly serialize?: number } = {},
    ): Promise<T> {
      return super.run(
        mode,
        (tx) => {
          if (mode === 'admin') {
            const query = tx.manager.query.bind(tx.manager);
            tx.manager.query = ((sql: string, ...rest: unknown[]) => {
              statements.push(sql);
              return (query as (s: string, ...r: unknown[]) => Promise<unknown>)(sql, ...rest);
            }) as typeof tx.manager.query;
          }
          return work(tx);
        },
        options,
      );
    }
  }
  const audit = new ProductAuditRepository();
  const spied = new AccountBoundaryService(
    new ProductAuthorization(new Spy(pools), audit, bindings, {
      validators,
      obligations: createProductObligations(audit),
    }),
    audit,
    bindings,
  );
  const actor = await admin();
  const target = await iamUser();

  const index = (pattern: RegExp, from = 0) =>
    statements.findIndex((s, i) => i >= from && pattern.test(s));

  assert.equal(await spied.bindBoundary(actor.secret, target.id, ADMIN), true);
  const lock = index(/FROM app_user WHERE id=\$1 FOR NO KEY UPDATE/);
  const facts = index(/FROM user_role ur JOIN policy_rule/);
  const held = index(/FROM user_boundary/, facts);
  const write = index(/INSERT INTO user_boundary/);
  const audited = index(/audit_outbox/, write);
  assert.ok(
    lock >= 0 && facts > lock && held > facts && write > held && audited > write,
    JSON.stringify({ lock, facts, held, write, audited }),
  );
  assert.equal(statements.filter((s) => /INSERT INTO user_boundary/.test(s)).length, 1);
  assert.equal(statements.filter((s) => /FROM user_role ur JOIN policy_rule/.test(s)).length, 1);
  statements.length = 0;
  assert.equal(await spied.unbindBoundary(actor.secret, target.id, ADMIN), true);
  const unlock = index(/FROM app_user WHERE id=\$1 FOR NO KEY UPDATE/);
  const unfacts = index(/FROM user_role ur JOIN policy_rule/);
  const remove = index(/DELETE FROM user_boundary/);
  const unaudited = index(/audit_outbox/, remove);
  assert.ok(unlock >= 0 && unfacts > unlock && remove > unfacts && unaudited > remove);
  assert.equal(statements.filter((s) => /DELETE FROM user_boundary/.test(s)).length, 1);
});

test('sync leaves runtime bindings alone: a later release, a colliding seed and a removal naming them change nothing', async () => {
  const rootSecret = await freshRoot();
  const target = await iamUser();
  assert.equal(await bind(rootSecret, target.id), true);
  const rows = await bound(target.id);
  const other = await iamUser();
  assert.equal(
    (
      await publish([
        { owner: 'fixtureseed', identity: other.id, permission: 'role.update', boundary: ADMIN },
      ])
    ).changed,
    true,
  );
  assert.deepEqual(await bound(target.id), rows);
  assert.deepEqual(
    (await bound(other.id)).map((r) => [r.permission, r.seeded]),
    [['role.update', true]],
  );
  await assert.rejects(
    publish([
      { owner: 'fixtureseed', identity: target.id, permission: 'account.suspend', boundary: ADMIN },
    ]),
    /collision/,
  );
  assert.deepEqual(await bound(target.id), rows);
  assert.equal(
    (
      await publish(
        [],
        [{ owner: 'fixtureseed', identity: target.id, permission: 'account.suspend' }],
      )
    ).changed,
    true,
  );
  assert.deepEqual(await bound(target.id), rows, 'a seed removal never deletes a runtime row');
  assert.equal(
    rows.every((r) => !r.seeded),
    true,
  );
});
