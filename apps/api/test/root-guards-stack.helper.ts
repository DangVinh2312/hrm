import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import { ProductIdentityService } from '../dist/auth/services/product-identity.service.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { bootstrapProductRoot } from '../dist/authorization/services/product-root.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  createProductAuthorizationCore,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { startPostgres, type TestPostgres } from './setup-postgres.ts';
import { fixtureProvider, FIXTURE_ISSUER } from './oidc-fixture.helper.ts';

export const core = createProductAuthorizationCore();

export const release = prepareProductRelease(productReleaseSource, core);

export type Runtime = 'data' | 'identity' | 'authority' | 'sync' | 'bootstrap';

/** A provisioned disposable database with every runtime pool, one active IAM member and a Root. */
export interface RootGuardsStack {
  pg: TestPostgres;
  connections: Awaited<ReturnType<typeof provisionProductDatabase>>;
  pools: Record<Runtime, DataSource>;
  migration: DataSource;
  runner: ProductTransactionRunner;
  identity: ProductIdentityService;
  member: IdentityId;
  root: IdentityId;
  activationSecret: string;

  stop(): Promise<void>;
}

export async function startRootGuardsStack(): Promise<RootGuardsStack> {
  const pg = await startPostgres();
  const passwords = Object.fromEntries(
    ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'].map((p) => [
      p,
      randomBytes(24).toString('hex'),
    ]),
  ) as Record<ProductDatabasePurpose, string>;
  const connections = await provisionProductDatabase(pg.superuser, passwords);
  const pools = {} as Record<Runtime, DataSource>;
  for (const p of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const)
    pools[p] = await new DataSource(productDataSourceOptions(connections[p])).initialize();
  const migration = await new DataSource(
    productDataSourceOptions(connections.migration),
  ).initialize();
  await fixtureProvider(migration);
  const runner = new ProductTransactionRunner(pools);
  await new ProductManifestReconciler(runner, {
    core,
    actor: randomUUID() as IdentityId,
    capabilities: release.declarations.capabilities,
  }).reconcile(release);
  const member = randomUUID() as IdentityId;
  await migration.query(
    `INSERT INTO app_user(id,email_canonical,state,email_verified) VALUES($1,'member@example.test','active',true)`,
    [member],
  );
  const result = await bootstrapProductRoot(runner, release, {
    operationId: randomUUID(),
    issuer: FIXTURE_ISSUER,
    email: 'root@example.test',
  });
  return {
    pg,
    connections,
    pools,
    migration,
    runner,
    identity: new ProductIdentityService(runner),
    member,
    root: result.userId,
    activationSecret: result.activationSecret ?? '',
    async stop() {
      await migration.destroy();
      for (const pool of Object.values(pools)) await pool.destroy();
      await pg.stop();
    },
  };
}
