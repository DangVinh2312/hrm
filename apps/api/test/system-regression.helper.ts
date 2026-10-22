import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  type ProductDatabasePurpose,
  provisionProductDatabase,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';
import { productDeclarations } from '../dist/authorization/product.manifest.js';
import { core } from './core/fixtures.ts';
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

let fixture: TestPostgres | undefined;
let fixtureNumber = 0;

const superuser = () => {
  if (!fixture) throw new Error('startRegressionPostgres first');
  return fixture.superuser;
};

export const startRegressionPostgres = async (): Promise<void> => {
  fixture = await startPostgres();
};

export const stopRegressionPostgres = async (): Promise<void> => {
  await fixture?.stop();
};

const passwords = Object.fromEntries(
  ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'].map((p) => [
    p,
    randomBytes(24).toString('hex'),
  ]),
) as Record<ProductDatabasePurpose, string>;
export const actor = randomUUID() as IdentityId;

export const base = {
  sequence: '1',
  predecessor: '0',
  declarations: productDeclarations,
  roles: [{ key: 'reviewer', label: 'Reviewer' }],
  defaultGrants: [
    {
      permission: 'document.read',
      role: 'reviewer',
      template: { key: 'ownedDocuments', version: 1 },
      parameters: {},
    },
  ],
  seeds: [],
  removeSeeds: [],
  boundaryBindings: [],
  removeBoundaryBindings: [],
};

export async function withProduct(
  run: (
    reconciler: ProductManifestReconciler,
    migration: DataSource,
    settings: Awaited<ReturnType<typeof provisionProductDatabase>>,
  ) => Promise<void>,
): Promise<void> {
  const database = `system_regression_${++fixtureNumber}`;
  await withClient(superuser(), (c) => c.query(`CREATE DATABASE ${database}`));
  const settings = await provisionProductDatabase({ ...superuser(), database }, passwords);
  const sync = await new DataSource(productDataSourceOptions(settings.sync)).initialize();
  const migration = await new DataSource(productDataSourceOptions(settings.migration)).initialize();
  try {
    const reconciler = new ProductManifestReconciler(
      new ProductTransactionRunner({ sync }),
      audit,
      {
        core,
        actor,
        capabilities: { validators: ['fresh@1'], obligationHandlers: ['audit@1'] },
      },
    );
    await reconciler.reconcile(prepareProductRelease(base, core));
    await run(reconciler, migration, settings);
  } finally {
    await migration.destroy();
    await sync.destroy();
  }
}

export async function offlineAlter(
  migration: DataSource,
  sql: string,
  parameters: unknown[] = [],
): Promise<void> {
  await migration.query('ALTER TABLE policy_rule DISABLE TRIGGER protect_product_rows');
  try {
    await migration.query(sql, parameters);
  } finally {
    await migration.query('ALTER TABLE policy_rule ENABLE TRIGGER protect_product_rows');
  }
}
