// account.assignRole / account.revokeRole (ADR-13 D4): who may give or take a role, the
// invariants (a)-(d), the 409 states, atomic audit, concurrency and the shared-fence pre-check
// that keeps an unreachable caller off the exclusive fence. Service level on real PostgreSQL,
// synthetic people only. The boundary is the real `accountAdministration@1`, bound by the stack helper.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { FIXTURE_ISSUER } from './oidc-fixture.helper.ts';
import { ProductAuthenticationError } from '../dist/authentication/services/product-identity.service.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductAccountService } from '../dist/authorization/services/product-account.service.js';
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
  appended,
  bindAccountBoundary,
  bindings,
  freshRoot,
  grantViaRole,
  iamUser,
  migration,
  pools,
  revision,
  root,
  runner,
  accounts,
  service,
  setupStack,
  teardownStack,
  utf8,
  validators,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

const COMMANDS = ['account.assignRole', 'account.revokeRole'];

/** An IAM actor with a fresh session, both grants through one role and the boundary bound. */
async function admin(extra: readonly (string | GrantSpec)[] = []) {
  const user = await iamUser(true);
  const role = await grantViaRole(user.id, [...COMMANDS, ...extra]);
  await bindAccountBoundary(user.id, COMMANDS);
  return { ...user, role };
}

const ruleSql =
  "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,$4,$5,1,$6,'runtime')";

/** A runtime role nobody holds, written by the owner login (so any rule shape can be seeded). */
async function roleWith(
  grants: readonly (string | GrantSpec)[],
  key = `custom.${randomBytes(6).toString('hex')}`,
) {
  await migration.query(
    "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime',$2)",
    [utf8(key), 'Fixture'],
  );
  for (const grant of grants) {
    const spec: GrantSpec = typeof grant === 'string' ? { permission: grant } : grant;
    await migration.query(ruleSql, [
      randomUUID(),
      utf8(spec.permission),
      utf8(key),
      spec.effect ?? 'allow',
      utf8(spec.template ?? 'allAccounts'),
      JSON.stringify(spec.parameters ?? {}),
    ]);
  }
  return key;
}

const held = async (id: string) =>
  (
    await migration.query<{ role: string }[]>(
      "SELECT convert_from(role_key,'UTF8') AS role FROM user_role WHERE user_id=$1 ORDER BY 1",
      [id],
    )
  ).map((row) => row.role);

const give = (id: string, role: string) =>
  migration.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [id, utf8(role)]);

const roleEvents = () =>
  migration.query<
    { kind: string; actor: string; object: string | null; metadata: Record<string, string> }[]
  >(
    `SELECT convert_from(event_kind,'UTF8') AS kind, actor_id::text AS actor, object_id::text AS object, safe_metadata AS metadata
       FROM audit_outbox WHERE convert_from(event_kind,'UTF8') LIKE 'permission.role-%' ORDER BY occurred_at, event_id`,
  );

const rejected = (reason: string) => (error: unknown) =>
  error instanceof ProductCommandRejected && error.reason === reason;

type Run = (secret: string, id: string, role: string) => Promise<boolean>;

const assign: Run = (secret, id, role) => accounts().assignRole(secret, id, role);

const revoke: Run = (secret, id, role) => accounts().revokeRole(secret, id, role);

/** Nothing of the command happened: same roles on the target, no role event, same revision. */
async function untouched(id: string, run: () => Promise<unknown>, check: (e: unknown) => boolean) {
  const [roles, events, before] = [await held(id), (await roleEvents()).length, await revision()];
  await assert.rejects(run(), check);
  assert.deepEqual(await held(id), roles);
  assert.equal((await roleEvents()).length, events);
  assert.equal(await revision(), before);
}

/** "Not found" (`false`): same roles, no role event. */
async function notFound(id: string, run: () => Promise<boolean>) {
  const [roles, events] = [await held(id), (await roleEvents()).length];
  assert.equal(await run(), false);
  assert.deepEqual(await held(id), roles);
  assert.equal((await roleEvents()).length, events);
}

