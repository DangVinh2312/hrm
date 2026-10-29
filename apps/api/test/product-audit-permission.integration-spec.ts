// ADR-13 D1b: permission.* audit events carry only the allowlisted metadata, Root is marked, and a
// failing audit rolls back the mutation of the same command.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  ProductAuthorization,
  type ProductCommand,
} from '../dist/authorization/services/product-authority.service.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import {
  appended,
  bindings,
  draft,
  freshRoot,
  migration,
  root,
  runner,
  setupStack,
  teardownStack,
  title,
  validators,
} from './product-root-stack.helper.ts';

before(setupStack);
after(teardownStack);

const audit = new ProductAuditRepository();

const kinds = [
  'permission.role-create',
  'permission.role-update',
  'permission.role-delete',
  'permission.role-assign',
  'permission.role-revoke',
  'permission.boundary-assign',
  'permission.boundary-revoke',
] as const;

const digest = 'a'.repeat(64);
const user = randomUUID();
const detail = {
  roleKey: 'custom.reviewer',
  grantCount: 3,
  grantsDigest: digest,
  boundaryKey: 'accountAdministration',
  boundaryVersion: 1,
  targetUserId: user,
};

const target = { resource: 'document', keyKind: 'uuid', key: draft, objectId: draft } as const;

const append = (kind: (typeof kinds)[number], extra: unknown) =>
  runner.run('admin', (tx) =>
    audit.appendProductAudit(tx, {
      kind,
      actor: root.id,
      permission: 'document.update',
      target,
      detail: extra,
    } as never),
  );

test('each permission kind records its detail as plain strings next to the target and the resulting revision', async () => {
  for (const kind of kinds) {
    const { before, added } = await appended(() => append(kind, detail));
    assert.equal(added.length, 1, kind);
    const [recorded] = added;
    assert.equal(recorded?.[0], kind);
    assert.equal(recorded?.[2], 'document.update');
    assert.deepEqual(recorded?.[4], {
      resultingRevision: String(BigInt(before) + 1n),
      resource: 'document',
      keyKind: 'uuid',
      key: draft,
      roleKey: 'custom.reviewer',
      grantCount: '3',
      grantsDigest: digest,
      boundaryKey: 'accountAdministration',
      boundaryVersion: '1',
      targetUserId: user,
    });
  }
});

test('detail is optional and a subset is recorded as given', async () => {
  const { added } = await appended(async () => {
    await append('permission.role-delete', undefined);
    await append('permission.role-assign', { roleKey: 'hr.admin', targetUserId: user });
  });
  const byKind = Object.fromEntries(added.map((e) => [e[0], e[4]]));
  assert.equal('roleKey' in (byKind['permission.role-delete'] ?? {}), false);
  assert.equal(byKind['permission.role-assign']?.roleKey, 'hr.admin');
  assert.equal(byKind['permission.role-assign']?.targetUserId, user);
  assert.equal('grantsDigest' in (byKind['permission.role-assign'] ?? {}), false);
});

const refused: readonly [string, unknown][] = [
  ['email', { email: 'person@example.test' }],
  ['sub', { sub: 'google-subject' }],
  ['role label', { roleLabel: 'Người duyệt' }],
  ['token', { token: 'secret' }],
  ['unknown field next to valid ones', { ...detail, extra: 'x' }],
  ['email as role key', { roleKey: 'person@example.test' }],
  ['role key with a space', { roleKey: 'custom.a b' }],
  ['role key too long', { roleKey: `custom.${'a'.repeat(97)}` }],
  ['role key not a string', { roleKey: 5 }],
  ['short digest', { grantsDigest: 'abc' }],
  ['uppercase digest', { grantsDigest: 'A'.repeat(64) }],
  ['negative grant count', { grantCount: -1 }],
  ['fractional grant count', { grantCount: 1.5 }],
  ['grant count over the role limit', { grantCount: 301 }],
  ['grant count as a string', { grantCount: '3' }],
  ['boundary version zero', { boundaryVersion: 0 }],
  ['fractional boundary version', { boundaryVersion: 1.5 }],
  ['target user that is not an id', { targetUserId: 'person@example.test' }],
  ['boundary key with a space', { boundaryKey: 'a b' }],
];

test('anything outside the allowlist or in the wrong shape is refused and nothing is written', async () => {
  for (const [name, extra] of refused) {
    const { before, after, added } = await appended(() =>
      assert.rejects(append('permission.role-create', extra), TypeError, name),
    );
    assert.deepEqual(added, [], name);
    assert.equal(after, before, name);
  }
});

const roleKey = 'custom.reviewer';
const changed = 'Changed by the command';

const commandWith = (auditDetail: unknown): ProductCommand<string, string> => ({
  resource: 'document',
  action: 'update',
  mode: 'write',
  target: () => draft,
  run: async (context, text) => {
    await context.tx.manager.query('UPDATE document SET title=$1 WHERE id=$2', [text, draft]);
    await (context.audit as (...args: unknown[]) => Promise<void>)(
      'permission.role-create',
      { resource: 'document', key: draft, objectId: draft },
      auditDetail,
    );
    return text;
  },
});

const execute = (command: ProductCommand<string, string>, secret: string) =>
  new ProductAuthorization(
    runner,
    audit,
    bindings,
    { validators, obligations: createProductObligations(audit) },
    [],
    [command as ProductCommand<never, unknown>],
  ).execute(secret, command, changed);

test('a command audits through the context: Root is marked and the mutation commits with its event', async () => {
  const secret = await freshRoot();
  const original = await title(draft);
  const { before, after, added } = await appended(async () => {
    assert.equal(
      await execute(commandWith({ roleKey, grantCount: 0, grantsDigest: digest }), secret),
      changed,
    );
  });
  assert.equal(await title(draft), changed);
  assert.equal(after, before);
  const events = added.filter((e) => e[0] === 'permission.role-create');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.[1], root.id);
  assert.deepEqual(events[0]?.[4], {
    resultingRevision: after,
    principalKind: 'root',
    outcome: 'ok',
    resource: 'document',
    keyKind: 'uuid',
    key: draft,
    roleKey,
    grantCount: '0',
    grantsDigest: digest,
  });
  await migration.query('UPDATE document SET title=$1 WHERE id=$2', [original, draft]);
});

test('a refused audit detail rolls the mutation of the same command back', async () => {
  const secret = await freshRoot();
  const original = await title(draft);
  const { before, after, added } = await appended(() =>
    assert.rejects(
      execute(commandWith({ roleKey, email: 'person@example.test' }), secret),
      TypeError,
    ),
  );
  assert.equal(await title(draft), original);
  assert.equal(after, before);
  assert.deepEqual(
    added.filter((e) => e[0] === 'permission.role-create'),
    [],
  );
});
