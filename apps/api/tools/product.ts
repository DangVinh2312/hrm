import { DataSource } from 'typeorm';
import { ReleaseRejectedError } from '../dist/authorization/helpers/release-content.helper.js';
import { purgeExpiredSessions } from '../dist/authentication/services/product-identity.service.js';
import type { PostgresConnectionSettings } from '../dist/database/postgres-connection.types.js';
import {
  type ProductDatabasePurpose,
  allMigrations,
  productDataSourceOptions,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { ProductManifestReconciler } from '../dist/authorization/services/product-manifest.service.js';
import {
  PRODUCT_OFFLINE_ACTOR,
  ProductAuditRepository,
} from '../dist/audit/product-audit.repository.js';
import { createProductObligations } from '../dist/authorization/services/product-obligation.service.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { PermissionObjectRepository } from '../dist/modules/permission/permission-object.repository.js';
import { adminConnection, requireEnv } from './env.ts';
import type { Cli } from './cli.ts';
import { enrollAccount } from './identity-commands.ts';
import {
  bootstrapRoot,
  reissueRoot,
  resetMfa,
  revokeRoot,
  setEmailOfRoot,
} from './root-commands.ts';

/** CLI composition root: one audit repository, passed to every command. */
const audit = new ProductAuditRepository();

function connection(variable: string): PostgresConnectionSettings {
  try {
    const u = new URL(requireEnv(variable));
    if (
      !['postgres:', 'postgresql:'].includes(u.protocol) ||
      !u.username ||
      !u.hostname ||
      u.pathname.length < 2
    )
      throw new Error();
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.slice(1)),
    };
  } catch {
    throw new Error(`${variable} must be a PostgreSQL URL`);
  }
}

// Same codec composition as the API runtime (apps/api authorization/product-manifest).
const core = createProductAuthorizationCore();
const [command, ...rawArgs] = process.argv.slice(2);
// `pnpm run <script> -- --flag value` (pnpm 12) forwards the end-of-options marker literally.
// Only a single leading `--` is dropped; anywhere else it stays an invalid flag.
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
// Each command takes exactly these flags; any other (e.g. the removed --method, --subject) is refused.
const allowedFlags: Readonly<Record<string, readonly string[]>> = {
  provision: [],
  migrate: [],
  sync: [],
  enroll: ['--user', '--email', '--issuer'],
  'purge-sessions': ['--retention-days'],
  bootstrap: ['--operation', '--issuer', '--email', '--activation-file'],
  'revoke-root': ['--user', '--operation', '--approval', '--reason'],
  'set-root-email': ['--user', '--operation', '--email'],
  'reissue-root': ['--issuer', '--activation-file'],
  'reset-mfa': ['--user', '--operation', '--approval', '--reason'],
  'reset-root-mfa': ['--user', '--operation', '--approval', '--reason'],
};
const flags: Record<string, string> = {};

/** Inside the try below, so a bad option ends in the redacted failure line like any other error. */
function readFlags(): void {
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith('--') || !value || Object.hasOwn(flags, key))
      throw new Error('Expected unique --option value pairs');
    if (!allowedFlags[command ?? '']?.includes(key)) throw new Error(`Unexpected option ${key}`);
    flags[key] = value;
  }
}

const sources: DataSource[] = [];

async function source(purpose: string): Promise<DataSource> {
  const ds = await new DataSource(
    productDataSourceOptions(connection(`PRODUCT_${purpose.toUpperCase()}_DATABASE_URL`)),
  ).initialize();
  sources.push(ds);
  return ds;
}

const cli: Cli = { flags, core, audit, source };

