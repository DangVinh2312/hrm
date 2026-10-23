import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Env var through which tools/test.ts hands the run-wide container to its test processes. */
export const sharedEnvName = 'HRM_TEST_PG';

/** Synthetic connection facts of the run-wide container (never real credentials). */
export interface SharedPostgresEnv {
  host: string;
  port: number;
  superPassword: string;
  adminPassword: string;
  /** One password per product login, shared by every database of the run (roles are cluster-wide). */
  passwords: Record<string, string>;
}

/** Unset means "no runner: start your own container"; a set but malformed value is a bug, not a fallback. */
export function parseSharedEnv(raw: string | undefined): SharedPostgresEnv | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError(`${sharedEnvName} is malformed`);
  }
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`${sharedEnvName} is malformed`);
  const { host, port, superPassword, adminPassword, passwords } = value as Record<string, unknown>;
  if (
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    typeof superPassword !== 'string' ||
    typeof adminPassword !== 'string' ||
    typeof passwords !== 'object' ||
    passwords === null
  )
    throw new TypeError(`${sharedEnvName} is malformed`);
  return {
    host,
    port,
    superPassword,
    adminPassword,
    passwords: passwords as Record<string, string>,
  };
}

export function sharedDatabaseName(): string {
  return `t_${randomBytes(8).toString('hex')}`;
}

/** DDL cannot bind identifiers; only plain lower-case names (ours are generated) are accepted. */
export function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new TypeError('Unsafe identifier');
  return `"${name}"`;
}

/** Digest of file names and bytes under `roots` with one of `suffixes`; a missing root throws. */
export function treeDigest(roots: readonly string[], suffixes: readonly string[]): string {
  const hash = createHash('sha256');
  for (const root of roots) {
    const files = statSync(root).isDirectory()
      ? readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter((file) => suffixes.some((suffix) => file.endsWith(suffix)))
          .map((file) => join(root, file))
          .sort()
      : [root];
    for (const file of files) {
      if (!statSync(file).isFile()) continue;
      hash.update(file.slice(root.length)).update('\0').update(readFileSync(file)).update('\0');
    }
  }
  return hash.digest('hex');
}
