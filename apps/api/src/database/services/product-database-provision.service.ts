import { DataSource } from 'typeorm';
import type { PostgresConnectionSettings } from '../postgres-connection.types.js';
import {
  productDataSourceOptions,
  productFunctionOwners,
  productMigrations,
  type ProductDatabasePurpose,
} from '../helpers/product-database.helper.js';

/**
 * Offline provisioning only; this credential must never be wired into the API. `migrations` is
 * the forward list to run (default: all). Upgrade rehearsals pass a prefix, e.g. up to 011.
 */
export async function provisionProductDatabase(
  admin: PostgresConnectionSettings,
  passwords: Readonly<Record<ProductDatabasePurpose, string>>,
  migrations: readonly (typeof productMigrations)[number][] = productMigrations,
): Promise<Record<ProductDatabasePurpose, PostgresConnectionSettings>> {
  const source = await new DataSource(productDataSourceOptions(admin)).initialize();
  const connections = {} as Record<ProductDatabasePurpose, PostgresConnectionSettings>;
  try {
    for (const purpose of [
      'data',
      'identity',
      'authority',
      'sync',
      'migration',
      'bootstrap',
      'outbox',
    ] as const) {
      const password = passwords[purpose];
      if (!password || password.includes('\0')) throw new TypeError('Missing product credential');
      const existing = await source.query<
        {
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolbypassrls: boolean;
          rolreplication: boolean;
          rolcanlogin: boolean;
        }[]
      >(
        'SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolcanlogin FROM pg_roles WHERE rolname=$1',
        [`product_${purpose}`],
      );
      if (
        existing[0] &&
        (existing[0].rolsuper ||
          existing[0].rolcreatedb ||
          existing[0].rolcreaterole ||
          existing[0].rolbypassrls ||
          existing[0].rolreplication ||
          !existing[0].rolcanlogin)
      )
        throw new Error('Existing product role has unsafe capabilities');
      // PostgreSQL utility statements do not accept bind parameters; quote literals explicitly.
      if (!existing[0]) {
        try {
          await source.query(
            `CREATE ROLE product_${purpose} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD E'${password.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`,
          );
        } catch {
          throw new Error('Unable to provision product credential');
        }
      }
      connections[purpose] = { ...admin, username: `product_${purpose}`, password };
    }
    // NOLOGIN owners of SECURITY DEFINER functions; product_object_owner owns application
    // object-registration functions (ADR 0016 §4) and only gets INSERT on object_ref;
    // product_account_owner owns OIDC account provisioning and its projection (ADR 0020).
    for (const owner of productFunctionOwners) {
      const exists = await source.query<{ present: boolean }[]>(
        'SELECT EXISTS(SELECT FROM pg_roles WHERE rolname=$1) AS present',
        [owner],
      );
      if (exists[0]?.present) {
        const [ownerState] = await source.query<{ unsafe: boolean }[]>(
          `SELECT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication) unsafe FROM pg_roles WHERE rolname=$1`,
          [owner],
        );
        if (ownerState?.unsafe) throw new Error('Existing function owner has unsafe capabilities');
      }
      if (!exists[0]?.present)
        await source.query(
          `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
    }
    await source.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    // Runtime logins need no temp objects; one session's temp table would otherwise trip another
    // replica's ownership probe.
    await source.query(
      "DO $$BEGIN EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC',current_database()); END$$",
    );
    await source.query(
      'GRANT USAGE ON SCHEMA public TO product_data,product_identity,product_authority,product_sync,product_bootstrap,product_outbox',
    );
    await source.query(
      `GRANT USAGE,CREATE ON SCHEMA public TO product_migration,${productFunctionOwners.join(',')}`,
    );
    await source.query(
      `GRANT ${productFunctionOwners.join(',')} TO product_migration WITH ADMIN OPTION`,
    );
    const migration = await new DataSource({
      ...productDataSourceOptions(connections.migration),
      migrations: [...migrations],
    }).initialize();
    try {
      await migration.runMigrations({ transaction: 'each' });
    } finally {
      await migration.destroy();
      await source.query(`REVOKE ${productFunctionOwners.join(',')} FROM product_migration`);
      await source.query(`REVOKE CREATE ON SCHEMA public FROM ${productFunctionOwners.join(',')}`);
    }
    return connections;
  } finally {
    await source.destroy();
  }
}
