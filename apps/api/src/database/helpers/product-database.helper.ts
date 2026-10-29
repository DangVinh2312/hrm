import type { DataSourceOptions } from 'typeorm';
import type { PostgresConnectionSettings } from '../postgres-connection.types.js';
import { ProductBaseline1792108800001 } from '../migrations/001-product-baseline.migration.js';
import { RoleRuntimeConstraint1792108800003 } from '../../modules/role/migrations/role-runtime-constraint.migration.js';
import { RoleAnchorLock1792108800004 } from '../../modules/role/migrations/role-anchor-lock.migration.js';
import { ApplicationBaseline1792108800002 } from '../migrations/002-application-baseline.migration.js';

export type ProductDatabasePurpose =
  'data' | 'identity' | 'authority' | 'sync' | 'migration' | 'bootstrap' | 'outbox';

export const productFunctionOwners = [
  'product_fence_owner',
  'product_session_owner',
  'product_object_owner',
  'product_account_owner',
] as const;

/** Identity and authority schema and the runtime-role constraints on it; provisioning and the offline CLI apply it first. */
export const productMigrations = [ProductBaseline1792108800001, RoleRuntimeConstraint1792108800003];

/** Product baseline, then the application baseline (Document fixture and HR) and what is built on it; the one list every caller shares. */
export const allMigrations = [
  ...productMigrations,
  ApplicationBaseline1792108800002,
  RoleAnchorLock1792108800004,
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
