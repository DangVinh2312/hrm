// `truncated` of role.read and account.readPermissions on real PostgreSQL, service
// level. Rows are bulk-inserted straight into the tables, as data written outside the write path
// (the only way to exceed the limits the write path enforces).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { EntityManager } from 'typeorm';
import { type ModuleStack, startModuleStack } from './hrm-stack.helper.ts';

let stack: ModuleStack;

before(async () => {
  stack = await startModuleStack();
});
after(async () => {
  await stack?.stop();
});

const MAX_ROLES = 200;
const MAX_GRANTS_PER_ROLE = 500;
const MAX_ACCOUNT_ROLES = 200;
const MAX_ACCOUNT_GRANTS = 5000;

const roleCount = async () =>
  (
    await stack.migration.query<{ n: number }[]>('SELECT count(*)::int AS n FROM role_definition')
  )[0]?.n ?? 0;

/** Adds `count` runtime roles named `custom.<prefix>_<i>`. */
const bulkRoles = (prefix: string, count: number) =>
  stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `INSERT INTO role_definition(role_key,managed_by,label)
       SELECT convert_to('custom.${prefix}_' || lpad(i::text, 4, '0'),'UTF8'),'runtime','L' FROM generate_series(1,$1) i`,
      [count],
    ),
  );

