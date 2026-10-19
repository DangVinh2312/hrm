import { open, unlink } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { ReleaseRejectedError } from '../dist/authorization/helpers/release-content.helper.js';
import {
  canonicalLoginEmail,
  ProductIdentityService,
  purgeExpiredSessions,
} from '../dist/auth/services/product-identity.service.js';
import type { PostgresConnectionSettings } from '../dist/database/postgres-connection.types.js';
import {
  type ProductDatabasePurpose,
  productDataSourceOptions,
  productMigrations,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { resetProductMfa } from '../dist/auth/services/product-mfa.service.js';
import {
  ProductManifestReconciler,
  bootstrapProductRoot,
  revokeProductRoot,
  reissueRootActivation,
  setRootEmail,
} from '../dist/authorization/services/product-manifest.service.js';

import {
  PRODUCT_OFFLINE_ACTOR,
  appendProductAudit,
} from '../dist/audit/product-audit.repository.js';
import { productObligations } from '../dist/authorization/helpers/product-obligations.helper.js';

import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { ProductDocument1792108800002 } from '../dist/document/migrations/product-document.migration.js';
import { HrmAuthorization1792108800100 } from '../dist/hr/migrations/hrm-authorization.migration.js';
import { HrmEmployee1792108800101 } from '../dist/employee/migrations/hrm-employee.migration.js';
import { HrmTeam1792108800102 } from '../dist/team/migrations/hrm-team.migration.js';
import { ensureHrCompany } from '../dist/hr/hr-database.helper.js';
import { adminConnection, requireEnv } from './env.ts';

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

/**
 * Application migrations after the product ones. HR installs a SECURITY DEFINER function owned by
 * a NOLOGIN role, so a database first gets it through `provision` (temporary owner membership);
 * `migrate` alone is refused for it like other owner-changing migrations.
 */
const migrations = [
  ...productMigrations,
  ProductDocument1792108800002,
  HrmAuthorization1792108800100,
  HrmEmployee1792108800101,
  HrmTeam1792108800102,
];

// Same codec composition as the API runtime (apps/api authorization/product-manifest).
const core = createProductAuthorizationCore();
const { isCanonicalUuid } = core;
const [command, ...rawArgs] = process.argv.slice(2);
// `pnpm run <script> -- --flag value` (pnpm 12) forwards the end-of-options marker literally.
// Only a single leading `--` is dropped; anywhere else it stays an invalid flag.
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!key?.startsWith('--') || !value || Object.hasOwn(flags, key))
    throw new Error('Expected unique --option value pairs');
  flags[key] = value;
}
const sources: DataSource[] = [];

async function source(purpose: string): Promise<DataSource> {
  const ds = await new DataSource(
    productDataSourceOptions(connection(`PRODUCT_${purpose.toUpperCase()}_DATABASE_URL`)),
  ).initialize();
  sources.push(ds);
  return ds;
}

