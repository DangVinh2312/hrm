// role.create / role.update / role.delete on PostgreSQL: who may write which role, the
// subset rule against the actor's grants, limits, digest, holders, atomic audit and the lock
// order. Service level, no HTTP. Synthetic people only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { prepareProductRelease } from '../dist/authorization/services/product-manifest.service.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import {
  createProductAuthorizationCore,
  productBindings,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { grantsDigest } from '../dist/authorization/helpers/role-grant.helper.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import type { RoleService } from '../dist/modules/role/role.service.js';
import { type ModulePerson, type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

let stack: ModuleStack;

const utf8 = (value: string) => Buffer.from(value, 'utf8');

after(() => stack?.stop());

type Pair = readonly [permission: string, template: string];

const spec = ([permission, template]: Pair) => ({
  permission,
  template: { key: template, version: 1 },
});

const specs = (pairs: readonly Pair[]) => pairs.map(spec);

const READ: Pair = ['role.read', 'role'];
const CREATE: Pair = ['role.create', 'role'];
const UPDATE: Pair = ['role.update', 'role'];
const DELETE: Pair = ['role.delete', 'role'];
const SETTING_READ: Pair = ['setting.read', 'setting'];
const SETTING_PROFILE: Pair = ['setting.readProfile', 'setting'];
const EMPLOYEE_READ: Pair = ['employee.read', 'allEmployees'];

let counter = 0;

const nextKey = (prefix = 'r') => `custom.${prefix}${++counter}`;

/** A runtime role written by the owner login, as a fixture (the code under test is not used). */
async function seedRole(key: string, pairs: readonly Pair[], label = 'Seed') {
  await stack.migration.query(
    "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime',$2)",
    [utf8(key), label],
  );
  for (const [permission, template] of pairs)
    await stack.migration.query(
      "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
      [randomUUID(), utf8(permission), utf8(key), utf8(template)],
    );
}

/** An IAM account holding exactly `pairs` through one runtime role. */
async function actor(pairs: readonly Pair[]): Promise<ModulePerson> {
  const key = nextKey('act');
  await seedRole(key, pairs);
  return stack.person([key]);
}

const writer = (...extra: Pair[]) => actor([CREATE, UPDATE, DELETE, ...extra]);

const roleRow = async (key: string) =>
  (
    await stack.migration.query<{ managed_by: string; label: string }[]>(
      'SELECT managed_by, label FROM role_definition WHERE role_key=$1',
      [utf8(key)],
    )
  )[0];

const rules = (key: string) =>
  stack.migration.query<
    {
      rule_id: string;
      permission: string;
      template: string;
      version: number;
      effect: string;
      managed_by: string;
      user_id: string | null;
    }[]
  >(
    `SELECT rule_id, convert_from(permission_key,'UTF8') AS permission, convert_from(template_key,'UTF8') AS template,
            template_version AS version, effect, managed_by, user_id
       FROM policy_rule WHERE role_key=$1 ORDER BY 2, 3`,
    [utf8(key)],
  );

const events = (kind: string) =>
  stack.migration.query<{ actor_id: string; safe_metadata: Record<string, string> }[]>(
    `SELECT actor_id, safe_metadata FROM audit_outbox WHERE convert_from(event_kind,'UTF8')=$1 ORDER BY occurred_at, event_id`,
    [kind],
  );

const count = async (sql: string, params: unknown[] = []) =>
  Number((await stack.migration.query<{ n: string }[]>(sql, params))[0]?.n);

const runtimeRoles = () =>
  count("SELECT count(*)::text AS n FROM role_definition WHERE managed_by='runtime'");

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

const input = (key: string, pairs: readonly Pair[], label = 'Nhãn') => ({
  key,
  label,
  grants: specs(pairs),
});

/**
 * No row and no event moved, and no revision either.
 */
async function unchanged(run: () => Promise<unknown>, check: (error: unknown) => boolean) {
  const [revision, roles, createEvents] = [
    await stack.revision(),
    await count('SELECT count(*)::text AS n FROM role_definition'),
    await count(
      "SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'permission.role-%'",
    ),
  ];
  await assert.rejects(run(), check);
  assert.equal(await stack.revision(), revision);
  assert.equal(await count('SELECT count(*)::text AS n FROM role_definition'), roles);
  assert.equal(
    await count(
      "SELECT count(*)::text AS n FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'permission.role-%'",
    ),
    createEvents,
  );
}

const denied = (error: unknown) => error instanceof ProductAccessDenied;

const notFound = (error: unknown) => error instanceof NotFoundException;

const invalid = (error: unknown) => error instanceof ProductInvalidRequest;

test('Root creates a runtime role: definition and allow rules are runtime-owned, audited once, revision +1', async () => {
  const key = nextKey();
  const pairs: Pair[] = [READ, SETTING_READ, EMPLOYEE_READ];
  const revision = BigInt(await stack.revision());
  const root = await stack.freshRoot();
  const created = await stack.roles.create(root, input(key, pairs, 'Người đọc'));
  assert.deepEqual(created, { key, digest: grantsDigest('Người đọc', specs(pairs)) });
  assert.deepEqual(await roleRow(key), { managed_by: 'runtime', label: 'Người đọc' });
  const stored = await rules(key);
  assert.deepEqual(
    stored.map((r) => [r.permission, r.template, r.version, r.effect, r.managed_by, r.user_id]),
    [
      ['employee.read', 'allEmployees', 1, 'allow', 'runtime', null],
      ['role.read', 'role', 1, 'allow', 'runtime', null],
      ['setting.read', 'setting', 1, 'allow', 'runtime', null],
    ],
  );
  assert.equal(BigInt(await stack.revision()), revision + 1n);
  const [event] = (await events('permission.role-create')).filter(
    (e) => e.safe_metadata.roleKey === key,
  );
  assert.equal(event?.actor_id, stack.rootId);
  assert.equal(event?.safe_metadata.grantCount, '3');
  assert.equal(event?.safe_metadata.grantsDigest, created.digest);
  assert.equal(event?.safe_metadata.principalKind, 'root');
  // The label is a free text: it never reaches the audit.
  assert.ok(!JSON.stringify(event).includes('Người đọc'));
});

test('Root may put every selectable pair of the catalog except document into one role', async () => {
  const { productReleaseSource: source } =
    await import('../dist/authorization/product.manifest.js');
  const declared = source.declarations;
  const pairs: Pair[] = declared.resources
    .filter((resource) => resource.key !== 'document')
    .flatMap((resource) =>
      Object.keys(resource.actions).flatMap((action) =>
        declared.templates
          .filter((t) => t.resource === resource.key)
          .map((t): Pair => [`${resource.key}.${action}`, t.key]),
      ),
    );
  assert.ok(pairs.length > 100 && pairs.length <= 300, String(pairs.length));
  const key = nextKey('all');
  await stack.roles.create(await stack.freshRoot(), input(key, pairs));
  assert.equal((await rules(key)).length, pairs.length);
});

test('create needs fresh@1 and the role.create grant; a plain session or a roleless account is denied', async () => {
  const key = nextKey();
  const holder = await actor([CREATE]);
  await unchanged(() => stack.roles.create(holder.secret, input(key, [])), denied);
  const plainRoot = await stack.root();
  await unchanged(() => stack.roles.create(plainRoot, input(key, [])), denied);
  const nobody = await stack.person([]);
  await unchanged(() => stack.roles.create(nobody.fresh, input(key, [])), denied);
  const reader = await actor([READ]);
  await unchanged(() => stack.roles.create(reader.fresh, input(key, [])), denied);
  assert.equal(await roleRow(key), undefined);
});

test('an IAM actor creates a role inside its own set; the boundary is optional for create', async () => {
  const holder = await actor([CREATE, READ, SETTING_READ]);
  const key = nextKey();
  await stack.roles.create(holder.fresh, input(key, [READ, SETTING_READ]));
  assert.equal((await rules(key)).length, 2);
  const [event] = (await events('permission.role-create')).filter(
    (e) => e.safe_metadata.roleKey === key,
  );
  assert.equal(event?.actor_id, holder.id);
  assert.equal(event?.safe_metadata.principalKind, undefined);
  // The empty role is inside every set.
  await stack.roles.create(holder.fresh, input(nextKey(), []));
});

test('(c) a grant outside the actor set, another template of a held permission, a deny or a user rule: 403, nothing written', async () => {
  const holder = await actor([CREATE, READ]);
  await unchanged(
    () => stack.roles.create(holder.fresh, input(nextKey(), [['role.read', 'setting']])),
    invalid,
  );
  await unchanged(
    () => stack.roles.create(holder.fresh, input(nextKey(), [READ, SETTING_READ])),
    denied,
  );
  await unchanged(() => stack.roles.create(holder.fresh, input(nextKey(), [SETTING_READ])), denied);
  await unchanged(() => stack.roles.create(holder.fresh, input(nextKey(), [UPDATE])), denied);
  const withDeny = await actor([CREATE, READ]);
  const denyRole = (
    await stack.migration.query<{ role_key: Buffer }[]>(
      'SELECT role_key FROM user_role WHERE user_id=$1',
      [withDeny.id],
    )
  )[0]!.role_key;
  await stack.migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
    [randomUUID(), utf8('setting.read'), denyRole, utf8('setting')],
  );
  await unchanged(() => stack.roles.create(withDeny.fresh, input(nextKey(), [READ])), denied);
  const withUserRule = await actor([CREATE, READ]);
  await stack.migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
    [randomUUID(), utf8('setting.read'), withUserRule.id, utf8('setting')],
  );
  await unchanged(() => stack.roles.create(withUserRule.fresh, input(nextKey(), [READ])), denied);
});

