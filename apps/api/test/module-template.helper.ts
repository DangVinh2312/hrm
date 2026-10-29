import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import type { PostgresConnectionSettings } from '../dist/database/postgres-connection.types.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  allMigrations,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { PermissionObjectRepository } from '../dist/modules/permission/permission-object.repository.js';
import { treeDigest } from './postgres-shared.helper.ts';
import { fixtureProvider } from './oidc-fixture.helper.ts';
import type { TestPostgres, TestTemplate } from './setup-postgres.ts';

export type ProductPurposes = Record<ProductDatabasePurpose, PostgresConnectionSettings>;

/** The `product_*` logins of the database `pg.superuser` points at (roles exist after provisioning). */
export function productConnections(pg: TestPostgres): ProductPurposes {
  return Object.fromEntries(
    (Object.keys(pg.passwords) as ProductDatabasePurpose[]).map((purpose) => [
      purpose,
      { ...pg.superuser, username: `product_${purpose}`, password: pg.passwords[purpose] },
    ]),
  ) as ProductPurposes;
}

/**
 * Digest of every compiled file plus the fixtures the build uses, so any change to a migration,
 * the manifest/release or the sync code names a new template and the old one is never reused.
 */
let digest: string | undefined;

function sourceDigest(): string {
  digest ??= treeDigest(
    [
      fileURLToPath(new URL('../dist/', import.meta.url)),
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./oidc-fixture.helper.ts', import.meta.url)),
    ],
    ['.js', '.ts'],
  );
  return digest;
}

/**
 * Every product + HR migration applied, release synced, OIDC fixture provider, company and
 * calendar anchors: everything startModuleStack needs before its per-file Root and people.
 */
export const moduleTemplate: TestTemplate = {
  get name() {
    return `module_${sourceDigest().slice(0, 16)}`;
  },
  build: async (pg) => {
    const connections = await provisionProductDatabase(pg.superuser, pg.passwords, allMigrations);
    const opened: DataSource[] = [];
    try {
      const pools = {} as Record<
        'data' | 'identity' | 'authority' | 'sync' | 'bootstrap',
        DataSource
      >;
      for (const purpose of ['data', 'identity', 'authority', 'sync', 'bootstrap'] as const) {
        pools[purpose] = await new DataSource(
          productDataSourceOptions(connections[purpose]),
        ).initialize();
        opened.push(pools[purpose]);
      }
      const migration = await new DataSource(
        productDataSourceOptions(connections.migration),
      ).initialize();
      opened.push(migration);
      const runner = new ProductTransactionRunner(pools);
      const core = createProductAuthorizationCore();
      const release = createProductRelease(core);
      await fixtureProvider(migration);
      await new ProductManifestReconciler(runner, new ProductAuditRepository(), {
        core,
        actor: randomUUID() as IdentityId,
        capabilities: release.declarations.capabilities,
      }).reconcile(release);
      const permissionObject = new PermissionObjectRepository();
      await runner.run('sync', (tx) => permissionObject.ensureCompany(tx));
      await runner.run('sync', (tx) => permissionObject.ensureWorkCalendar(tx));
      await runner.run('sync', (tx) => permissionObject.ensureSetting(tx));
      await runner.run('sync', (tx) => permissionObject.ensureRole(tx));
    } finally {
      for (const source of opened) await source.destroy().catch(() => undefined);
    }
  },
};
