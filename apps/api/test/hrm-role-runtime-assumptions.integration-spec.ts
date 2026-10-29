// T3b.1: the assumptions behind runtime roles, checked on real PostgreSQL before any
// feature code depends on them. Not a feature test: it pins facts the plan relied on.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { ProtectedStateRepository } from '../dist/authorization/repositories/protected-state.repository.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import { sqlState } from './setup-postgres.ts';
import {
  core,
  grantViaRole,
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

const authzHash = async () =>
  (
    await migration.query<{ materialized: string }[]>(
      `SELECT encode(materialized_hash,'hex') materialized FROM authz_state WHERE singleton`,
    )
  )[0]?.materialized;

test('existing data satisfies "custom. <=> runtime": every role is code-owned and none starts with custom.', async () => {
  const roles = await migration.query<{ key: string; managed_by: string }[]>(
    `SELECT convert_from(role_key,'UTF8') AS key, managed_by FROM role_definition ORDER BY 1`,
  );
  assert.ok(roles.length > 0);
  for (const role of roles) {
    assert.equal(role.managed_by, 'code', role.key);
    assert.equal(role.key.startsWith('custom.'), false, role.key);
  }
  // The same predicate the future CHECK uses, over today's rows: no violation.
  const [violations] = await migration.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM role_definition
      WHERE (managed_by = 'runtime') <> (substring(role_key FROM 1 FOR 7) = convert_to('custom.','UTF8'))`,
  );
  assert.equal(violations?.n, 0);
  const [rules] = await migration.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM policy_rule WHERE managed_by = 'runtime'`,
  );
  assert.equal(rules?.n, 0);
});

test('authority_level is gone: a runtime role is inserted by the authority login without it', async () => {
  const columns = await migration.query<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='role_definition'`,
  );
  assert.deepEqual(columns.map((c) => c.column_name).sort(), ['label', 'managed_by', 'role_key']);
  await runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','Assumption role')",
      [utf8('custom.assumption')],
    ),
  );
  // Another login cannot create it (the runtime path is the authority login only).
  assert.equal(
    await sqlState(
      pools.sync.query(
        "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','x')",
        [utf8('custom.sync_attempt')],
      ),
    ),
    '42501',
  );
});

test('a runtime role with grants and a holder changes neither the hash nor a same-release sync', async () => {
  const repository = new ProtectedStateRepository();

  const hashOf = () => runner.run('read', (tx) => repository.hash(tx.manager));

  const before = { state: await authzHash(), computed: await hashOf() };
  assert.equal(before.state, before.computed);

  const user = await iamUser();
  await grantViaRole(user.id, ['account.read']);
  // A runtime rule on a code role is refused by protect_product_rows (code rows stay immutable).
  const codeRole = (
    await migration.query<{ key: string }[]>(
      `SELECT convert_from(role_key,'UTF8') AS key FROM role_definition WHERE managed_by='code' LIMIT 1`,
    )
  )[0]?.key;
  assert.ok(codeRole);
  await assert.rejects(
    runner.run('admin', (tx) =>
      tx.manager.query(
        "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
        [randomUUID(), utf8('account.read'), utf8(codeRole), utf8('allAccounts')],
      ),
    ),
  );

  assert.equal(await hashOf(), before.computed, 'runtime role and grants are outside the hash');
  const reconciler = new ProductManifestReconciler(runner, new ProductAuditRepository(), {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  });
  // Same sequence, same content: verifyApplied and the drift check pass with the runtime rows.
  const result = await reconciler.reconcile(release);
  assert.equal(result.changed, false);
  assert.equal(await authzHash(), before.state);
  const [kept] = await migration.query<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM role_definition WHERE managed_by='runtime'`,
  );
  assert.ok((kept?.n ?? 0) >= 2, 'the runtime roles are still there');
});