test('property: an actor holding only pair P never creates a role with another pair of the catalog', async () => {
  const declared = productReleaseSource.declarations;
  const all: Pair[] = declared.resources
    .filter((resource) => resource.key !== 'document')
    .flatMap((resource) =>
      Object.keys(resource.actions).flatMap((action) =>
        declared.templates
          .filter((t) => t.resource === resource.key)
          .map((t): Pair => [`${resource.key}.${action}`, t.key]),
      ),
    );
  // A default pair, a pair outside the default grants and one of the new write permissions.
  for (const held of [EMPLOYEE_READ, ['employee.read', 'selfEmployee'], SETTING_READ] as Pair[]) {
    const holder = await actor([CREATE, held]);
    for (const other of all) {
      if (other[0] === held[0] && other[1] === held[1]) continue;
      if (other[0] === CREATE[0] && other[1] === CREATE[1]) continue;
      if (other[0] === 'hrCompany.approvals') continue;
      assert.equal(
        await stack.roles.create(holder.fresh, input(nextKey('p'), [other])).then(
          () => 'created',
          (error: unknown) => (denied(error) ? 'denied' : 'other'),
        ),
        'denied',
        `${held.join(' ')} -> ${other.join(' ')}`,
      );
    }
    await stack.roles.create(holder.fresh, input(nextKey('p'), [held]));
  }
});

