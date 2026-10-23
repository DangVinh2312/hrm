import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  createProductObligations,
  type ProductObligationRegistry,
} from '../dist/authorization/services/product-obligation.service.js';
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
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();
const productObligations = createProductObligations(audit);

export const core = createProductAuthorizationCore();

// Release 2 plus one account boundary, so the IAM suspend path (grant + required boundary) exists.
export const release = prepareProductRelease(
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

export const validators = {
  'fresh@1': (_p: unknown, input: { context: { freshAuthentication?: unknown } }) =>
    input.context.freshAuthentication === true,
};

export const utf8 = (value: string) => Buffer.from(value);

export const rootEmail = 'root@example.test';

export const draft = randomUUID();

export const published = randomUUID();

export const reader = randomUUID() as IdentityId;

export let readerSecret = '';

export let postgres: TestPostgres;

export let pools: Record<'data' | 'identity' | 'authority' | 'sync' | 'bootstrap', DataSource>;

export let migration: DataSource;

export let runner: ProductTransactionRunner;

export let bindings: ProductBindingRegistry;

export let root: { id: IdentityId; stale: string };

export const service = (obligations: ProductObligationRegistry = productObligations) =>
  new ProductAuthorization(runner, audit, bindings, { validators, obligations }, [
    { resource: 'document', action: 'update', fields: ['title'] },
  ]);

/** A Root session with a step-up 5 s ago, as a 2FA verify leaves it. */
export async function freshRoot(): Promise<string> {
  return oidcSession(pools.identity, root.id, { fresh: true });
}

export type Event = readonly [
  string,
  string,
  string | null,
  string | null,
  Record<string, unknown>,
];

export const revision = () =>
  withClient(
    postgres.superuser,
    async (c) =>
      (await c.query<{ r: string }>('SELECT revision::text r FROM authz_state')).rows[0]!.r,
  );

export const events = () =>
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
export async function appended(work: () => Promise<unknown>) {
  const seen = new Set((await events()).map((e) => e.id));
  const before = await revision();
  await work();
  const added: Event[] = (await events())
    .filter((e) => !seen.has(e.id))
    .map((e) => [e.kind, e.actor, e.permission, e.object, e.metadata] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return { before, after: await revision(), added };
}

export const title = async (id: string) =>
  (await migration.query<{ title: string }[]>('SELECT title FROM document WHERE id=$1', [id]))[0]!
    .title;

export async function setupStack(): Promise<void> {
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
  await new ProductManifestReconciler(runner, audit, {
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
}

export async function teardownStack(): Promise<void> {
  await migration?.destroy();
  for (const pool of Object.values(pools ?? {})) await pool.destroy();
  await postgres?.stop();
}

/** An active IAM account with one Google binding and a session, stepped up 5 s ago if `fresh`. */
export async function iamUser(fresh = false) {
  const id = randomUUID() as IdentityId;
  await migration.query(`INSERT INTO app_user(id,state,email_verified) VALUES($1,'active',true)`, [
    id,
  ]);
  await bindAccount(pools.identity, id);
  return { id, secret: await oidcSession(pools.identity, id, { fresh }) };
}

export const account = (id: string) =>
  migration.query<{ state: string; epoch: string }[]>(
    'SELECT state,auth_epoch::text epoch FROM app_user WHERE id=$1',
    [id],
  );