const denied = (error: unknown) => error instanceof ProductAccessDenied;

test('an IAM actor assigns a role inside its set: one user_role row, one audit event, effective at the next request', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  assert.equal(await service().permits(target.secret, 'account', 'read'), false);
  const result = await appended(async () =>
    assert.equal(await assign(actor.secret, target.id, role), true),
  );
  assert.equal(BigInt(result.after), BigInt(result.before) + 1n);
  assert.deepEqual(await held(target.id), [role]);
  assert.equal(await service().permits(target.secret, 'account', 'read'), true);
  const [event, ...others] = (await roleEvents()).filter((e) => e.metadata.roleKey === role);
  assert.equal(others.length, 0);
  assert.equal(event?.kind, 'permission.role-assign');
  assert.equal(event?.actor, actor.id);
  assert.equal(event?.object, target.id);
  assert.equal(event?.metadata.targetUserId, target.id);
  assert.equal(event?.metadata.resource, 'account');
  assert.equal(event?.metadata.principalKind, undefined);
  assert.deepEqual(Object.keys(event?.metadata ?? {}).sort(), [
    'key',
    'keyKind',
    'resource',
    'resultingRevision',
    'roleKey',
    'targetUserId',
  ]);
});

test('an IAM actor revokes a held role: the row goes, one audit event, effective at the next request', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  await give(target.id, role);
  assert.equal(await service().permits(target.secret, 'account', 'read'), true);
  assert.equal(await revoke(actor.secret, target.id, role), true);
  assert.deepEqual(await held(target.id), []);
  assert.equal(await service().permits(target.secret, 'account', 'read'), false);
  const [event] = (await roleEvents()).filter((e) => e.metadata.roleKey === role);
  assert.equal(event?.kind, 'permission.role-revoke');
  assert.equal(event?.metadata.targetUserId, target.id);
  assert.equal(event?.actor, actor.id);
});

test('Root assigns any role, a code role included, and its events carry the Root marker; email and label never reach audit', async () => {
  const rootSecret = await freshRoot();
  const target = await iamUser();
  const result = await appended(async () =>
    assert.equal(await assign(rootSecret, target.id, 'hr.admin'), true),
  );
  assert.deepEqual(await held(target.id), ['hr.admin']);
  const event = (await roleEvents()).find((e) => e.metadata.targetUserId === target.id);
  assert.equal(event?.kind, 'permission.role-assign');
  assert.equal(event?.actor, root.id);
  assert.equal(event?.metadata.principalKind, 'root');
  assert.equal(event?.metadata.outcome, 'ok');
  assert.equal(event?.metadata.roleKey, 'hr.admin');
  assert.equal(BigInt(result.after), BigInt(result.before) + 1n);
  assert.equal(await revoke(rootSecret, target.id, 'hr.admin'), true);
  const revoked = (await roleEvents()).filter(
    (e) => e.kind === 'permission.role-revoke' && e.metadata.targetUserId === target.id,
  );
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]?.metadata.principalKind, 'root');
  for (const e of await roleEvents()) {
    const text = JSON.stringify(e);
    assert.ok(!text.includes('@') && !text.includes('Fixture'));
  }
});

test('a code role is assignable by an IAM actor who holds every rule of it', async () => {
  const actor = await admin();
  await give(actor.id, 'hr.admin');
  const target = await iamUser();
  assert.equal(await assign(actor.secret, target.id, 'hr.admin'), true);
  assert.deepEqual(await held(target.id), ['hr.admin']);
  // The actor set without hr.admin cannot give it.
  const plain = await admin();
  const other = await iamUser();
  await notFound(other.id, () => assign(plain.secret, other.id, 'hr.admin'));
});

test('(a) self: assign and revoke on oneself are 403, nothing changes, no audit, revision unchanged', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  await untouched(actor.id, () => assign(actor.secret, actor.id, role), denied);
  await give(actor.id, role);
  await untouched(actor.id, () => revoke(actor.secret, actor.id, role), denied);
  // Self is judged after the directory lookup, before the lock: also for an absent role.
  await untouched(actor.id, () => assign(actor.secret, actor.id, 'custom.nope'), denied);
});

