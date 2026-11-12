import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bump together with test/postgres.go, apps/api/test/setup-postgres.ts and compose.yaml.
const image = 'postgres:18.6-bookworm';
const superuser = 'fixture_superuser';

const directory = mkdtempSync(join(tmpdir(), 'hrm-integration-'));
const binary = join(directory, 'hrmctl');
const container = basename(directory);
const cwd = fileURLToPath(new URL('..', import.meta.url));

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  capture = false,
): Promise<{ status: number; output: string }> {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    detached: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  let interrupted = 0;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const [signal, status] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    const handler = () => {
      interrupted = status;
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
      }
    };

    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    const status = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(interrupted || (code ?? 1)));
    });
    return { status, output: output.trim() };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

// One cluster for every package of the run: the fixture builds its template once and clones it per test.
// The password reaches docker and go test through the environment only.
async function startCluster(): Promise<{ status: number; url: string }> {
  const password = randomBytes(20).toString('hex');
  const started = await run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      ...['--env', `POSTGRES_USER=${superuser}`, '--env', 'POSTGRES_PASSWORD'],
      ...['--env', 'POSTGRES_DB=postgres', '--publish', '127.0.0.1::5432', image],
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
    true,
  );
  if (started.status !== 0) return { status: started.status, url: '' };
  const port = await run('docker', ['port', container, '5432/tcp'], process.env, true);
  const address = port.output.split('\n')[0] ?? '';
  if (port.status !== 0 || !/^127\.0\.0\.1:\d+$/.test(address)) {
    return { status: port.status || 1, url: '' };
  }
  return { status: 0, url: `postgres://${superuser}:${password}@${address}/postgres` };
}

try {
  let status = (await run('go', ['build', '-o', binary, './cmd/hrmctl'], process.env)).status;
  if (status === 0) {
    const cluster = await startCluster();
    status = cluster.status;
    if (status === 0) {
      const args = process.argv.slice(2);
      if (args.length === 0 || args[0]?.startsWith('-')) {
        args.unshift('./cmd/...', './internal/...', './test/...');
      }
      const test = ['test', '-race', '-tags', 'integration', '-count=1', '-p', '2', ...args];
      status = (
        await run('go', test, {
          ...process.env,
          HRM_TEST_HRMCTL: binary,
          HRM_TEST_POSTGRES_URL: cluster.url,
        })
      ).status;
    }
  }
  process.exitCode = status;
} finally {
  spawnSync('docker', ['rm', '--force', '--volumes', container], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
