import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  ProductAccessDenied,
  ProductAuthorization,
} from '../dist/authorization/services/product-authority.service.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';

import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import { PRODUCT_FRESH_AUTH_SQL } from '../dist/auth/services/product-identity.service.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  productObligations,
  type ProductObligationRegistry,
} from '../dist/authorization/helpers/product-obligations.helper.js';
import { appendProductAudit } from '../dist/audit/product-audit.repository.js';

import {
  createProductAuthorizationCore,
  productBindings,
  productDeclarations,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { ProductDocument1792108800002 } from '../dist/document/migrations/product-document.migration.js';
import { startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import {
  bootstrapActiveRoot,
  bindAccount,
  fixtureProvider,
  oidcSession,
} from './oidc-fixture.helper.ts';

const core = createProductAuthorizationCore();
// Release 2 plus one account boundary, so the IAM suspend path (grant + required boundary) exists.
const release = prepareProductRelease(
  {
    ...productReleaseSource,
    declarations: {
      ...productDeclarations,
      boundaries: [
        ...productDeclarations.boundaries,
        {
          key: 'accountAll',
          version: 1,
          entries: [
            {
              permission: 'account.suspend',
              contextRequirements: [],
              requiredScope: { op: 'constant', value: true },
            },
          ],
        },
      ],
    },
  },
  core,
);
const validators = {
  'fresh@1': (_p: unknown, input: { context: { freshAuthentication?: unknown } }) =>
    input.context.freshAuthentication === true,
};

const utf8 = (value: string) => Buffer.from(value);

const rootEmail = 'root@example.test';
const draft = randomUUID();
const published = randomUUID();
const reader = randomUUID() as IdentityId;
let readerSecret = '';
let postgres: TestPostgres;
let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;
let migration: DataSource;
let runner: ProductTransactionRunner;
let bindings: ProductBindingRegistry;
let root: { id: IdentityId; stale: string };

const service = (obligations: ProductObligationRegistry = productObligations) =>
  new ProductAuthorization(runner, bindings, { validators, obligations }, [
    { resource: 'document', action: 'update', fields: ['title'] },
  ]);

/** A Root session with a step-up 5 s ago, as a 2FA verify leaves it. */
async function freshRoot(): Promise<string> {
  return oidcSession(pools.identity, root.id, { fresh: true });
}

type Event = readonly [string, string, string | null, string | null, Record<string, unknown>];

const revision = () =>
  withClient(
    postgres.superuser,
    async (c) =>
      (await c.query<{ r: string }>('SELECT revision::text r FROM authz_state')).rows[0]!.r,
  );

const events = () =>
  withClient(
    postgres.superuser,
    async (c) =>
      (
        await c.query<{
          id: string;
          kind: string;
          actor: string;
          permission: string | null;
          object: string | null;
          metadata: Record<string, unknown>;
        }>(
          `SELECT event_id id,convert_from(event_kind,'UTF8') kind,actor_id::text actor,convert_from(permission_key,'UTF8') permission,object_id::text object,safe_metadata metadata FROM audit_outbox`,
        )
      ).rows,
  );

/** Events appended by `work` only, as [kind, actor, permission, object_id, metadata]. */
async function appended(work: () => Promise<unknown>) {
  const seen = new Set((await events()).map((e) => e.id));
  const before = await revision();
  await work();
  const added: Event[] = (await events())
    .filter((e) => !seen.has(e.id))
    .map((e) => [e.kind, e.actor, e.permission, e.object, e.metadata] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return { before, after: await revision(), added };
}

const title = async (id: string) =>
  (await migration.query<{ title: string }[]>('SELECT title FROM document WHERE id=$1', [id]))[0]!
    .title;

before(async () => {
  postgres = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'bootstrap', 'migration', 'outbox'].map((p) => [
      p,
      randomBytes(20).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(postgres.superuser, passwords);
  pools = {} as typeof pools;
  for (const p of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[p] = await new DataSource(productDataSourceOptions(connections[p])).initialize();
  migration = await new DataSource(productDataSourceOptions(connections.migration)).initialize();
  await fixtureProvider(migration);
  runner = new ProductTransactionRunner(pools);
  const qr = migration.createQueryRunner();
  await new ProductDocument1792108800002().up(qr);
  await qr.release();
  await new ProductManifestReconciler(runner, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  bindings = new ProductBindingRegistry(core, release.declarations, productBindings);
  // IAM reader: reviewer role (owned documents only), a session without reauthentication.
  await migration.query(`INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`, [
    reader,
  ]);
  await bindAccount(pools.identity, reader);
  readerSecret = await oidcSession(pools.identity, reader);
  await runner.run('admin', async (tx) => {
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      reader,
      utf8('reviewer'),
    ]);
    for (const id of [draft, published])
      await tx.manager.query(
        "INSERT INTO object_ref(object_id,type_key,key_kind,key_bytes) VALUES($1,$2,'uuid',$3)",
        [id, utf8('document'), utf8(id)],
      );
  });
  // Root: pending enrollment → offline bootstrap → Google activation → login (no step-up).
  const { userId: id } = await bootstrapActiveRoot(runner, release, pools.identity, rootEmail);
  root = { id, stale: await oidcSession(pools.identity, id) };
  // One document owned by the reader (draft), one owned by Root (published); no grant names Root.
  await migration.query(
    `INSERT INTO document(id,object_id,owner_id,title,state) VALUES($1,$1,$3,'Draft','draft'),($2,$2,$4,'Published','published')`,
    [draft, published, reader, id],
  );
});
after(async () => {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
});

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
      appendProductAudit(tx, {
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

/** An active IAM account with one Google binding and a session, stepped up 5 s ago if `fresh`. */
async function iamUser(fresh = false) {
  const id = randomUUID() as IdentityId;
  await migration.query(`INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`, [
    id,
  ]);
  await bindAccount(pools.identity, id);
  return { id, secret: await oidcSession(pools.identity, id, { fresh }) };
}

const account = (id: string) =>
  migration.query<{ state: string; epoch: string }[]>(
    'SELECT state,auth_epoch::text epoch FROM app_user WHERE id=$1',
    [id],
  );

test('Root suspends an IAM account; itself, absent and malformed ids reveal nothing', async () => {
  const member = await iamUser();
  const s = service();
  // account.suspend's policy has fresh@1: a stale Root session is refused before any effect, with
  // no data change and no success audit (ADR 0022); after reauthentication it succeeds.
  const stale = await appended(() =>
    assert.rejects(s.suspendUser(root.stale, member.id), ProductAccessDenied),
  );
  assert.deepEqual(stale.added, []);
  assert.equal(stale.after, stale.before);
  assert.deepEqual(await account(member.id), [{ state: 'active', epoch: '1' }]);
  const fresh = await freshRoot();
  const done = await appended(async () =>
    assert.equal(await s.suspendUser(fresh, member.id), true),
  );
  assert.deepEqual(done.added, [
    [
      'account.suspend',
      root.id,
      'account.suspend',
      null,
      {
        principalKind: 'root',
        outcome: 'ok',
        targetUserId: member.id,
        resultingRevision: done.after,
      },
    ],
  ]);
  assert.deepEqual(await account(member.id), [{ state: 'suspended', epoch: '2' }]);
  for (const target of [root.id, randomUUID()]) {
    const absent = await appended(async () =>
      assert.equal(await s.suspendUser(fresh, target), false),
    );
    assert.deepEqual(absent.added, [
      [
        'account.suspend',
        root.id,
        'account.suspend',
        null,
        {
          principalKind: 'root',
          outcome: 'absent',
          targetUserId: target,
          resultingRevision: absent.after,
        },
      ],
    ]);
  }
  assert.equal((await account(root.id))[0]?.state, 'active');
  // A non-canonical id is refused before any lookup: 403 and no event.
  assert.deepEqual(
    (
      await appended(() =>
        assert.rejects(s.suspendUser(fresh, member.id.toUpperCase()), ProductAccessDenied),
      )
    ).added,
    [],
  );
});

test('IAM suspend needs a grant and a boundary; self is 403; Root is invisible to IAM', async () => {
  const admin = await iamUser(true);
  const staleAdmin = await oidcSession(pools.identity, admin.id);
  const unbounded = await iamUser(true);
  const target = await iamUser();
  await runner.run('admin', async (tx) => {
    for (const user of [admin.id, unbounded.id])
      await tx.manager.query(
        "INSERT INTO policy_rule(rule_id,permission_key,user_id,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,'allow',$4,1,'{}','runtime')",
        [randomUUID(), utf8('account.suspend'), user, utf8('allAccounts')],
      );
    await tx.manager.query(
      'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)',
      [admin.id, utf8('account.suspend'), utf8('accountAll')],
    );
  });
  const s = service();
  await assert.rejects(s.suspendUser(unbounded.secret, target.id), ProductAccessDenied);
  await assert.rejects(s.suspendUser(admin.secret, admin.id), ProductAccessDenied);
  assert.equal(await s.suspendUser(admin.secret, root.id), false);
  assert.equal((await account(root.id))[0]?.state, 'active');
  // freshAuthentication@1 still decides for IAM, from the same SQL boolean.
  await assert.rejects(s.suspendUser(staleAdmin, target.id), ProductAccessDenied);
  const done = await appended(async () =>
    assert.equal(await s.suspendUser(admin.secret, target.id), true),
  );
  assert.deepEqual(done.added, [
    ['access.suspend', admin.id, 'account.suspend', null, {}],
    [
      'account.suspend',
      admin.id,
      'account.suspend',
      null,
      { targetUserId: target.id, resultingRevision: done.after },
    ],
  ]);
});
