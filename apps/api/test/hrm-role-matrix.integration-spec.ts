// Read-only role matrix (ADR 0041 §3, ADR 0046): role.read and account.readPermissions on real
// PostgreSQL, service level. Nothing here creates, edits or assigns a role through the product;
// fixtures insert runtime rows directly, as the future write path will.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

let stack: ModuleStack;

before(async () => {
  stack = await startModuleStack();
});
after(async () => {
  await stack?.stop();
});

const utf8 = (value: string) => Buffer.from(value, 'utf8');

/** A runtime role with rules and optional holders, written the way the write path will. */
async function runtimeRole(
  key: string,
  grants: readonly { permission: string; template: string; effect?: string }[],
  holders: readonly string[] = [],
) {
  await stack.runner.run('admin', async (tx) => {
    await tx.manager.query(
      "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime',$2)",
      [utf8(key), `Label ${key}`],
    );
    for (const g of grants)
      await tx.manager.query(
        "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,$4,$5,1,'{}','runtime')",
        [randomUUID(), utf8(g.permission), utf8(key), g.effect ?? 'allow', utf8(g.template)],
      );
    for (const user of holders)
      await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
        user,
        utf8(key),
      ]);
  });
}

const grantRule = (userId: string, permission: string, template: string) =>
  stack.runner.run('admin', (tx) =>
    tx.manager.query(
      "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
      [randomUUID(), utf8(permission), userId, utf8(template)],
    ),
  );

const auditKinds = async () =>
  (
    await stack.migration.query<{ kind: string; meta: Record<string, unknown> }[]>(
      "SELECT convert_from(event_kind,'UTF8') AS kind, safe_metadata AS meta FROM audit_outbox ORDER BY occurred_at",
    )
  ).map((row) => row);

test('role.read: the release admin sees every role with its grants, holders and source; others get 404', async () => {
  const admin = await stack.person(['hr.admin']);
  const second = await stack.person(['hr.admin']);
  await runtimeRole(
    'custom.reviewer_plus',
    [{ permission: 'workRequest.read', template: 'ownRequests' }],
    [second.id],
  );
  const view = await stack.roles.list(admin.secret);
  assert.ok(view);
  const byKey = new Map(view.roles.map((role) => [role.key, role]));
  assert.deepEqual([...byKey.keys()].sort(), [
    'custom.reviewer_plus',
    'hr.admin',
    'hr.coo',
    'hr.employee',
    'reviewer',
  ]);
  // Code roles first, then runtime; labels from the release.
  assert.deepEqual(
    view.roles.map((role) => role.source),
    ['code', 'code', 'code', 'code', 'runtime'],
  );
  const adminRole = byKey.get('hr.admin');
  assert.equal(adminRole?.label, 'Admin');
  assert.equal(adminRole?.holders, 2);
  assert.ok(
    adminRole?.grants.some(
      (g) =>
        g.permission === 'role.read' &&
        g.template === 'role' &&
        g.version === 1 &&
        g.effect === 'allow' &&
        Object.keys(g.parameters).length === 0,
    ),
    'role.read is a default grant of the administrative role',
  );
  const custom = byKey.get('custom.reviewer_plus');
  assert.deepEqual(custom, {
    key: 'custom.reviewer_plus',
    label: 'Label custom.reviewer_plus',
    source: 'runtime',
    holders: 1,
    grants: [
      {
        permission: 'workRequest.read',
        effect: 'allow',
        template: 'ownRequests',
        version: 1,
        parameters: {},
      },
    ],
  });
  // Allowlisted fields only: no account id, email, internal id or revision anywhere.
  for (const role of view.roles) {
    assert.deepEqual(Object.keys(role).sort(), ['grants', 'holders', 'key', 'label', 'source']);
    for (const grant of role.grants)
      assert.deepEqual(Object.keys(grant).sort(), [
        'effect',
        'parameters',
        'permission',
        'template',
        'version',
      ]);
  }
  assert.doesNotMatch(JSON.stringify(view), new RegExp(admin.id));

  // No default grant for the COO or the employee: the same answer as for a page that is not there.
  const coo = await stack.person(['hr.coo']);
  const employee = await stack.person(['hr.employee']);
  const roleless = await stack.person([]);
  for (const person of [coo, employee, roleless])
    assert.equal(await stack.roles.list(person.secret), undefined);
});