test('(b) Root, an absent id and a foreign id are the same "not found", for assign and revoke', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  for (const id of [root.id, randomUUID()]) {
    const before = await revision();
    assert.equal(await assign(actor.secret, id, role), false);
    assert.equal(await revoke(actor.secret, id, role), false);
    assert.equal((await roleEvents()).filter((e) => e.metadata.targetUserId === id).length, 0);
    assert.equal(BigInt(await revision()), BigInt(before));
  }
  // Root itself targeting Root or an absent id: the same answer, never a role on the Root row.
  const rootSecret = await freshRoot();
  assert.equal(await assign(rootSecret, root.id, role), false);
  assert.equal(await assign(rootSecret, randomUUID(), role), false);
  assert.deepEqual(await held(root.id), []);
});

test('a non-canonical id is 403 before any query: even a bad session secret is not looked at', async () => {
  const role = await roleWith([]);
  for (const id of ['', 'x', root.id.toUpperCase(), `${randomUUID()} `, '../etc'])
    for (const run of [assign, revoke])
      await assert.rejects(run('not-a-session', id, role), denied);
  const actor = await admin();
  await assert.rejects(assign('not-a-session', randomUUID(), role), ProductAuthenticationError);
  await assert.rejects(assign(actor.secret, 'ABC', role), denied);
});

test('a role key that is not a string, empty or over 96 bytes is a 400 before any transaction', async () => {
  const actor = await admin();
  const target = await iamUser();
  for (const bad of [5, null, undefined, '', 'a'.repeat(97), 'é'.repeat(49)])
    for (const run of [assign, revoke])
      await assert.rejects(run(actor.secret, target.id, bad as never), ProductInvalidRequest);
  await assert.rejects(assign('not-a-session', target.id, 'a'.repeat(97)), ProductInvalidRequest);
});

test('an absent role is "not found" for assign and for revoke; revoking a role never held is a 409', async () => {
  const actor = await admin();
  const target = await iamUser();
  await notFound(target.id, () => assign(actor.secret, target.id, 'custom.absent'));
  await notFound(target.id, () => revoke(actor.secret, target.id, 'custom.absent'));
  const rootSecret = await freshRoot();
  await notFound(target.id, () => assign(rootSecret, target.id, 'custom.absent'));
  const role = await roleWith([]);
  await untouched(
    target.id,
    () => revoke(actor.secret, target.id, role),
    rejected('role_not_held'),
  );
});

test('(c) a role with a rule outside the actor set is "not found": more permission, another template, a parameter', async () => {
  const actor = await admin(['account.read']);
  const target = await iamUser();
  const beyond = await roleWith(['account.read', 'account.provision']);
  const template = await roleWith([{ permission: 'account.read', template: 'setting' }]);
  const parameterised = await roleWith([
    { permission: 'account.read', parameters: { scope: 'x' } },
  ]);
  for (const role of [beyond, template, parameterised])
    await notFound(target.id, () => assign(actor.secret, target.id, role));
  // A role whose every rule the actor holds is fine, including an empty one.
  assert.equal(await assign(actor.secret, target.id, await roleWith(['account.read'])), true);
  assert.equal(await assign(actor.secret, target.id, await roleWith([])), true);
});

test('(c) a deny in the role, a deny or a user rule on the actor, or a code role the actor lacks, cannot be proven: "not found"', async () => {
  const actor = await admin(['account.read']);
  const target = await iamUser();
  const denying = await roleWith([
    'account.read',
    { permission: 'account.provision', effect: 'deny' },
  ]);
  await notFound(target.id, () => assign(actor.secret, target.id, denying));

  const inSet = await roleWith(['account.read']);
  const tainted = await admin([
    'account.read',
    { permission: 'account.provision', effect: 'deny' },
  ]);
  await notFound(target.id, () => assign(tainted.secret, target.id, inSet));

  const userRule = await admin(['account.read']);
  await migration.query(
    "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow','allAccounts',1,'{}','runtime')",
    [randomUUID(), utf8('account.read'), userRule.id],
  );
  await notFound(target.id, () => assign(userRule.secret, target.id, inSet));

  await notFound(target.id, () => assign(actor.secret, target.id, 'hr.admin'));
});

