import type { DataSourceOptions } from 'typeorm';
import type { PostgresConnectionSettings } from '../postgres-connection.types.js';
import { ProductInitial1792108800000 } from '../migrations/001-initial.migration.js';
import { ProductProtection1792108800001 } from '../migrations/002-protection.migration.js';
import { ProductUserRelationVersion1792108800003 } from '../migrations/003-user-relation-version.migration.js';
import { ProductProtectionGuards1792108800004 } from '../migrations/004-protection-guards.migration.js';
import { ProductOidcActivation1792108800005 } from '../migrations/005-oidc-activation.migration.js';
import { ProductAccountRank1792108800006 } from '../migrations/006-account-rank.migration.js';
import { ProductRootMarker1792108800007 } from '../migrations/007-root-marker.migration.js';
import { ProductSystemActivation1792108800008 } from '../migrations/008-system-activation.migration.js';
import { ProductSessionExpiryIndex1792108800009 } from '../migrations/009-session-expiry-index.migration.js';
import { ProductAuditOutboxDelivery1792108800010 } from '../migrations/010-audit-outbox-delivery.migration.js';
import { ProductAuditOutboxPendingIndex1792108800011 } from '../migrations/011-audit-outbox-pending-index.migration.js';
import { ProductIamRoot1792108800012 } from '../migrations/012-iam-root.migration.js';
import { ProductOidcEmailEnrollment1792108800013 } from '../migrations/013-oidc-email-enrollment.migration.js';
import { ProductSignInMethods1792108800014 } from '../migrations/014-sign-in-methods.migration.js';
import { ProductRootEmail1792108800015 } from '../migrations/015-root-email.migration.js';
import { ProductMfaTotp1792108800016 } from '../migrations/016-mfa-totp.migration.js';
import { ProductSingleGoogleBinding1792108800017 } from '../migrations/017-single-google-binding.migration.js';
import { ProductGoogleOnly1792108800018 } from '../migrations/018-google-only.migration.js';
import { ProductRootEmailBootstrap1792108800019 } from '../migrations/019-root-email-bootstrap.migration.js';
import { ProductIdentityTokenInsert1792108800020 } from '../migrations/020-identity-token-insert.migration.js';

export type ProductDatabasePurpose =
  'data' | 'identity' | 'authority' | 'sync' | 'migration' | 'bootstrap' | 'outbox';

export const productFunctionOwners = [
  'product_fence_owner',
  'product_session_owner',
  'product_object_owner',
  'product_account_owner',
] as const;

export const productMigrations = [
  ProductInitial1792108800000,
  ProductProtection1792108800001,
  ProductUserRelationVersion1792108800003,
  ProductProtectionGuards1792108800004,
  ProductOidcActivation1792108800005,
  ProductAccountRank1792108800006,
  ProductRootMarker1792108800007,
  ProductSystemActivation1792108800008,
  ProductSessionExpiryIndex1792108800009,
  ProductAuditOutboxDelivery1792108800010,
  ProductAuditOutboxPendingIndex1792108800011,
  ProductIamRoot1792108800012,
  ProductOidcEmailEnrollment1792108800013,
  ProductSignInMethods1792108800014,
  ProductRootEmail1792108800015,
  ProductMfaTotp1792108800016,
  ProductSingleGoogleBinding1792108800017,
  ProductGoogleOnly1792108800018,
  ProductRootEmailBootstrap1792108800019,
  ProductIdentityTokenInsert1792108800020,
];

export function productDataSourceOptions(
  connection: PostgresConnectionSettings,
): DataSourceOptions {
  return {
    type: 'postgres',
    ...connection,
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'each',
    logging: false,
    extra: { connectionTimeoutMillis: 1000, max: 10 },
    entities: [],
    migrations: productMigrations,
  };
}

/**
 * `grantee`-filtered grants on every table, column and function in a non-system schema (objects
 * outside public are reported schema-qualified), plus schema grants when `withSchemas`.
 */
export const grantsOf = (grantees: string, withSchemas: boolean) =>
  `WITH schemas AS (SELECT oid,nspname,CASE WHEN nspname='public' THEN '' ELSE nspname||'.' END AS prefix FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%'),
      acl AS (
        ${withSchemas ? `SELECT 'schema:'||q.nspname AS object,a.privilege_type,a.is_grantable,a.grantee FROM pg_namespace n JOIN schemas q ON q.oid=n.oid,aclexplode(n.nspacl) a UNION ALL` : ''}
        SELECT 'table:'||q.prefix||c.relname AS object,a.privilege_type,a.is_grantable,a.grantee
          FROM pg_class c JOIN schemas q ON q.oid=c.relnamespace,aclexplode(c.relacl) a
        UNION ALL
        SELECT 'column:'||q.prefix||c.relname||'.'||t.attname,a.privilege_type,a.is_grantable,a.grantee
          FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid JOIN schemas q ON q.oid=c.relnamespace,
          aclexplode(t.attacl) a WHERE t.attnum>0 AND NOT t.attisdropped
        UNION ALL
        SELECT 'function:'||q.prefix||p.proname||'('||oidvectortypes(p.proargtypes)||')',a.privilege_type,a.is_grantable,a.grantee
          FROM pg_proc p JOIN schemas q ON q.oid=p.pronamespace,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)
      SELECT DISTINCT object||':'||privilege_type||CASE WHEN is_grantable THEN '+grant' ELSE '' END AS grant
        FROM acl WHERE grantee IN (${grantees})`;
