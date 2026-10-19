// Offline CLI against a disposable PostgreSQL: the tool runs as a child process with the same
// env variables an operator sets; the fixture only provisions, migrates and syncs first.
import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSource } from 'typeorm';
import { productDataSourceOptions } from '../dist/database/helpers/product-database.helper.js';
import { startPostgres, withClient, type TestPostgres } from './setup-postgres.ts';

const cliPath = fileURLToPath(new URL('../tools/product.ts', import.meta.url));
export const CLI_ISSUER = 'https://idp.example.test';

export interface CliFixture {
  readonly dir: string;

  /** Runs the command, asserts exit 0 and returns stdout + stderr. */
  run(command: string, ...args: string[]): string;

  /** Runs the command and returns the raw result (exit code, stdout, stderr). */
  spawn(command: string, ...args: string[]): SpawnSyncReturns<string>;

  /** Rows of a query as the superuser on the fixture database. */
  query<T extends object>(sql: string, values?: unknown[]): Promise<T[]>;

  /** A pool of the runtime login `purpose`; the caller destroys it. */
  login(purpose: string): Promise<DataSource>;
}

/** Provisions, migrates and syncs a fresh database; `t.after` stops everything. */
export async function startCliFixture(
  t: { after(fn: () => Promise<void>): void },
  name: string,
): Promise<CliFixture> {
  const pg: TestPostgres = await startPostgres();
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  t.after(async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const c = pg.superuser;
  const database = `${name}_fixture`.replaceAll('-', '_');
  const passwords: Record<string, string> = {};
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    DATABASE_ADMIN_URL: `postgres://${c.username}:${c.password}@${c.host}:${c.port}/postgres`,
    PRODUCT_DATABASE_NAME: database,
  };
  for (const p of ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox']) {
    passwords[p] = randomBytes(24).toString('hex');
    env[`PRODUCT_${p.toUpperCase()}_PASSWORD`] = passwords[p];
    env[`PRODUCT_${p.toUpperCase()}_DATABASE_URL`] =
      `postgres://product_${p}:${passwords[p]}@${c.host}:${c.port}/${database}`;
  }

  const spawn = (command: string, ...args: string[]) =>
    spawnSync(process.execPath, [cliPath, command, ...args], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });

  const run = (command: string, ...args: string[]) => {
    const result = spawn(command, ...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  };

  for (const step of ['provision', 'migrate', 'sync']) run(step);
  await withClient({ ...c, database }, (client) =>
    client.query('INSERT INTO oidc_provider(issuer,version,enabled) VALUES($1,1,true)', [
      CLI_ISSUER,
    ]),
  );
  return {
    dir,
    run,
    spawn,
    query: (sql, values) =>
      withClient({ ...c, database }, async (client) => {
        const result = await client.query(sql, values);
        return result.rows as never;
      }),
    login: (purpose) =>
      new DataSource(
        productDataSourceOptions({
          host: c.host,
          port: c.port,
          username: `product_${purpose}`,
          password: passwords[purpose] ?? '',
          database,
        }),
      ).initialize(),
  };
}