test('(c) pairs outside the actor set are refused: another permission, another template, a pair outside the default grants', async () => {
  const actor = await admin(['account.read']);
  const target = await iamUser();
  const pairs: readonly (readonly [string, string])[] = [
    ['account.read', 'setting'],
    ['account.readPermissions', 'allAccounts'],
    ['account.suspend', 'allAccounts'],
    ['employee.read', 'allEmployees'],
  ];
  for (const [permission, template] of pairs) {
    const role = await roleWith([{ permission, template }]);
    await notFound(target.id, () => assign(actor.secret, target.id, role));
  }
  assert.deepEqual(await held(target.id), []);
});

test('(c) a read cut off by the row cap cannot prove the role is within the actor set', async () => {
  const actor = await admin(['account.read']);
  const target = await iamUser();
  const role = await roleWith(['account.read']);
  await migration.query(
    `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
     SELECT gen_random_uuid(), $1, $2, 'allow', $3, 1, jsonb_build_object('i', g), 'runtime' FROM generate_series(1, 20001) g`,
    [utf8('account.read'), utf8(actor.role), utf8('allAccounts')],
  );
  await notFound(target.id, () => assign(actor.secret, target.id, role));
  await notFound(target.id, () => revoke(actor.secret, target.id, role));
});

test('(c) a role of more rules than one read can hold is "not found" for an IAM actor even when the actor holds them all; Root may', async () => {
  const actor = await admin(['account.read']);
  const target = await iamUser();
  const big = await roleWith(['account.read']);

  // 301 rules in all (one plain, 300 with a parameter): one more than a read of a role returns.
  const many = (role: string) =>
    migration.query(
      `INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by)
       SELECT gen_random_uuid(), $1, $2, 'allow', $3, 1, jsonb_build_object('i', g), 'runtime' FROM generate_series(1, 300) g`,
      [utf8('account.read'), utf8(role), utf8('allAccounts')],
    );

  await many(big);
  await many(actor.role);
  await notFound(target.id, () => assign(actor.secret, target.id, big));
  assert.equal(await assign(await freshRoot(), target.id, big), true);
  // Control: the same rules in 300 or fewer are provable, so the refusal above is the cut-off.
  const small = await roleWith(['account.read']);
  assert.equal(await assign(actor.secret, target.id, small), true);
});

test('(d) a target whose set is larger than the actor set is "not found" for assign and for revoke, whatever the role', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const larger = await iamUser();
  await grantViaRole(larger.id, ['account.provision']);
  await notFound(larger.id, () => assign(actor.secret, larger.id, role));
  await give(larger.id, role);
  await notFound(larger.id, () => revoke(actor.secret, larger.id, role));
  // Not 409 either: a larger account does not reveal whether it holds the role.
  const unheld = await roleWith([]);
  await notFound(larger.id, () => revoke(actor.secret, larger.id, unheld));
  // Root is outside the comparison.
  assert.equal(await revoke(await freshRoot(), larger.id, role), true);
});

test('(d) a deny or a user rule on the target, or an equal or smaller set, behaves as in suspend', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const same = await iamUser();
  await grantViaRole(same.id, ['account.read']);
  assert.equal(await assign(actor.secret, same.id, role), true);
  const denyTarget = await iamUser();
  await grantViaRole(denyTarget.id, [{ permission: 'account.read', effect: 'deny' }]);
  await notFound(denyTarget.id, () => assign(actor.secret, denyTarget.id, role));
});