test('role.read follows grants: a runtime holder sees it, revocation is seen by the next call', async () => {
  const person = await stack.person([]);
  assert.equal(await stack.roles.list(person.secret), undefined);
  await runtimeRole(
    'custom.matrix_reader',
    [{ permission: 'role.read', template: 'role' }],
    [person.id],
  );
  assert.ok(await stack.roles.list(person.secret));
  await stack.runner.run('admin', (tx) =>
    tx.manager.query('DELETE FROM user_role WHERE user_id=$1', [person.id]),
  );
  assert.equal(await stack.roles.list(person.secret), undefined);
});

test('role.read: Root reads and leaves one Root access event', async () => {
  const before = (await auditKinds()).length;
  const view = await stack.roles.list(await stack.root());
  assert.ok(view && view.roles.length >= 4);
  const added = (await auditKinds()).slice(before);
  assert.deepEqual(
    added.map((event) => [event.kind, event.meta.principalKind, event.meta.outcome]),
    [['access.role.read', 'root', 'ok']],
  );
});

test('account.readPermissions: roles and rules of an IAM account; Root, absent and unreachable are 404', async () => {
  const reader = await stack.person([]);
  await runtimeRole(
    'custom.perm_reader',
    [{ permission: 'account.readPermissions', template: 'allAccounts' }],
    [reader.id],
  );
  const target = await stack.person(['hr.employee']);
  await runtimeRole(
    'custom.target_role',
    [{ permission: 'role.read', template: 'role' }],
    [target.id],
  );
  await grantRule(target.id, 'account.read', 'allAccounts');

  const view = await stack.roles.accountPermissions(reader.secret, target.id);
  assert.ok(view);
  assert.deepEqual(view.roles, [
    { key: 'custom.target_role', label: 'Label custom.target_role', source: 'runtime' },
    { key: 'hr.employee', label: 'Employee', source: 'code' },
  ]);
  assert.ok(
    view.grants.some(
      (g) => g.permission === 'role.read' && g.source === 'role' && g.effect === 'allow',
    ),
  );
  assert.ok(
    view.grants.some((g) => g.permission === 'account.read' && g.source === 'user'),
    'a rule attached straight to the account is shown as such',
  );
  assert.ok(view.grants.every((g) => !('email' in g) && !('userId' in g)));
  assert.doesNotMatch(JSON.stringify(view), new RegExp(target.id));

  // Root and an absent id are the same "not found", for IAM and for Root alike.
  assert.equal(await stack.roles.accountPermissions(reader.secret, stack.rootId), undefined);
  assert.equal(await stack.roles.accountPermissions(reader.secret, randomUUID()), undefined);
  const rootSecret = await stack.root();
  assert.equal(await stack.roles.accountPermissions(rootSecret, stack.rootId), undefined);
  assert.ok(await stack.roles.accountPermissions(rootSecret, target.id));
  // Without the permission: nothing is reachable.
  const nobody = await stack.person(['hr.admin']);
  assert.equal(await stack.roles.accountPermissions(nobody.secret, target.id), undefined);
  // A malformed id is refused before any lookup.
  await assert.rejects(
    stack.roles.accountPermissions(reader.secret, 'not-an-id'),
    ProductInvalidRequest,
  );
});

test('account.readPermissions is audited for IAM and Root, with the target only for Root', async () => {
  const reader = await stack.person([]);
  await runtimeRole(
    'custom.audited_reader',
    [{ permission: 'account.readPermissions', template: 'allAccounts' }],
    [reader.id],
  );
  const target = await stack.person([]);
  const before = (await auditKinds()).length;
  assert.ok(await stack.roles.accountPermissions(reader.secret, target.id));
  const viaIam = (await auditKinds()).slice(before);
  assert.deepEqual(
    viaIam.map((event) => event.kind),
    ['access.readPermissions'],
  );
  const mid = (await auditKinds()).length;
  assert.ok(await stack.roles.accountPermissions(await stack.root(), target.id));
  const viaRoot = (await auditKinds()).slice(mid);
  assert.deepEqual(
    viaRoot.map((event) => [
      event.kind,
      event.meta.principalKind,
      event.meta.resource,
      event.meta.key,
    ]),
    [['access.account.readPermissions', 'root', 'account', target.id]],
  );
});
