import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { ProductDatabasePurpose } from '../dist/database/helpers/product-database.helper.js';
import {
  parseSharedEnv,
  quoteIdentifier,
  sharedDatabaseName,
  sharedEnvName,
  type SharedPostgresEnv,
} from './postgres-shared.helper.ts';

/** Pinned image; bump deliberately together with compose.yaml. */
export const postgresImage = 'postgres:18.4';

export interface Connection {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface TestPostgres {
  /** Non-superuser provisioning principal (LOGIN CREATEDB CREATEROLE), like production. */
  admin: Connection;
  superuser: Connection;
  /**
   * Passwords for the `product_*` logins. Roles are cluster-wide with names fixed in the migrations
   * and `provisionProductDatabase` keeps an existing role's password, so every database of one
   * cluster must use the same set: random per container here, run-wide in the shared container.
   */
  passwords: Record<ProductDatabasePurpose, string>;

  stop(): Promise<void>;
}

/** A database provisioned once and cloned with CREATE DATABASE ... TEMPLATE (shared container only). */
export interface TestTemplate {
  /** Plain identifier fragment; include a digest of everything the build depends on. */
  readonly name: string;

  /** Provisions `pg.superuser.database` (empty, owned by the superuser) with `pg.passwords`. */
  build(pg: TestPostgres): Promise<void>;
}

export interface PostgresOptions {
  /**
   * Use the run-wide container of tools/test.ts (a database of its own) when HRM_TEST_PG is set.
   * Default false = this file owns a container. Files that need their own cluster (role/cluster
   * settings, kill sessions, step-by-step migrations, offline CLI, load) must not set it.
   */
  shared?: boolean;
  /** Start from a cloned template (shared) or build it in place (own container). */
  template?: TestTemplate;
}

const purposes = [
  'data',
  'identity',
  'authority',
  'sync',
  'migration',
  'bootstrap',
  'outbox',
] as const satisfies readonly ProductDatabasePurpose[];

const randomPasswords = () =>
  Object.fromEntries(purposes.map((name) => [name, randomBytes(20).toString('hex')])) as Record<
    ProductDatabasePurpose,
    string
  >;

/** Serializes template builds and clones across the files of one run (cluster-wide, session lock). */
const clusterLockKey = 7_301_001;

/**
 * testcontainers waits a fixed 10 s for the host port binding (not covered by withStartupTimeout);
 * a loaded Docker daemon occasionally exceeds it. Only that error is retried, at most 3 attempts.
 */
async function startContainer(superPassword: string, command?: string[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      const container = new PostgreSqlContainer(postgresImage)
        .withDatabase('postgres')
        .withUsername('fixture_superuser')
        .withPassword(superPassword)
        .withStartupTimeout(120_000);
      return await (command ? container.withCommand(command) : container).start();
    } catch (error) {
      const portBind = error instanceof Error && error.message.includes('ports to be bound');
      if (!portBind || attempt >= 3) throw error;
    }
  }
}

async function createProvisioner(superuser: Connection, password: string) {
  await withClient(superuser, (client) =>
    client.query(`CREATE ROLE authz_provisioner LOGIN CREATEDB CREATEROLE PASSWORD '${password}'`),
  );
}

/** Starts a disposable PostgreSQL 18 container (or a database of the run-wide one) with synthetic credentials. */
export async function startPostgres(options: PostgresOptions = {}): Promise<TestPostgres> {
  const shared = options.shared ? parseSharedEnv(process.env[sharedEnvName]) : undefined;
  if (shared) return openSharedDatabase(shared, options.template);
  const superPassword = randomBytes(18).toString('hex');
  const container = await startContainer(superPassword);
  const superuser: Connection = {
    host: container.getHost(),
    port: container.getPort(),
    username: 'fixture_superuser',
    password: superPassword,
    database: 'postgres',
  };
  const adminPassword = randomBytes(18).toString('hex');
  const postgres: TestPostgres = {
    superuser,
    admin: { ...superuser, username: 'authz_provisioner', password: adminPassword },
    passwords: randomPasswords(),
    stop: async () => {
      await container.stop();
    },
  };
  try {
    await createProvisioner(superuser, adminPassword);
    await options.template?.build(postgres);
  } catch (error) {
    await postgres.stop().catch(() => undefined);
    throw error;
  }
  return postgres;
}

