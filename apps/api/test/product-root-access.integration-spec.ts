// Root: fresh@1, document access, audit and fail-closed inputs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ProductAccessDenied } from '../dist/authorization/services/product-authority.service.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { PRODUCT_FRESH_AUTH_SQL } from '../dist/authentication/services/product-identity.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import { withClient } from './setup-postgres.ts';
import { oidcSession } from './oidc-fixture.helper.ts';
import {
  utf8,
  draft,
  published,
  reader,
  readerSecret,
  postgres,
  pools,
  runner,
  root,
  service,
  freshRoot,
  appended,
  title,
  iamUser,
  account,
  setupStack,
  teardownStack,
} from './product-root-stack.helper.ts';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

before(setupStack);
after(teardownStack);

test('fresh reauthentication is decided in SQL at microsecond precision on the DB clock', async () => {
  const fresh = async (age: string | null) =>
    (
      await pools.data.query<{ fresh: boolean }[]>(
        `SELECT ${PRODUCT_FRESH_AUTH_SQL} AS fresh FROM (SELECT statement_timestamp()-$1::interval AS reauthenticated_at) s`,
        [age],
      )
    )[0]!.fresh;

  assert.equal(await fresh(null), false);
  assert.equal(await fresh('-1 second'), false);
  assert.equal(await fresh('300 seconds'), false);
  assert.equal(await fresh('299.999999 seconds'), true);
  assert.equal(await fresh('0 seconds'), true);
});

test('Root reads every document without a grant, through the same projection, with an audit per access', async () => {
  const s = service();
  const missing = randomUUID();
  const { added } = await appended(async () => {
    const page = await s.list(root.stale, 'document', 'read');
    assert.equal(page.total, '2');
    assert.deepEqual(page.items.map((item) => item.title).sort(), ['Draft', 'Published']);
    assert.ok(page.items.every((item) => !('ownerId' in item)));
    assert.equal(await s.count(root.stale, 'document', 'read'), '2');
    assert.equal((await s.detail(root.stale, 'document', 'read', draft))?.title, 'Draft');
    assert.equal(await s.detail(root.stale, 'document', 'read', missing), null);
  });
  const ok = { principalKind: 'root', outcome: 'ok' };
  assert.deepEqual(added, [
    ['access.document.read', root.id, 'document.read', null, ok],
    ['access.document.read', root.id, 'document.read', null, ok],
    [
      'access.document.read',
      root.id,
      'document.read',
      null,
      { ...ok, resource: 'document', keyKind: 'uuid', key: draft },
    ],
    [
      'access.document.read',
      root.id,
      'document.read',
      null,
      {
        principalKind: 'root',
        outcome: 'absent',
        resource: 'document',
        keyKind: 'uuid',
        key: missing,
      },
    ],
  ]);
  // An empty obligation registry changes nothing for Root: its audit is written directly.
  assert.equal(
    (await appended(() => service({}).count(root.stale, 'document', 'read'))).added.length,
    1,
  );
});

test('Root writes an action without fresh@1 on a stale session; scope is bypassed but fields are not', async () => {
  const s = service();
  // ADR 0022: document.update's policy has no fresh@1, so Root needs no reauthentication (IAM
  // neither). Not a draft: the `editable` scope would deny an IAM user; Root bypasses it.
  const written = await appended(async () =>
    assert.equal(
      await s.update(root.stale, 'document', 'update', published, { title: 'By Root' }),
      true,
    ),
  );
  assert.deepEqual(written.added, [
    [
      'data.update',
      root.id,
      'document.update',
      published,
      {
        principalKind: 'root',
        outcome: 'ok',
        resource: 'document',
        keyKind: 'uuid',
        key: published,
        resultingRevision: written.before,
      },
    ],
  ]);
  assert.equal(await title(published), 'By Root');
  const missing = randomUUID();
  const absent = await appended(async () =>
    assert.equal(
      await s.update(root.stale, 'document', 'update', missing, { title: 'Nowhere' }),
      false,
    ),
  );
  assert.deepEqual(absent.added, [
    [
      'data.update',
      root.id,
      'document.update',
      null,
      {
        principalKind: 'root',
        outcome: 'absent',
        resource: 'document',
        keyKind: 'uuid',
        key: missing,
        resultingRevision: absent.before,
      },
    ],
  ]);
  // The writable-field allowlist still binds Root, fresh or not.
  for (const secret of [root.stale, await freshRoot()])
    await assert.rejects(
      s.update(secret, 'document', 'update', published, { ownerId: root.id }),
      ProductAccessDenied,
    );
});