test('input is re-checked inside the command: a key without custom., a document grant, >300 grants, approvals alone', async () => {
  const root = await stack.freshRoot();
  await unchanged(() => stack.roles.create(root, input('hr.admin', [READ])), invalid);
  await unchanged(() => stack.roles.create(root, input('custom.', [READ])), invalid);
  await unchanged(
    () => stack.roles.create(root, input(nextKey(), [['document.read', 'ownedDocuments']])),
    invalid,
  );
  await unchanged(
    () => stack.roles.create(root, input(nextKey(), [['hrCompany.approvals', 'company']])),
    invalid,
  );
  await unchanged(
    () => stack.roles.create(root, input(nextKey(), [['nope.read', 'role']])),
    invalid,
  );
  await unchanged(
    () =>
      stack.roles.create(root, {
        key: nextKey(),
        label: 'x',
        grants: Array.from({ length: 301 }, (_, i) => spec([`p.a${i}`, 't'])),
      }),
    invalid,
  );
});

test('the command checks the catalog, the key and the label again when the service is bypassed', async () => {
  const { roleCommand } = stack.modules.repositories;
  const root = await stack.freshRoot();

  const direct = (grants: ReturnType<typeof specs>, key = nextKey(), label = 'Nhãn') =>
    stack.authorization.execute(root, roleCommand.create, { key, label, grants });

  await unchanged(() => direct(specs([['document.read', 'ownedDocuments']])), invalid);
  await unchanged(() => direct(specs([['hrCompany.approvals', 'company']])), invalid);
  await unchanged(() => direct(specs([['role.read', 'setting']])), invalid);
  await unchanged(() => direct(specs([READ]), 'hr.admin'), invalid);
  await unchanged(() => direct(specs([READ]), nextKey(), '  padded  '), invalid);
  await unchanged(() => direct(specs([READ]), nextKey(), ''), invalid);
});