try {
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
    await provisionProductDatabase({ ...admin, database: name }, passwords, migrations);
    console.log('Product database provisioned; credentials are never printed.');
  } else if (command === 'migrate') {
    const settings = connection('PRODUCT_MIGRATION_DATABASE_URL');
    const ds = await new DataSource({
      ...productDataSourceOptions(settings),
      migrations,
    }).initialize();
    sources.push(ds);
    const applied = await ds.runMigrations({ transaction: 'each' });
    console.log(`Applied ${applied.length} forward migrations.`);
  } else if (command === 'sync') {
    const sync = await source('sync');
    const runner = new ProductTransactionRunner({ sync });
    await new ProductManifestReconciler(runner, {
      core,
      actor: PRODUCT_OFFLINE_ACTOR,
      capabilities: {
        validators: ['fresh@1'],
        obligationHandlers: Object.keys(productObligations),
      },
    }).reconcile(createProductRelease(core));
    // Same code-owned HR company anchor the API ensures at boot (needs the synced hrCompany type).
    await runner.run('sync', (tx) => ensureHrCompany(tx));
    console.log('Manifest synchronized.');
  } else if (command === 'enroll' || command === 'invite') {
    const userId = flags['--user'];
    if (!isCanonicalUuid(userId) || userId === PRODUCT_OFFLINE_ACTOR)
      throw new Error('--user must be an explicit canonical UUID, not the offline actor id');
    // ADR 0027 §2: Google OIDC is the only sign-in; `--method local` is gone.
    const method = flags['--method'];
    if (method !== 'oidc') throw new Error('--method oidc is required (sign-in is Google only)');
    const identity = await source('identity');
    const runner = new ProductTransactionRunner({ identity });
    // Invite without enrollment flags reissues an invitation for an existing pending account.
    const reissue =
      command === 'invite' && !flags['--email'] && !flags['--issuer'] && !flags['--subject'];
    // ADR 0020: `enroll --method oidc --email --issuer` (no --subject) waits for the first verified
    // Google login of that email for 7 days; --subject keeps the exact pre-bound path.
    const byEmail = command === 'enroll' && !flags['--subject'];
    const email = byEmail && !reissue ? canonicalLoginEmail(flags['--email'] || '') : null;
    if (!reissue && !flags['--issuer'])
      throw new Error('OIDC enrollment requires the exact --issuer');
    if (!reissue && !byEmail && (!flags['--subject'] || flags['--email']))
      throw new Error('OIDC invitation requires exact --subject (and no --email)');
    const artifact = command === 'invite' ? flags['--activation-file'] : undefined;
    if (command === 'invite' && !artifact) throw new Error('Invite requires --activation-file');
    const file = artifact ? await open(artifact, 'wx', 0o600) : undefined;
    let committed = false;
    try {
      const service = command === 'invite' ? new ProductIdentityService(runner) : undefined;
      const proof = await runner.run('revoke', async (tx) => {
        // issueActivation rechecks that the account is pending and fits the method.
        if (reissue) {
          const token = await service!.issueActivation(tx, userId);
          await appendProductAudit(tx, {
            kind: 'identity.invite',
            actor: PRODUCT_OFFLINE_ACTOR,
            target: { userId },
            method,
          });
          return token;
        }
        await tx.manager.query(
          `INSERT INTO app_user(id,email_canonical,state) VALUES($1,$2,'pending')`,
          [userId, email],
        );
        if (byEmail) {
          const enabled = await tx.manager.query<unknown[]>(
            'SELECT 1 FROM oidc_provider WHERE issuer=$1 AND enabled',
            [flags['--issuer']],
          );
          if (!enabled.length) throw new Error('--issuer must be an enabled provider');
          await tx.manager.query(
            `INSERT INTO oidc_email_enrollment(user_id,issuer,email_canonical,expires_at,created_by) VALUES($1,$2,$3,statement_timestamp()+interval '7 days',$4)`,
            [userId, flags['--issuer'], email, PRODUCT_OFFLINE_ACTOR],
          );
        } else
          await tx.manager.query(
            'INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)',
            [flags['--issuer'], flags['--subject'], userId],
          );
        await appendProductAudit(tx, {
          kind: 'identity.enroll',
          actor: PRODUCT_OFFLINE_ACTOR,
          target: { userId },
          method,
        });
        return service?.issueActivation(tx, userId);
      });
      committed = true;
      if (proof) await file!.writeFile(proof + '\n');
      console.log(
        reissue
          ? 'Invitation reissued for the pending account; no password or session created.'
          : byEmail
            ? 'Pending account enrolled for its first verified Google login within 7 days.'
            : 'Pending account enrolled; no password or session created.',
      );
    } finally {
      await file?.close();
      if (file && !committed) await unlink(artifact!).catch(() => undefined);
    }
  } else if (command === 'purge-sessions') {
    // Retention is a deployment decision: required, no default.
    const retention = flags['--retention-days'];
    if (!retention || !/^\d{1,4}$/.test(retention))
      throw new Error('--retention-days <0-3650> is required');
    const runner = new ProductTransactionRunner({ identity: await source('identity') });
    // Bounded run: at most 200 short transactions of 500 rows; rerun to continue.
    let deleted = 0;
    for (let batch = 0; batch < 200; batch++) {
      const n = await purgeExpiredSessions(runner, Number(retention), 500);
      deleted += n;
      if (n < 500) break;
    }
    console.log(`Purged ${deleted} expired sessions.`);
  } else if (command === 'bootstrap') {
    const userId = flags['--user'];
    const operationId = flags['--operation'];
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(operationId))
      throw new Error('Explicit canonical --user and --operation required');
    const method = flags['--method'];
    if (method !== 'oidc') throw new Error('--method oidc required (sign-in is Google only)');
    const path = flags['--activation-file'];
    if (!path) throw new Error('Bootstrap requires --activation-file outside the repository/logs');
    // Reserve the delivery artifact before mutating persistent state; never overwrite an old secret.
    const file = await open(path, 'wx', 0o600);
    let committed = false;
    try {
      const bootstrap = await source('bootstrap');
      const runner = new ProductTransactionRunner({ bootstrap });
      const result = await bootstrapProductRoot(runner, createProductRelease(core), {
        operationId,
        userId: userId as IdentityId,
        method,
        issuer: flags['--issuer'],
        subject: flags['--subject'],
      });
      committed = result.initialized;
      if (result.activationSecret) await file.writeFile(result.activationSecret + '\n');
      console.log(
        result.initialized
          ? 'Root enrollment committed; activation still required.'
          : 'Operation already committed; marker and Root unchanged.',
      );
    } finally {
      await file.close();
      if (!committed) await unlink(path).catch(() => undefined);
    }
  } else if (command === 'revoke-root') {
    const userId = flags['--user'];
    const operationId = flags['--operation'];
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(operationId))
      throw new Error('Explicit canonical --user and --operation required');
    if (!flags['--approval'] || !flags['--reason'])
      throw new Error('Root revocation requires --approval and --reason');
    const bootstrap = await source('bootstrap');
    const result = await revokeProductRoot(
      new ProductTransactionRunner({ bootstrap }),
      {
        operationId,
        userId: userId as IdentityId,
        approval: flags['--approval'],
        reason: flags['--reason'],
      },
      core,
    );
    console.log(
      result.revoked
        ? 'Root suspended and its sessions revoked; marker unchanged.'
        : 'No unsuspended Root for this user; nothing changed.',
    );
  } else if (command === 'set-root-email') {
    // ADR 0023 §4: Root enrolled by subject only; the email stays unverified until Google proves it.
    const userId = flags['--user'];
    const operationId = flags['--operation'];
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(operationId))
      throw new Error('Explicit canonical --user and --operation required');
    if (!flags['--email']) throw new Error('--email required');
    const bootstrap = await source('bootstrap');
    const result = await setRootEmail(
      new ProductTransactionRunner({ bootstrap }),
      { operationId, userId: userId as IdentityId, email: flags['--email'] },
      core,
    );
    console.log(
      result.changed
        ? 'Root email set, unverified until the next verified Google sign-in; its sessions ended.'
        : 'Root already has this email; nothing changed.',
    );
  } else if (command === 'reissue-root') {
    const userId = flags['--user'];
    const method = flags['--method'];
    const path = flags['--activation-file'];
    if (!isCanonicalUuid(userId)) throw new Error('Explicit canonical --user required');
    if (method !== 'oidc') throw new Error('--method oidc required (sign-in is Google only)');
    if (!path) throw new Error('Reissue requires --activation-file outside the repository/logs');
    const file = await open(path, 'wx', 0o600);
    let committed = false;
    try {
      const bootstrap = await source('bootstrap');
      const result = await reissueRootActivation(
        new ProductTransactionRunner({ bootstrap }),
        {
          userId: userId as IdentityId,
          method,
          issuer: flags['--issuer'],
          subject: flags['--subject'],
        },
        core,
      );
      committed = true;
      await file.writeFile(result.activationSecret + '\n');
      console.log('Root activation proof reissued; earlier proofs are void.');
    } finally {
      await file.close();
      if (!committed) await unlink(path).catch(() => undefined);
    }
  } else if (command === 'reset-mfa' || command === 'reset-root-mfa') {
    // ADR 0026 §10: an account lost both its authenticator and its recovery codes. IAM accounts
    // with the identity credential, the Root with the bootstrap credential; approval required.
    const userId = flags['--user'];
    const operationId = flags['--operation'];
    if (!isCanonicalUuid(userId) || !isCanonicalUuid(operationId))
      throw new Error('Explicit canonical --user and --operation required');
    if (!flags['--approval'] || !flags['--reason'])
      throw new Error('Second factor reset requires --approval and --reason');
    const login = command === 'reset-root-mfa' ? 'bootstrap' : 'identity';
    const result = await resetProductMfa(
      new ProductTransactionRunner({ [login]: await source(login) }),
      { operationId, userId, approval: flags['--approval'], reason: flags['--reason'] },
      core,
      login,
    );
    console.log(
      result.reset
        ? 'Second factor and recovery codes removed; the account sessions ended.'
        : 'No second factor; nothing changed.',
    );
  } else
    throw new Error(
      'Expected provision|migrate|sync|enroll|invite|purge-sessions|bootstrap|revoke-root|set-root-email|reissue-root|reset-mfa|reset-root-mfa',
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
