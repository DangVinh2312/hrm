// ADR-13 D1: the database pins runtime roles (CHECK on the key prefix) and closes what the
// authority login may write into policy_rule (trigger); sync leaves runtime roles alone.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { ProtectedStateRepository } from '../dist/authorization/repositories/protected-state.repository.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { prepareProductRelease } from '../dist/authorization/services/product-manifest.service.js';
import { productReleaseSource } from '../dist/authorization/product.manifest.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import {
  core,
  iamUser,
  migration,
  pools,
  release,
  runner,
  setupStack,
  teardownStack,
  utf8,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

const ruleSql =
  'INSERT INTO policy_rule(rule_id,permission_key,user_id,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)';

const rule = (
  role: string | null,
  options: { effect?: string; user?: string; managedBy?: string } = {},
) => [
  randomUUID(),
  utf8('account.read'),
  options.user ?? null,
  role === null ? null : utf8(role),
  options.effect ?? 'allow',
  utf8('allAccounts'),
  '{}',
  options.managedBy ?? 'runtime',
];

const fails = async (operation: Promise<unknown>) => {
  try {
    await operation;
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { code: String(code), message: String(message) };
  }
  throw new Error('Expected the operation to be rejected by PostgreSQL');
};

const insertRole = (
  source: { query: (sql: string, p: unknown[]) => Promise<unknown> },
  key: string,
  managedBy: string,
) =>
  source.query('INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,$2,$3)', [
    utf8(key),
    managedBy,
    'Fixture',
  ]);

test('CHECK: a runtime role must start with custom. and only a runtime role may', async () => {
  for (const [key, managedBy] of [
    ['noprefix', 'runtime'],
    ['custom', 'runtime'],
    ['system.x', 'runtime'],
    ['custom.coded', 'code'],
  ] as const) {
    const result = await fails(
      insertRole(managedBy === 'code' ? pools.sync : migration, key, managedBy),
    );
    assert.equal(result.code, '23514', `${key} ${managedBy}`);
    assert.match(result.message, /ck_role_runtime_prefix/);
  }
  await insertRole(migration, 'custom.fine', 'runtime');
  assert.equal(
    (
      await fails(
        migration.query('UPDATE role_definition SET role_key=$1 WHERE role_key=$2', [
          utf8('renamed'),
          utf8('custom.fine'),
        ]),
      )
    ).code,
    '23514',
  );
});

test('the existing rows satisfy the CHECK: it is validated, not NOT VALID', async () => {
  const [constraint] = await migration.query<{ validated: boolean }[]>(
    `SELECT convalidated AS validated FROM pg_constraint WHERE conname='ck_role_runtime_prefix' AND conrelid='role_definition'::regclass`,
  );
  assert.equal(constraint?.validated, true);
});

test('authority may add allow rules of custom. roles and nothing else', async () => {
  const role = 'custom.authority_rules';
  await pools.authority.query(
    'INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,$2,$3)',
    [utf8(role), 'runtime', 'Rules'],
  );
  const user = (await iamUser()).id;
  const allowed = rule(role);
  await pools.authority.query(ruleSql, allowed);

  for (const [name, params] of [
    ['deny', rule(role, { effect: 'deny' })],
    ['rule attached to a user', rule(null, { user })],
    ['code-owned rule', rule(role, { managedBy: 'code' })],
  ] as const) {
    const result = await fails(pools.authority.query(ruleSql, params));
    assert.equal(result.code, '42501', name);
  }
  const update = await fails(
    pools.authority.query("UPDATE policy_rule SET effect='deny' WHERE rule_id=$1", [allowed[0]]),
  );
  assert.equal(update.code, '42501');
  assert.match(update.message, /authority may only write allow rules of runtime roles/);
  await pools.authority.query('DELETE FROM policy_rule WHERE rule_id=$1', [allowed[0]]);
});

test('the authority trigger refuses on its own what protect_product_rows would also refuse', async () => {
  const code = 'plain.trigger_only';
  await insertRole(pools.sync, code, 'code');
  await migration.query('ALTER TABLE policy_rule DISABLE TRIGGER protect_product_rows');
  try {
    const runtime = 'custom.trigger_only';
    await insertRole(migration, runtime, 'runtime');
    for (const params of [rule(code), rule(runtime, { managedBy: 'code' })]) {
      const result = await fails(pools.authority.query(ruleSql, params));
      assert.equal(result.code, '42501');
      assert.match(result.message, /authority may only write allow rules of runtime roles/);
    }
    await migration.query('DELETE FROM role_definition WHERE role_key=$1', [utf8(runtime)]);
  } finally {
    await migration.query('ALTER TABLE policy_rule ENABLE TRIGGER protect_product_rows');
    await pools.sync.query('DELETE FROM role_definition WHERE role_key=$1', [utf8(code)]);
  }
});

test('other logins are not bound by the authority trigger: the owner seeds deny and user rules', async () => {
  const role = 'custom.owner_rules';
  await insertRole(migration, role, 'runtime');
  const user = (await iamUser()).id;
  await migration.query(ruleSql, rule(role, { effect: 'deny' }));
  await migration.query(ruleSql, rule(null, { user }));
  assert.equal(
    (
      await migration.query<{ n: number }[]>(
        `SELECT count(*)::int n FROM policy_rule WHERE managed_by='runtime' AND (effect='deny' OR user_id IS NOT NULL)`,
      )
    )[0]?.n,
    2,
  );
});

test('a runtime role and its rules change neither the protected hash nor a later sync', async () => {
  const repository = new ProtectedStateRepository();

  const hashOf = () => runner.run('read', (tx) => repository.hash(tx.manager));

  const materialized = async () =>
    (
      await migration.query<{ h: string }[]>(
        `SELECT encode(materialized_hash,'hex') h FROM authz_state WHERE singleton`,
      )
    )[0]?.h;

  const before = await hashOf();
  assert.equal(await materialized(), before);

  const role = 'custom.sync_keeps';
  const holder = (await iamUser()).id;
  await runner.run('admin', async (tx) => {
    await tx.manager.query(
      'INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,$2,$3)',
      [utf8(role), 'runtime', 'Kept'],
    );
    await tx.manager.query(ruleSql, rule(role));
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      holder,
      utf8(role),
    ]);
  });
  assert.equal(await hashOf(), before, 'runtime rows are outside the hash');

  const next = prepareProductRelease(
    {
      ...productReleaseSource,
      sequence: String(Number(release.sequence) + 1),
      predecessor: release.sequence,
      roles: [...release.roles, { key: 'added.by.release', label: 'Added' }],
    },
    core,
  );
  const reconciler = new ProductManifestReconciler(runner, new ProductAuditRepository(), {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  });
  assert.equal((await reconciler.reconcile(next)).changed, true);

  const [kept] = await migration.query<{ label: string; rules: number; holders: number }[]>(
    `SELECT d.label, (SELECT count(*)::int FROM policy_rule r WHERE r.role_key=d.role_key AND r.managed_by='runtime') rules,
            (SELECT count(*)::int FROM user_role u WHERE u.role_key=d.role_key AND u.user_id=$2) holders
       FROM role_definition d WHERE d.role_key=$1 AND d.managed_by='runtime'`,
    [utf8(role), holder],
  );
  assert.deepEqual(kept, { label: 'Kept', rules: 1, holders: 1 });
  assert.equal(await hashOf(), await materialized(), 'sync published the hash of the code rows');
  assert.notEqual(await hashOf(), before, 'the added code role is what moved the hash');
});