test('a fresh@1 action binds Root: an OIDC session without a step-up is refused, one with it passes', async () => {
  const session = (reauthenticated: boolean) =>
    oidcSession(pools.identity, root.id, { fresh: reauthenticated });

  // account.suspend's policy has fresh@1 (ADR 0022): it binds Root, whatever the sign-in method.
  const member = await iamUser();
  const staleSession = await session(false);
  const stale = await appended(() =>
    assert.rejects(service().suspendUser(staleSession, member.id), ProductAccessDenied),
  );
  assert.deepEqual(stale.added, []);
  assert.deepEqual(await account(member.id), [{ state: 'active', epoch: '1' }]);
  assert.equal(await service().suspendUser(await session(true), member.id), true);
  assert.deepEqual(await account(member.id), [{ state: 'suspended', epoch: '2' }]);
});

test('a failed Root audit rolls the access back and returns nothing', async () => {
  const fresh = await freshRoot();
  const before = await title(draft);
  await withClient(postgres.superuser, (c) =>
    c.query('REVOKE INSERT ON audit_outbox FROM product_data'),
  );
  try {
    await assert.rejects(service().list(root.stale, 'document', 'read'), /permission denied/);
    await assert.rejects(
      service().update(fresh, 'document', 'update', draft, { title: 'Must not stick' }),
      /permission denied/,
    );
    // IAM reads carry no audit obligation here, so they are unaffected.
    assert.equal((await service().list(readerSecret, 'document', 'read')).total, '1');
  } finally {
    await withClient(postgres.superuser, (c) =>
      c.query('GRANT INSERT ON audit_outbox TO product_data'),
    );
  }
  assert.equal(await title(draft), before);
});

test('malformed keys, unknown actions and resources fail closed for Root without an event', async () => {
  const fresh = await freshRoot();
  const { added } = await appended(async () => {
    await assert.rejects(
      service().detail(root.stale, 'document', 'read', 'not-a-key'),
      ProductInvalidRequest,
    );
    await assert.rejects(
      service().update(fresh, 'document', 'update', 'not-a-key', { title: 'x' }),
      ProductInvalidRequest,
    );
    await assert.rejects(service().list(root.stale, 'document', 'delete'), ProductAccessDenied);
    await assert.rejects(service().list(root.stale, 'invoice', 'read'), ProductAccessDenied);
  });
  assert.deepEqual(added, []);
});

test('a string record key never reaches Root audit metadata', async () => {
  const { added } = await appended(() =>
    runner.run('read', (tx) =>
      audit.appendProductAudit(tx, {
        kind: 'access.person.read',
        actor: root.id,
        permission: 'person.read',
        principalKind: 'root',
        outcome: 'absent',
        target: { resource: 'person', keyKind: 'string', key: 'person@example.test' },
      }),
    ),
  );
  assert.deepEqual(added, [
    [
      'access.person.read',
      root.id,
      'person.read',
      null,
      { principalKind: 'root', outcome: 'absent', resource: 'person', keyKind: 'string' },
    ],
  ]);
});

test('IAM reads stay scoped and unaudited; a role named like Root grants nothing', async () => {
  await runner.run('admin', async (tx) => {
    for (const key of ['system.root', 'root']) {
      await tx.manager.query(
        "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime',$2)",
        [utf8(key), `Named ${key}`],
      );
      await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
        reader,
        utf8(key),
      ]);
    }
  });
  const { added } = await appended(async () => {
    const page = await service().list(readerSecret, 'document', 'read');
    assert.equal(page.total, '1');
    assert.equal(await service().detail(readerSecret, 'document', 'read', published), null);
  });
  assert.deepEqual(added, []);
});