/** Adds `count` allow rules of distinct permissions to one role. */
const bulkRules = (role: string, count: number) =>
  stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       SELECT gen_random_uuid(), convert_to('workRequest.read','UTF8'), convert_to($1,'UTF8'),'allow',convert_to('ownRequests','UTF8'),1,jsonb_build_object('n', i),'runtime'
         FROM generate_series(1,$2) i`,
      [role, count],
    ),
  );

const reader = async () => {
  const person = await stack.person([]);
  await stack.runner.run('admin', async (tx) => {
    const key = Buffer.from(`custom.reader_${person.id}`, 'utf8');
    await tx.manager.query(
      "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime','R')",
      [key],
    );
    for (const permission of ['role.read', 'account.readPermissions'])
      await tx.manager.query(
        "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
        [
          randomUUID(),
          Buffer.from(permission, 'utf8'),
          key,
          Buffer.from(permission === 'role.read' ? 'role' : 'allAccounts', 'utf8'),
        ],
      );
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      person.id,
      key,
    ]);
  });
  return person;
};

test('role.read: truncated is false below and at the role limit, true one above, and the cut keeps the first rows', async () => {
  const person = await reader();
  const before = await stack.roles.list(person.secret);
  assert.ok(before);
  assert.equal(before.truncated, false);
  assert.equal((await stack.roles.list(await stack.root()))?.truncated, false);

  await bulkRoles('fill', MAX_ROLES - (await roleCount()));
  const exact = await stack.roles.list(person.secret);
  assert.equal(exact?.roles.length, MAX_ROLES);
  assert.equal(exact?.truncated, false);

  await bulkRoles('zz', 1);
  const over = await stack.roles.list(person.secret);
  assert.equal(over?.roles.length, MAX_ROLES);
  assert.equal(over?.truncated, true);
  assert.deepEqual(
    over?.roles.slice(0, 4).map((role) => role.source),
    ['code', 'code', 'code', 'code'],
  );
  assert.ok(over?.roles.every((role) => role.key !== 'custom.zz_0001'));
  // A caller without the grant still reaches nothing, not even the flag.
  assert.equal(await stack.roles.list((await stack.person([])).secret), undefined);
  // Later tests start from the same table: drop the filler roles.
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      "DELETE FROM role_definition WHERE convert_from(role_key,'UTF8') ~ '^custom[.](fill|zz)_'",
    ),
  );
});

test('role.read: one role with more rules than the per-role limit sets truncated', async () => {
  const person = await reader();
  await bulkRoles('big', 1);
  await bulkRules('custom.big_0001', MAX_GRANTS_PER_ROLE);
  const exact = await stack.roles.list(person.secret);
  const big = exact?.roles.find((role) => role.key === 'custom.big_0001');
  assert.equal(big?.grants.length, MAX_GRANTS_PER_ROLE);
  assert.equal(exact?.truncated, false);
  await stack.runner.run('admin', (tx) =>
    tx.manager.query(
      `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       VALUES(gen_random_uuid(), convert_to('workRequest.read','UTF8'), convert_to('custom.big_0001','UTF8'),'allow',convert_to('ownRequests','UTF8'),1,'{"n": -1}','runtime')`,
    ),
  );
  const over = await stack.roles.list(person.secret);
  assert.equal(
    over?.roles.find((role) => role.key === 'custom.big_0001')?.grants.length,
    MAX_GRANTS_PER_ROLE,
  );
  assert.equal(over?.truncated, true);
});

test('account.readPermissions: truncated for roles over the limit, exact limit is false, none is false', async () => {
  const person = await reader();
  const target = await stack.person([]);
  const empty = await stack.roles.accountPermissions(person.secret, target.id);
  assert.deepEqual(empty, { roles: [], grants: [], truncated: false });

  const held = MAX_ACCOUNT_ROLES;
  await bulkRoles('held', held + 1);

  const hold = (count: number) =>
    stack.runner.run('admin', (tx) =>
      tx.manager.query(
        `INSERT INTO user_role(user_id,role_key)
         SELECT $1, convert_to('custom.held_' || lpad(i::text, 4, '0'),'UTF8') FROM generate_series(1,$2) i
         ON CONFLICT DO NOTHING`,
        [target.id, count],
      ),
    );

  await hold(held);
  const exact = await stack.roles.accountPermissions(person.secret, target.id);
  assert.equal(exact?.roles.length, held);
  assert.equal(exact?.truncated, false);
  await hold(held + 1);
  const over = await stack.roles.accountPermissions(person.secret, target.id);
  assert.equal(over?.roles.length, held);
  assert.equal(over?.truncated, true);
  // Unreachable targets stay "not found" and carry no flag.
  assert.equal(await stack.roles.accountPermissions(person.secret, randomUUID()), undefined);
  assert.equal(await stack.roles.accountPermissions(person.secret, stack.rootId), undefined);
});

test('account.readPermissions: truncated for rules over the limit, none outside the target leaks', async () => {
  const person = await reader();
  const target = await stack.person([]);
  const other = await stack.person([]);
  await bulkRoles('rules', 1);
  await bulkRules('custom.rules_0001', MAX_ACCOUNT_GRANTS);

  const give = (account: string) =>
    stack.runner.run('admin', (tx) =>
      tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
        account,
        Buffer.from('custom.rules_0001', 'utf8'),
      ]),
    );

  await give(target.id);
  const exact = await stack.roles.accountPermissions(person.secret, target.id);
  assert.equal(exact?.grants.length, MAX_ACCOUNT_GRANTS);
  assert.equal(exact?.truncated, false);
  // Rules of another account never count toward (or into) the target's answer.
  await give(other.id);
  assert.equal((await stack.roles.accountPermissions(person.secret, target.id))?.truncated, false);
  await stack.migration.query(
    `INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by)
       VALUES(gen_random_uuid(), convert_to('workRequest.read','UTF8'), $1,'allow',convert_to('ownRequests','UTF8'),1,'{"n": -1}','runtime')`,
    [target.id],
  );
  const over = await stack.roles.accountPermissions(person.secret, target.id);
  assert.equal(over?.grants.length, MAX_ACCOUNT_GRANTS);
  assert.equal(over?.truncated, true);
});

test('account.readPermissions reads roles and rules in one statement', async () => {
  const person = await reader();
  const target = await stack.person(['hr.employee']);
  const seen: string[] = [];
  // The original is called with `this` set by the replacement below, never detached.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = EntityManager.prototype.query;
  const spy = mock.method(
    EntityManager.prototype,
    'query',
    function (this: EntityManager, sql: string, parameters?: unknown[]) {
      seen.push(sql);
      return original.call(this, sql, parameters);
    },
  );
  try {
    assert.ok(await stack.roles.accountPermissions(person.secret, target.id));
  } finally {
    spy.mock.restore();
  }
  const reads = seen.filter((sql) => /user_role/.test(sql) && /account_directory/.test(sql));
  assert.equal(reads.length, 1, 'roles and rules come from the same statement');
  assert.match(reads[0] ?? '', /policy_rule/);
});
