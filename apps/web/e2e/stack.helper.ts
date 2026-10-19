import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { build, preview, type PreviewServer } from 'vite';
import { FakeOidcProvider } from './fake-oidc.helper.ts';
import { createTestTls } from './tls.helper.ts';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const apiRoot = fileURLToPath(new URL('../../api/', import.meta.url));
const run = promisify(execFile);
/** Same pinned image as apps/api/test/setup-postgres.ts. */
const postgresImage = 'postgres:18.4';
const purposes = ['data', 'identity', 'authority', 'sync', 'migration', 'bootstrap', 'outbox'];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address !== 'object') throw new Error('No free port');
  return address.port;
}

async function waitForReady(url: string, api: ChildProcess, output: () => string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (api.exitCode !== null) throw new Error(`API exited during startup:\n${output()}`);
    const status = await fetch(url).then(
      (response) => response.status,
      () => 0,
    );
    if (status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API not ready after 30 s:\n${output()}`);
}

export interface TestStack {
  readonly webOrigin: string;
  readonly idp: FakeOidcProvider;
  readonly webAssets: string;
  /** Synthetic DB passwords and MFA key, so tests can prove they never reach the bundle. */
  readonly secrets: readonly string[];

  /** Enrolls a pending OIDC account and returns its activation secret (CLI `invite`). */
  invite(subject: string): Promise<string>;

  /** Enrolls a pending account for its first verified Google login of `email` (ADR 0020). */
  enrollByEmail(email: string): Promise<void>;

  /** Offline Root bootstrap for a pre-bound `subject` (ADR 0021); returns the activation secret. */
  bootstrapRoot(subject: string): Promise<string>;

  stop(): Promise<void>;
}

/**
 * Starts a disposable HRM stack the way an operator would: PostgreSQL container, offline CLI
 * provision/migrate/sync/invite, the built API process, a fake HTTPS IdP and the built web app
 * served over HTTPS with /api proxied. Never reads apps/api/.env.* files.
 */
export async function startStack(): Promise<TestStack> {
  if (!existsSync(join(apiRoot, 'dist/main.js')))
    throw new Error('Build the API first: pnpm run build');
  const dir = mkdtempSync(join(tmpdir(), 'hrm-e2e-'));
  const cleanups: (() => Promise<void>)[] = [
    () => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  ];

  const stop = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  };

  try {
    const tls = createTestTls(dir);
    const [webPort, apiPort, idpPort] = [await freePort(), await freePort(), await freePort()];
    const webOrigin = `https://localhost:${webPort}`;
    const redirectUri = `${webOrigin}/api/auth/oidc/callback`;
    const idp = new FakeOidcProvider();
    await idp.start(tls, idpPort, redirectUri);
    cleanups.push(() => idp.stop());

    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(postgresImage)
      .withDatabase('postgres')
      .withUsername('fixture_superuser')
      .withPassword(randomBytes(18).toString('hex'))
      .start();
    cleanups.push(async () => {
      await container.stop();
    });
    const host = container.getHost();
    const port = container.getPort();
    const passwords = Object.fromEntries(purposes.map((p) => [p, randomBytes(18).toString('hex')]));
    // Synthetic key of this run only (ADR 0026 §3).
    const mfaKey = randomBytes(32).toString('base64');

    const url = (purpose: string) =>
      `postgres://product_${purpose}:${passwords[purpose]}@${host}:${port}/hrm_e2e`;

    const opsEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      DATABASE_ADMIN_URL: `postgres://fixture_superuser:${container.getPassword()}@${host}:${port}/postgres`,
      PRODUCT_DATABASE_NAME: 'hrm_e2e',
      ...Object.fromEntries(
        purposes.map((p) => [`PRODUCT_${p.toUpperCase()}_PASSWORD`, passwords[p]!]),
      ),
      ...Object.fromEntries(
        ['identity', 'sync', 'migration', 'bootstrap'].map((p) => [
          `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
          url(p),
        ]),
      ),
    };

    const cli = (...args: string[]) =>
      run(process.execPath, ['tools/product.ts', ...args], { cwd: apiRoot, env: opsEnv });

    await cli('provision');
    await cli('migrate');
    await cli('sync');

    const apiEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'test',
      PORT: String(apiPort),
      TRUST_PROXY: '0',
      LOG_LEVEL: 'error',
      APP_ORIGIN: webOrigin,
      MFA_ENCRYPTION_KEYS: `fixture:${mfaKey}`,
      MFA_ENCRYPTION_KEY_ID: 'fixture',
      OIDC_PROVIDERS_JSON: JSON.stringify([
        {
          issuer: idp.issuer,
          clientId: idp.clientId,
          redirectUri,
          version: '1',
          assuranceMappings: [],
        },
      ]),
      // Trust only this run's CA for discovery/token calls to the fake IdP.
      NODE_EXTRA_CA_CERTS: tls.caFile,
      ...Object.fromEntries(
        ['data', 'identity', 'authority', 'sync'].map((p) => [
          `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
          url(p),
        ]),
      ),
    };
    const api = spawn(process.execPath, ['dist/main.js'], {
      cwd: apiRoot,
      env: apiEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    api.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    api.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    cleanups.push(async () => {
      if (api.exitCode !== null) return;
      api.kill('SIGTERM');
      await new Promise<void>((resolve) => api.once('exit', () => resolve()));
    });
    await waitForReady(`http://127.0.0.1:${apiPort}/api/health/ready`, api, () => output);

    const outDir = join(dir, 'web');
    await build({
      root: webRoot,
      logLevel: 'warn',
      build: { outDir, emptyOutDir: true },
      define: { 'import.meta.env.VITE_OIDC_ISSUER': JSON.stringify(idp.issuer) },
    });
    const server: PreviewServer = await preview({
      root: webRoot,
      logLevel: 'warn',
      build: { outDir },
      preview: {
        host: 'localhost',
        port: webPort,
        strictPort: true,
        https: { key: tls.key, cert: tls.cert },
        proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } },
      },
    });
    cleanups.push(() => server.close());

    return {
      webOrigin,
      idp,
      webAssets: outDir,
      secrets: [...Object.values(passwords), mfaKey],
      async invite(subject) {
        const file = join(dir, `activation-${randomUUID()}`);
        await cli(
          'invite',
          '--user',
          randomUUID(),
          '--method',
          'oidc',
          '--issuer',
          idp.issuer,
          '--subject',
          subject,
          '--activation-file',
          file,
        );
        return readFileSync(file, 'utf8').trim();
      },
      async bootstrapRoot(subject) {
        const user = randomUUID();
        const file = join(dir, `root-activation-${randomUUID()}`);
        const binding = ['--method', 'oidc', '--issuer', idp.issuer, '--subject', subject];
        await cli('enroll', '--user', user, ...binding);
        await cli(
          'bootstrap',
          '--user',
          user,
          '--operation',
          randomUUID(),
          ...binding,
          '--activation-file',
          file,
        );
        return readFileSync(file, 'utf8').trim();
      },
      async enrollByEmail(email) {
        await cli(
          'enroll',
          '--user',
          randomUUID(),
          '--method',
          'oidc',
          '--email',
          email,
          '--issuer',
          idp.issuer,
        );
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