test('409: a role already held, a role not held, and the 20-role cap per account', async () => {
  const actor = await admin(['account.read']);
  const target = await iamUser();
  const role = await roleWith(['account.read']);
  assert.equal(await assign(actor.secret, target.id, role), true);
  await untouched(target.id, () => assign(actor.secret, target.id, role), rejected('role_held'));
  assert.equal(await revoke(actor.secret, target.id, role), true);
  await untouched(
    target.id,
    () => revoke(actor.secret, target.id, role),
    rejected('role_not_held'),
  );

  const full = await iamUser();
  const roles: string[] = [];
  for (let i = 0; i < 20; i++) {
    const key = await roleWith([]);
    roles.push(key);
    await give(full.id, key);
  }
  const twentyFirst = await roleWith([]);
  const rootSecret = await freshRoot();
  await untouched(
    full.id,
    () => assign(actor.secret, full.id, twentyFirst),
    rejected('role_limit'),
  );
  await untouched(full.id, () => assign(rootSecret, full.id, twentyFirst), rejected('role_limit'));
  // Already held outranks the cap, and room again after one revoke.
  await untouched(full.id, () => assign(actor.secret, full.id, roles[0]!), rejected('role_held'));
  assert.equal(await revoke(actor.secret, full.id, roles[0]!), true);
  assert.equal(await assign(actor.secret, full.id, twentyFirst), true);
  assert.equal((await held(full.id)).length, 20);
});

test('any account state is allowed: pending and suspended accounts take and lose roles', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const suspended = await iamUser();
  assert.equal(await accounts().suspendUser(await freshRoot(), suspended.id), true);
  assert.equal(await assign(actor.secret, suspended.id, role), true);
  assert.equal(await revoke(actor.secret, suspended.id, role), true);
  const pending = randomUUID();
  await pools.data.query('SELECT public.provision_oidc_account($1,$2,$3,$4)', [
    pending,
    `${pending}@example.test`,
    FIXTURE_ISSUER,
    root.id,
  ]);
  assert.equal(await assign(actor.secret, pending, role), true);
  assert.deepEqual(await held(pending), [role]);
  assert.equal(await revoke(actor.secret, pending, role), true);
  assert.deepEqual(await held(pending), []);
});

test('boundary is required: grant without a binding is denied for assign and revoke, and nothing changes', async () => {
  const unbound = await iamUser(true);
  await grantViaRole(unbound.id, [...COMMANDS, 'account.read']);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  await untouched(target.id, () => assign(unbound.secret, target.id, role), denied);
  await give(target.id, role);
  await untouched(target.id, () => revoke(unbound.secret, target.id, role), denied);
  // Bound for one command only: the other stays denied.
  const half = await iamUser(true);
  await grantViaRole(half.id, [...COMMANDS, 'account.read']);
  await bindAccountBoundary(half.id, ['account.revokeRole']);
  await untouched(target.id, () => assign(half.secret, target.id, role), denied);
});

test('fresh@1 is required for assign and revoke, for an IAM actor and for Root', async () => {
  const stale = await iamUser(false);
  await grantViaRole(stale.id, [...COMMANDS, 'account.read']);
  await bindAccountBoundary(stale.id, COMMANDS);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  await untouched(target.id, () => assign(stale.secret, target.id, role), denied);
  await give(target.id, role);
  await untouched(target.id, () => revoke(stale.secret, target.id, role), denied);
  const plainRoot = root.stale;
  await untouched(target.id, () => revoke(plainRoot, target.id, role), denied);
  await untouched(target.id, () => assign(plainRoot, target.id, role), denied);
});