export interface SharedPostgres {
  readonly env: SharedPostgresEnv;

  /** Builds the template now (idempotent) so no file pays for it or races to build it. */
  prepare(template: TestTemplate): Promise<void>;

  stop(): Promise<void>;
}

/** Runner side: one container for the whole run; files get theirs through {@link sharedEnvName}. */
export async function startSharedPostgres(): Promise<SharedPostgres> {
  const superPassword = randomBytes(18).toString('hex');
  // Two files at a time, each with up to six pools of 10: stay clear of the default 100.
  const container = await startContainer(superPassword, ['postgres', '-c', 'max_connections=300']);
  const env: SharedPostgresEnv = {
    host: container.getHost(),
    port: container.getPort(),
    superPassword,
    adminPassword: randomBytes(18).toString('hex'),
    passwords: randomPasswords(),
  };
  try {
    await createProvisioner(maintenance(env), env.adminPassword);
  } catch (error) {
    await container.stop().catch(() => undefined);
    throw error;
  }
  return {
    env,
    prepare: (template) => withClusterLock(env, (client) => ensureTemplate(client, env, template)),
    stop: async () => {
      await container.stop();
    },
  };
}

const maintenance = (env: SharedPostgresEnv): Connection => ({
  host: env.host,
  port: env.port,
  username: 'fixture_superuser',
  password: env.superPassword,
  database: 'postgres',
});

const templateDatabase = (template: TestTemplate) => `tpl_${template.name}`;

function inDatabase(env: SharedPostgresEnv, database: string): TestPostgres {
  const superuser = { ...maintenance(env), database };
  return {
    superuser,
    admin: { ...superuser, username: 'authz_provisioner', password: env.adminPassword },
    passwords: env.passwords,
    stop: () => Promise.resolve(),
  };
}

async function withClusterLock<T>(
  env: SharedPostgresEnv,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(maintenance(env), async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [clusterLockKey]);
    // Closing the session releases the lock, also when the process dies.
    return run(client);
  });
}

/** A template is usable only once marked ready; a half-built one (crash) is dropped and rebuilt. */
async function ensureTemplate(client: pg.Client, env: SharedPostgresEnv, template: TestTemplate) {
  const database = templateDatabase(template);
  const found = await client.query<{ ready: boolean }>(
    `SELECT shobj_description(oid,'pg_database') IS NOT DISTINCT FROM 'ready' AS ready
       FROM pg_database WHERE datname=$1`,
    [database],
  );
  if (found.rows[0]?.ready) return;
  if (found.rows[0]) await client.query(`DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
  try {
    await template.build(inDatabase(env, database));
    await client.query(`COMMENT ON DATABASE ${quoteIdentifier(database)} IS 'ready'`);
  } catch (error) {
    await client
      .query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`)
      .catch(() => undefined);
    throw error;
  }
}

async function openSharedDatabase(
  env: SharedPostgresEnv,
  template: TestTemplate | undefined,
): Promise<TestPostgres> {
  const database = sharedDatabaseName();
  const create = `CREATE DATABASE ${quoteIdentifier(database)}`;
  if (template)
    await withClusterLock(env, async (client) => {
      await ensureTemplate(client, env, template);
      await client.query(`${create} TEMPLATE ${quoteIdentifier(templateDatabase(template))}`);
    });
  else await withClient(maintenance(env), (client) => client.query(create));
  return {
    ...inDatabase(env, database),
    stop: () =>
      withClient(maintenance(env), async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
      }),
  };
}

export async function openClient(connection: Connection): Promise<pg.Client> {
  const client = new pg.Client({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: connection.database,
  });
  await client.connect();
  return client;
}

export async function withClient<T>(
  connection: Connection,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await openClient(connection);
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Resolves to the PostgreSQL SQLSTATE of a rejected operation; fails if it succeeds. */
export async function sqlState(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
  throw new Error('Expected the operation to be rejected by PostgreSQL');
}
