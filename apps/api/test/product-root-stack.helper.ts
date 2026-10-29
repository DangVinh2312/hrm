import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { ProductAuthorization } from '../dist/authorization/services/product-authority.service.js';
import { ProductAccountService } from '../dist/authorization/services/product-account.service.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
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
import { documentFixtureSql } from '../dist/database/migrations/002-application-baseline.migration.js';
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

// The release plus one account boundary (the real one ships with ADR-13 D5), so the IAM account
// commands (grant + required boundary) exist.
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
            {
              permission: 'account.reactivate',
              contextRequirements: [],
              requiredScope: { op: 'constant', value: true },
            },
            {
              permission: 'account.assignRole',
              contextRequirements: [],
              requiredScope: { op: 'constant', value: true },
            },
            {
              permission: 'account.revokeRole',
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

export const accounts = (obligations: ProductObligationRegistry = productObligations) =>
  new ProductAccountService(service(obligations), audit, bindings);

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
  await qr.query(documentFixtureSql);
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

export interface GrantSpec {
  readonly permission: string;
  readonly template?: string;
  readonly parameters?: Record<string, string | boolean>;
  readonly effect?: 'allow' | 'deny';
}

const ruleSql =
  "INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,$2,$3,$4,$5,1,$6,'runtime')";

const ruleParameters = (role: string, spec: GrantSpec) => [
  randomUUID(),
  utf8(spec.permission),
  utf8(role),
  spec.effect ?? 'allow',
  utf8(spec.template ?? 'allAccounts'),
  JSON.stringify(spec.parameters ?? {}),
];

/**
 * Gives `userId` the grants through ONE runtime role (the only kind of grant the grant-set
 * comparison can prove; a rule attached to the user is refused). Grants default to
 * the `allAccounts` template with no parameters; another template or parameters make the grant
 * incomparable with the same permission elsewhere.
 */
export async function grantViaRole(
  userId: string,
  grants: readonly (string | GrantSpec)[],
): Promise<string> {
  const role = `custom.${randomBytes(6).toString('hex')}`;
  const denies: GrantSpec[] = [];
  await runner.run('admin', async (tx) => {
    await tx.manager.query(
      "INSERT INTO role_definition(role_key,managed_by,label) VALUES($1,'runtime',$2)",
      [utf8(role), role],
    );
    for (const grant of grants) {
      const spec: GrantSpec = typeof grant === 'string' ? { permission: grant } : grant;
      if (spec.effect === 'deny') {
        denies.push(spec);
        continue;
      }
      await tx.manager.query(ruleSql, ruleParameters(role, spec));
    }
    await tx.manager.query('INSERT INTO user_role(user_id,role_key) VALUES($1,$2)', [
      userId,
      utf8(role),
    ]);
  });
  // The authority login writes allow rules only; a deny fixture is seeded by the owner login.
  for (const spec of denies) await migration.query(ruleSql, ruleParameters(role, spec));
  return role;
}

/** Binds the `accountAll` boundary of this stack's release to `userId` for each permission. */
export async function bindAccountBoundary(userId: string, permissions: readonly string[]) {
  await runner.run('admin', async (tx) => {
    for (const permission of permissions)
      await tx.manager.query(
        'INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,$2,$3,1)',
        [userId, utf8(permission), utf8('accountAll')],
      );
  });
}