test('the release gives no default grant to either command: code roles carry no rule for them', async () => {
  const rows = await migration.query<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM policy_rule WHERE convert_from(permission_key,'UTF8') = ANY($1) AND managed_by='code'`,
    [COMMANDS],
  );
  assert.equal(rows[0]?.n, '0');
  // hr.admin plus the binding but no grant for the commands: the plan reaches no account.
  const hr = await iamUser(true);
  await give(hr.id, 'hr.admin');
  await bindAccountBoundary(hr.id, COMMANDS);
  const target = await iamUser();
  await notFound(target.id, () => assign(hr.secret, target.id, 'hr.admin'));
  await notFound(target.id, () => revoke(hr.secret, target.id, 'hr.admin'));
});

/** An authorization over a runner whose lock wait is short, so waiting for the fence is visible. */
function impatient() {
  const audit = new ProductAuditRepository();
  const short = new ProductTransactionRunner(pools, { lockTimeoutMs: 100, maxRetries: 0 });
  const authority = new ProductAuthorization(short, audit, bindings, {
    validators,
    obligations: createProductObligations(audit),
  });
  return new ProductAccountService(authority, audit, bindings);
}

test('F1: an unreachable caller is answered under the shared fence: it does not wait for the exclusive fence', async () => {
  const nobody = await iamUser(true);
  const unbound = await iamUser(true);
  await grantViaRole(unbound.id, COMMANDS);
  const target = await iamUser();
  const role = await roleWith([]);
  const permitted = await iamUser(true);
  const all = [...COMMANDS, 'account.suspend', 'account.reactivate'];
  await grantViaRole(permitted.id, all);
  await bindAccountBoundary(permitted.id, all);
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const holder = runner.run('read', async () => {
    entered();
    await open;
  });
  const service = impatient();
  try {
    await inside;
    await assert.rejects(
      new ProductTransactionRunner(pools, { lockTimeoutMs: 100, maxRetries: 0 }).run('admin', () =>
        Promise.resolve(),
      ),
      (e) => e instanceof TransactionConflictError || e instanceof AuthorityUnavailableError,
    );
    for (const caller of [nobody, unbound]) {
      await assert.rejects(service.assignRole(caller.secret, target.id, role), denied);
      await assert.rejects(service.revokeRole(caller.secret, target.id, role), denied);
      await assert.rejects(service.suspendUser(caller.secret, target.id), denied);
      await assert.rejects(service.reactivateUser(caller.secret, target.id), denied);
    }
    // A permitted caller with a target outside its reach is answered there too.
    for (const id of [randomUUID(), root.id]) {
      assert.equal(await service.assignRole(permitted.secret, id, role), false);
      assert.equal(await service.revokeRole(permitted.secret, id, role), false);
      assert.equal(await service.suspendUser(permitted.secret, id), false);
      assert.equal(await service.reactivateUser(permitted.secret, id), false);
    }
  } finally {
    release();
    await holder;
  }
});

test('F1: a permitted caller whose target is absent or Root leaves the revision unchanged, for all four commands', async () => {
  const permitted = await iamUser(true);
  const all = [...COMMANDS, 'account.suspend', 'account.reactivate'];
  await grantViaRole(permitted.id, all);
  await bindAccountBoundary(permitted.id, all);
  const role = await roleWith([]);
  for (const id of [randomUUID(), root.id]) {
    const before = await revision();
    assert.equal(await accounts().assignRole(permitted.secret, id, role), false);
    assert.equal(await accounts().revokeRole(permitted.secret, id, role), false);
    assert.equal(await accounts().suspendUser(permitted.secret, id), false);
    assert.equal(await accounts().reactivateUser(permitted.secret, id), false);
    assert.equal(await revision(), before);
  }
  const callers = [await iamUser(true), await iamUser(false)];
  const target = await iamUser();
  for (const caller of callers) {
    const before = await revision();
    for (const run of [
      () => accounts().assignRole(caller.secret, target.id, role),
      () => accounts().revokeRole(caller.secret, target.id, role),
      () => accounts().suspendUser(caller.secret, target.id),
      () => accounts().reactivateUser(caller.secret, target.id),
    ])
      await assert.rejects(run(), denied);
    assert.equal(await revision(), before);
  }
});

test('F1: the exclusive step decides again: a grant revoked after the shared check is not honoured', async () => {
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
  const service = new ProductAccountService(
    new ProductAuthorization(hooked, audit, bindings, {
      validators,
      obligations: createProductObligations(audit),
    }),
    audit,
    bindings,
  );
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  hooked.before = async () => {
    await migration.query('DELETE FROM user_boundary WHERE user_id=$1', [actor.id]);
  };
  await assert.rejects(service.assignRole(actor.secret, target.id, role), denied);
  assert.deepEqual(await held(target.id), []);
});

test('a failing audit rolls the whole command back, for IAM and for Root, assign and revoke', async () => {
  class Failing extends ProductAuditRepository {
    override appendProductAudit(): Promise<void> {
      return Promise.reject(new Error('audit down'));
    }
  }
  const failing = new ProductAccountService(
    new ProductAuthorization(runner, new ProductAuditRepository(), bindings, {
      validators,
      obligations: createProductObligations(new ProductAuditRepository()),
    }),
    new Failing(),
    bindings,
  );
  const actor = await admin(['account.read']);
  const rootSecret = await freshRoot();
  const role = await roleWith(['account.read']);
  const target = await iamUser();

  const fault = (e: unknown) => e instanceof Error && e.message === 'audit down';

  for (const secret of [actor.secret, rootSecret])
    await untouched(target.id, () => failing.assignRole(secret, target.id, role), fault);
  await give(target.id, role);
  for (const secret of [actor.secret, rootSecret])
    await untouched(target.id, () => failing.revokeRole(secret, target.id, role), fault);
  assert.deepEqual(await held(target.id), [role]);
});

test('concurrency: two assigns of one pair give one success and one 409; the table has one row', async () => {
  const actor = await admin(['account.read']);
  const other = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  const results = await Promise.allSettled([
    assign(actor.secret, target.id, role),
    assign(other.secret, target.id, role),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value === true);
  const conflict = results.filter(
    (r) => r.status === 'rejected' && rejected('role_held')(r.reason),
  );
  assert.equal(ok.length, 1);
  assert.equal(conflict.length, 1);
  assert.deepEqual(await held(target.id), [role]);
  assert.equal((await roleEvents()).filter((e) => e.metadata.roleKey === role).length, 1);
});

test('concurrency: assign against revoke of one pair ends consistent, never a half state', async () => {
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  await give(target.id, role);
  const [a, r] = await Promise.allSettled([
    assign(actor.secret, target.id, role),
    revoke(actor.secret, target.id, role),
  ]);
  assert.equal(r.status, 'fulfilled');
  if (a.status === 'fulfilled') assert.deepEqual(await held(target.id), [role]);
  else {
    assert.ok(rejected('role_held')(a.reason));
    assert.deepEqual(await held(target.id), []);
  }
});

test('concurrency: assign against suspend of the same account: both land, the role is held on a suspended account', async () => {
  const actor = await admin(['account.read']);
  const rootSecret = await freshRoot();
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  const [a, s] = await Promise.all([
    assign(actor.secret, target.id, role),
    accounts().suspendUser(rootSecret, target.id),
  ]);
  assert.equal(a, true);
  assert.equal(s, true);
  assert.deepEqual(await held(target.id), [role]);
  const [row] = await migration.query<{ state: string }[]>(
    'SELECT state FROM app_user WHERE id=$1',
    [target.id],
  );
  assert.equal(row?.state, 'suspended');
});

test('the target row is locked before the facts are read, in the exclusive transaction', async () => {
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
  const spy = new Spy(pools);
  const audit = new ProductAuditRepository();
  const service = new ProductAccountService(
    new ProductAuthorization(spy, audit, bindings, {
      validators,
      obligations: createProductObligations(audit),
    }),
    audit,
    bindings,
  );
  const actor = await admin(['account.read']);
  const role = await roleWith(['account.read']);
  const target = await iamUser();
  assert.equal(await service.assignRole(actor.secret, target.id, role), true);
  const lock = statements.findIndex((s) => /FROM app_user WHERE id=\$1 FOR NO KEY UPDATE/.test(s));
  const facts = statements.findIndex((s) => /FROM user_role ur JOIN policy_rule/.test(s));
  const write = statements.findIndex((s) => /INSERT INTO user_role/.test(s));
  assert.ok(lock >= 0 && facts > lock && write > facts, JSON.stringify({ lock, facts, write }));
  assert.equal(statements.filter((s) => /FROM user_role ur JOIN policy_rule/.test(s)).length, 1);
});