try {
  readFlags();
  if (command === 'provision') {
    const admin = adminConnection();
    const name = requireEnv('PRODUCT_DATABASE_NAME');
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('Invalid PRODUCT_DATABASE_NAME');
    const control = await new DataSource(
      productDataSourceOptions({ ...admin, database: 'postgres' }),
    ).initialize();
    sources.push(control);
    if (
      !(await control.query<unknown[]>('SELECT 1 FROM pg_database WHERE datname=$1', [name])).length
    )
      await control.query(`CREATE DATABASE "${name}"`);
    const purposes = [
      'data',
      'identity',
      'authority',
      'sync',
      'migration',
      'bootstrap',
      'outbox',
    ] as const;
    const passwords = Object.fromEntries(
      purposes.map((p) => [p, requireEnv(`PRODUCT_${p.toUpperCase()}_PASSWORD`)]),
    ) as Record<ProductDatabasePurpose, string>;
    await provisionProductDatabase({ ...admin, database: name }, passwords, allMigrations);
    console.log('Product database provisioned; credentials are never printed.');
  } else if (command === 'migrate') {
    const settings = connection('PRODUCT_MIGRATION_DATABASE_URL');
    const ds = await new DataSource({
      ...productDataSourceOptions(settings),
      migrations: allMigrations,
    }).initialize();
    sources.push(ds);
    const applied = await ds.runMigrations({ transaction: 'each' });
    console.log(`Applied ${applied.length} forward migrations.`);
  } else if (command === 'sync') {
    const sync = await source('sync');
    const runner = new ProductTransactionRunner({ sync });
    await new ProductManifestReconciler(runner, audit, {
      core,
      actor: PRODUCT_OFFLINE_ACTOR,
      capabilities: {
        validators: ['fresh@1'],
        obligationHandlers: Object.keys(createProductObligations(audit)),
      },
    }).reconcile(createProductRelease(core));
    // Same code-owned HR company, calendar and settings anchors the API ensures at boot (need the synced types).
    const permissionObject = new PermissionObjectRepository();
    await runner.run('sync', (tx) => permissionObject.ensureCompany(tx));
    await runner.run('sync', (tx) => permissionObject.ensureWorkCalendar(tx));
    await runner.run('sync', (tx) => permissionObject.ensureSetting(tx));
    await runner.run('sync', (tx) => permissionObject.ensureRole(tx));
    console.log('Manifest synchronized.');
  } else if (command === 'enroll') {
    await enrollAccount(cli);
  } else if (command === 'purge-sessions') {
    // Retention is a deployment decision: required, no default.
    const retention = flags['--retention-days'];
    if (!retention || !/^\d{1,4}$/.test(retention))
      throw new Error('--retention-days <0-3650> is required');
    const runner = new ProductTransactionRunner({ identity: await source('identity') });
    // Bounded run: at most 200 short transactions of 500 rows; rerun to continue.
    let deleted = 0;
    for (let batch = 0; batch < 200; batch++) {
      const n = await purgeExpiredSessions(runner, audit, Number(retention), 500);
      deleted += n;
      if (n < 500) break;
    }
    console.log(`Purged ${deleted} expired sessions.`);
  } else if (command === 'bootstrap') {
    await bootstrapRoot(cli);
  } else if (command === 'revoke-root') {
    await revokeRoot(cli);
  } else if (command === 'set-root-email') {
    await setEmailOfRoot(cli);
  } else if (command === 'reissue-root') {
    await reissueRoot(cli);
  } else if (command === 'reset-mfa' || command === 'reset-root-mfa') {
    await resetMfa(cli, command);
  } else
    throw new Error(
      'Expected provision|migrate|sync|enroll|purge-sessions|bootstrap|revoke-root|set-root-email|reissue-root|reset-mfa|reset-root-mfa',
    );
} catch (error) {
  // Class, release reason enum and SQLSTATE only: messages and driver details may carry secrets or PII.
  const detail = error as { code?: unknown; driverError?: { code?: unknown } } | null;
  const parts = [
    error instanceof Error ? error.constructor.name : typeof error,
    error instanceof ReleaseRejectedError ? error.reason : undefined,
    detail?.driverError?.code ?? detail?.code,
  ].filter((p): p is string => typeof p === 'string');
  console.error(
    `Product operation failed (${parts.join(' ')}); no secrets are printed. Check inputs, privileges and migration/data mapping requirements.`,
  );
  process.exitCode = 1;
} finally {
  await Promise.all(sources.map((ds) => ds.destroy()));
}