test('a taken key is a 409 and changes nothing', async () => {
  const key = nextKey();
  const root = await stack.freshRoot();
  await stack.roles.create(root, input(key, [READ], 'Một'));
  await unchanged(
    () => stack.roles.create(root, input(key, [SETTING_READ], 'Hai')),
    rejected('role_exists'),
  );
  assert.equal((await roleRow(key))?.label, 'Một');
  assert.equal((await rules(key)).length, 1);
});

test('at most 100 runtime roles: the 100th is created, the 101st is 409, a delete frees a slot', async () => {
  const root = await stack.freshRoot();
  const current = await runtimeRoles();
  for (let i = current; i < 99; i++) await seedRole(nextKey('fill'), []);
  assert.equal(await runtimeRoles(), 99);
  const hundredth = nextKey('last');
  await stack.roles.create(root, input(hundredth, [READ]));
  assert.equal(await runtimeRoles(), 100);
  await unchanged(() => stack.roles.create(root, input(nextKey(), [READ])), rejected('role_limit'));
  await stack.roles.remove(root, hundredth);
  assert.equal(await runtimeRoles(), 99);
});

test('two creates racing for the last slot: exactly one wins, the count never exceeds 100', async () => {
  const root = await stack.freshRoot();
  assert.equal(await runtimeRoles(), 99);
  const results = await Promise.allSettled([
    stack.roles.create(root, input(nextKey('race'), [READ])),
    stack.roles.create(root, input(nextKey('race'), [SETTING_READ])),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const loser = results.find((r) => r.status === 'rejected');
  assert.ok(loser?.status === 'rejected' && rejected('role_limit')(loser.reason));
  assert.equal(await runtimeRoles(), 100);
  const keys = await stack.migration.query<{ k: string }[]>(
    "SELECT convert_from(role_key,'UTF8') AS k FROM role_definition WHERE convert_from(role_key,'UTF8') LIKE 'custom.race%'",
  );
  assert.equal(keys.length, 1);
  // Free the slots for the tests below.
  await stack.migration.query(
    "DELETE FROM policy_rule WHERE role_key IN (SELECT role_key FROM role_definition WHERE managed_by='runtime' AND label='Seed' AND convert_from(role_key,'UTF8') LIKE 'custom.fill%')",
  );
  await stack.migration.query(
    "DELETE FROM role_definition WHERE managed_by='runtime' AND convert_from(role_key,'UTF8') LIKE 'custom.fill%'",
  );
  await stack.roles.remove(root, (keys[0] as { k: string }).k);
});

test('update replaces label and grants as a diff: unchanged rules keep their rule_id, removed ones go, new ones come', async () => {
  const key = nextKey();
  const root = await stack.freshRoot();
  const first = await stack.roles.create(root, input(key, [READ, SETTING_READ], 'Cũ'));
  const before = await rules(key);
  const keptId = before.find((r) => r.permission === 'role.read')?.rule_id;
  const revision = BigInt(await stack.revision());
  const next = await stack.roles.update(root, {
    ...input(key, [READ, EMPLOYEE_READ], 'Mới'),
    expectedDigest: first.digest,
  });
  assert.deepEqual(next, { key, digest: grantsDigest('Mới', specs([READ, EMPLOYEE_READ])) });
  assert.equal((await roleRow(key))?.label, 'Mới');
  const after = await rules(key);
  assert.deepEqual(
    after.map((r) => r.permission),
    ['employee.read', 'role.read'],
  );
  assert.equal(after.find((r) => r.permission === 'role.read')?.rule_id, keptId);
  assert.ok(!before.some((r) => r.permission === 'employee.read'));
  assert.equal(BigInt(await stack.revision()), revision + 1n);
  const [event] = (await events('permission.role-update')).filter(
    (e) => e.safe_metadata.roleKey === key,
  );
  assert.equal(event?.safe_metadata.grantCount, '2');
  assert.equal(event?.safe_metadata.grantsDigest, next.digest);
  // Only the label may change; the grants stay: still a success.
  const labelOnly = await stack.roles.update(root, {
    ...input(key, [READ, EMPLOYEE_READ], 'Nhãn khác'),
    expectedDigest: next.digest,
  });
  assert.deepEqual(
    (await rules(key)).map((r) => r.rule_id),
    after.map((r) => r.rule_id),
  );
  assert.equal(labelOnly.digest, grantsDigest('Nhãn khác', specs([READ, EMPLOYEE_READ])));
});

test('update with a stale digest is 409 and changes nothing; the label counts in the digest', async () => {
  const key = nextKey();
  const root = await stack.freshRoot();
  const created = await stack.roles.create(root, input(key, [READ], 'A'));
  await unchanged(
    () =>
      stack.roles.update(root, {
        ...input(key, [SETTING_READ], 'B'),
        expectedDigest: '0'.repeat(64),
      }),
    rejected('stale_digest'),
  );
  // The same grants under another label is another digest.
  await unchanged(
    () =>
      stack.roles.update(root, {
        ...input(key, [READ], 'B'),
        expectedDigest: grantsDigest('B', specs([READ])),
      }),
    rejected('stale_digest'),
  );
  assert.equal((await roleRow(key))?.label, 'A');
  await stack.roles.update(root, {
    ...input(key, [SETTING_READ], 'B'),
    expectedDigest: created.digest,
  });
});

test('two updates with the same digest: one wins, the other is 409; the winner is what is stored', async () => {
  const key = nextKey();
  const root = await stack.freshRoot();
  const created = await stack.roles.create(root, input(key, [READ], 'A'));
  const results = await Promise.allSettled([
    stack.roles.update(root, {
      ...input(key, [SETTING_READ], 'Một'),
      expectedDigest: created.digest,
    }),
    stack.roles.update(root, {
      ...input(key, [EMPLOYEE_READ], 'Hai'),
      expectedDigest: created.digest,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const loser = results.find((r) => r.status === 'rejected');
  assert.ok(loser?.status === 'rejected' && rejected('stale_digest')(loser.reason));
  const winner = results.find((r) => r.status === 'fulfilled');
  assert.ok(winner?.status === 'fulfilled');
  const stored = await rules(key);
  assert.equal(
    grantsDigest(
      (await roleRow(key))!.label,
      stored.map((r) => ({
        permission: r.permission,
        template: { key: r.template, version: r.version },
      })),
    ),
    (winner.value as { digest: string }).digest,
  );
});

test('an update reaches a holder at its very next request (no cached grants)', async () => {
  const key = nextKey();
  const root = await stack.freshRoot();
  const created = await stack.roles.create(root, input(key, [SETTING_PROFILE], 'Holder'));
  const holder = await stack.person([key]);
  assert.equal(await stack.settings.list(holder.secret), undefined);
  const updated = await stack.roles.update(root, {
    ...input(key, [SETTING_PROFILE, SETTING_READ], 'Holder'),
    expectedDigest: created.digest,
  });
  assert.ok(await stack.settings.list(holder.secret));
  await stack.roles.update(root, {
    ...input(key, [SETTING_PROFILE], 'Holder'),
    expectedDigest: updated.digest,
  });
  assert.equal(await stack.settings.list(holder.secret), undefined);
});

test('update and delete of an absent role, or of a role that is not runtime, are the same 404', async () => {
  const root = await stack.freshRoot();
  for (const key of [nextKey('gone'), 'hr.admin', 'reviewer', 'custom.', '']) {
    await unchanged(
      () => stack.roles.update(root, { ...input(key, [READ]), expectedDigest: '0'.repeat(64) }),
      notFound,
    );
    await unchanged(() => stack.roles.remove(root, key), notFound);
  }
  // The release roles keep their rules.
  assert.ok((await rules('hr.admin')).length > 0);
});

test('delete removes the definition and every rule, audits the count, and is refused while a role is held', async () => {
  const root = await stack.freshRoot();
  const key = nextKey();
  const created = await stack.roles.create(root, input(key, [READ, SETTING_READ]));
  assert.deepEqual(await stack.roles.remove(root, key), { status: 'deleted' });
  assert.equal(await roleRow(key), undefined);
  assert.equal((await rules(key)).length, 0);
  const [event] = (await events('permission.role-delete')).filter(
    (e) => e.safe_metadata.roleKey === key,
  );
  assert.equal(event?.safe_metadata.grantCount, '2');
  assert.equal(event?.safe_metadata.grantsDigest, created.digest);
});

test('delete is 409 while any account holds the role, whatever the account state', async () => {
  const root = await stack.freshRoot();
  for (const state of ['active', 'pending', 'suspended'] as const) {
    const key = nextKey('held');
    await stack.roles.create(root, input(key, [READ]));
    const holder = await stack.person([key]);
    if (state !== 'active')
      await stack.migration.query('UPDATE app_user SET state=$2 WHERE id=$1', [holder.id, state]);
    await unchanged(() => stack.roles.remove(root, key), rejected('role_held'));
    assert.ok(await roleRow(key), state);
    await stack.migration.query('DELETE FROM user_role WHERE user_id=$1', [holder.id]);
    assert.deepEqual(await stack.roles.remove(root, key), { status: 'deleted' });
  }
});

test('delete is 409 while a record exception still names the role', async () => {
  const root = await stack.freshRoot();
  const key = nextKey('exc');
  await stack.roles.create(root, input(key, [READ]));
  const [anchor] = await stack.migration.query<{ object_id: string }[]>(
    'SELECT object_id FROM role_anchor',
  );
  const exceptionId = randomUUID();
  await stack.migration.query(
    `INSERT INTO record_exception(exception_id,object_id,type_key,permission_key,role_key,effect,purpose,starts_at,reason,issued_by)
     VALUES($1,$2,$3,$4,$5,'allow','manual',statement_timestamp(),'fixture',$6)`,
    [exceptionId, anchor!.object_id, utf8('role'), utf8('role.read'), utf8(key), stack.rootId],
  );
  await unchanged(() => stack.roles.remove(root, key), rejected('role_referenced'));
  await stack.migration.query('DELETE FROM record_exception WHERE exception_id=$1', [exceptionId]);
  await stack.roles.remove(root, key);
});

test('update racing delete: one outcome only, never an orphan rule', async () => {
  const root = await stack.freshRoot();
  const key = nextKey('dup');
  const created = await stack.roles.create(root, input(key, [READ]));
  const [updated, removed] = await Promise.allSettled([
    stack.roles.update(root, { ...input(key, [SETTING_READ]), expectedDigest: created.digest }),
    stack.roles.remove(root, key),
  ]);
  assert.equal(removed.status, 'fulfilled');
  if (updated.status === 'rejected') assert.ok(notFound(updated.reason));
  assert.equal(await roleRow(key), undefined);
  assert.equal((await rules(key)).length, 0);
  assert.equal(
    await count(
      'SELECT count(*)::text AS n FROM policy_rule p WHERE p.role_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM role_definition d WHERE d.role_key=p.role_key)',
    ),
    0,
  );
});

test('an actor reaches only roles inside its own set: a larger role is 404 for update and delete', async () => {
  const root = await stack.freshRoot();
  const big = nextKey('big');
  const bigDigest = (await stack.roles.create(root, input(big, [READ, SETTING_READ]))).digest;
  const small = nextKey('small');
  const smallDigest = (await stack.roles.create(root, input(small, [READ]))).digest;
  const holder = await bounded.actor([CREATE, UPDATE, DELETE, READ]);
  await unchanged(
    () => bounded.roles.update(holder.fresh, { ...input(big, [READ]), expectedDigest: bigDigest }),
    notFound,
  );
  await unchanged(() => bounded.roles.remove(holder.fresh, big), notFound);
  // Inside the set: allowed, and the new grants must be inside it too.
  await unchanged(
    () =>
      bounded.roles.update(holder.fresh, {
        ...input(small, [READ, SETTING_READ]),
        expectedDigest: smallDigest,
      }),
    denied,
  );
  const moved = await bounded.roles.update(holder.fresh, {
    ...input(small, [READ], 'Nhỏ'),
    expectedDigest: smallDigest,
  });
  assert.equal(moved.key, small);
  await bounded.roles.remove(holder.fresh, small);
  assert.equal(await roleRow(small), undefined);
});

test('a role with a deny or a parameterised rule cannot be proven inside the actor set: 404 for an IAM actor', async () => {
  const root = await stack.freshRoot();
  const key = nextKey('odd');
  const created = await stack.roles.create(root, input(key, [READ]));
  await stack.migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'deny',$4,1,'{}','runtime')",
    [randomUUID(), utf8('setting.read'), utf8(key), utf8('setting')],
  );
  const holder = await bounded.actor([CREATE, UPDATE, DELETE, READ, SETTING_READ]);
  await unchanged(
    () =>
      bounded.roles.update(holder.fresh, { ...input(key, [READ]), expectedDigest: created.digest }),
    notFound,
  );
  await unchanged(() => bounded.roles.remove(holder.fresh, key), notFound);
  // Root does not delete a deny rule behind the UI's back either.
  await unchanged(
    () => stack.roles.update(root, { ...input(key, [READ]), expectedDigest: created.digest }),
    rejected('unsupported_rule'),
  );
});

test('boundary: update and delete are required (no binding, no access), create is optional', async () => {
  const root = await stack.freshRoot();
  const key = nextKey('bnd');
  const created = await stack.roles.create(root, input(key, [READ]));
  const unbound = await writer(READ);
  await unchanged(
    () =>
      stack.roles.update(unbound.fresh, { ...input(key, [READ]), expectedDigest: created.digest }),
    denied,
  );
  await unchanged(() => stack.roles.remove(unbound.fresh, key), denied);
  await stack.roles.create(unbound.fresh, input(nextKey('bnd'), [READ]));
  // Bound by the real accountAdministration@1.
  const bound = await bounded.actor([UPDATE, DELETE, READ]);
  await bounded.roles.update(bound.fresh, {
    ...input(key, [READ], 'Gắn'),
    expectedDigest: created.digest,
  });
  await unchanged(
    () =>
      bounded.roles.update(bound.secret, { ...input(key, [READ]), expectedDigest: '0'.repeat(64) }),
    denied,
  );
  await bounded.roles.remove(bound.fresh, key);
});

test('every role write needs fresh@1, for an IAM actor and for Root', async () => {
  const key = nextKey('frs');
  const created = await stack.roles.create(await stack.freshRoot(), input(key, [READ]));
  const holder = await bounded.actor([CREATE, UPDATE, DELETE, READ]);
  await unchanged(() => bounded.roles.create(holder.secret, input(nextKey(), [READ])), denied);
  await unchanged(
    () =>
      bounded.roles.update(holder.secret, {
        ...input(key, [READ]),
        expectedDigest: created.digest,
      }),
    denied,
  );
  await unchanged(() => bounded.roles.remove(holder.secret, key), denied);
  const plainRoot = await stack.root();
  await unchanged(
    () => stack.roles.update(plainRoot, { ...input(key, [READ]), expectedDigest: created.digest }),
    denied,
  );
  await unchanged(() => stack.roles.remove(plainRoot, key), denied);
});

test('the release gives no default grant to any role write: hr.admin cannot create, update or delete', async () => {
  const admin = await stack.person(['hr.employee', 'hr.admin']);
  await unchanged(() => stack.roles.create(admin.fresh, input(nextKey(), [])), denied);
  await unchanged(() => stack.roles.remove(admin.fresh, nextKey()), denied);
  const granted = await stack.migration.query<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM policy_rule WHERE convert_from(permission_key,'UTF8') IN ('role.create','role.update','role.delete') AND managed_by='code'`,
  );
  assert.equal(granted[0]?.n, '0');
});

test('a failing audit rolls the whole command back, for each command', async () => {
  class FailingAudit extends ProductAuditRepository {
    override appendProductAudit(): Promise<void> {
      return Promise.reject(new Error('audit down'));
    }
  }
  const failing = authorizationWith(new FailingAudit()).roles;
  const key = nextKey('aud');
  const root = await stack.freshRoot();
  const created = await stack.roles.create(root, input(key, [READ]));

  const fault = (error: unknown) => error instanceof Error && error.message === 'audit down';

  await unchanged(() => failing.create(root, input(nextKey('aud'), [READ])), fault);
  await unchanged(
    () =>
      failing.update(root, {
        ...input(key, [SETTING_READ], 'Đổi'),
        expectedDigest: created.digest,
      }),
    fault,
  );
  await unchanged(() => failing.remove(root, key), fault);
  assert.equal((await roleRow(key))?.label, 'Nhãn');
  assert.deepEqual(
    (await rules(key)).map((r) => r.permission),
    ['role.read'],
  );
});

// ---------------------------------------------------------------------------------------------
// A second authorization over the same database, with the audit given by the test. Actors of
// role.update / role.delete are bound to the real `accountAdministration@1` package.
// ---------------------------------------------------------------------------------------------
interface BoundedRoles {
  readonly roles: RoleService;

  actor(pairs: readonly Pair[]): Promise<ModulePerson>;
}

function authorizationWith(audit = new ProductAuditRepository()) {
  const core = createProductAuthorizationCore();
  const release = prepareProductRelease(productReleaseSource, core);
  const authorization = new ProductAuthorization(
    stack.runner,
    audit,
    new ProductBindingRegistry(core, release.declarations, productBindings),
    {
      validators: { 'fresh@1': (_params, i) => i.context.freshAuthentication === true },
      obligations: createProductObligations(audit),
    },
    [],
    stack.modules.commands,
    stack.modules.queries,
  );
  return stack.modules.bindServices(authorization);
}

let bounded: BoundedRoles;

before(async () => {
  stack = await startModuleStack();
  const services = authorizationWith();
  bounded = {
    roles: services.roles,
    actor: async (pairs) => {
      const person = await actor(pairs);
      for (const permission of ['role.update', 'role.delete'])
        if (pairs.some(([p]) => p === permission))
          await stack.migration.query(
            'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)',
            [person.id, utf8(permission), utf8('accountAdministration')],
          );
      return person;
    },
  };
});

test('the digest role.read returns is accepted by the next update', async () => {
  const key = nextKey();
  const root = await stack.freshRoot();
  await stack.roles.create(root, input(key, [READ, SETTING_READ], 'Vòng'));
  const view = await stack.roles.list(root);
  const read = view?.roles.find((role) => role.key === key);
  assert.ok(read);
  const next = await stack.roles.update(root, {
    ...input(key, [READ, EMPLOYEE_READ], 'Vòng 2'),
    expectedDigest: read.digest,
  });
  assert.equal(next.digest, grantsDigest('Vòng 2', specs([READ, EMPLOYEE_READ])));
});
