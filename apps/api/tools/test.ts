// Runs an API node:test suite against the built app from any caller cwd.
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SharedPostgres } from '../test/setup-postgres.ts';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = resolve(apiRoot, '../..');
const workspacePrefix = relative(workspaceRoot, apiRoot);

const suites: Record<string, { suffixes: string[]; flags: string[] }> = {
  unit: { suffixes: ['.spec.ts', '.smoke-spec.ts'], flags: [] },
  e2e: { suffixes: ['.e2e-spec.ts'], flags: ['--test-timeout=300000'] },
  // Files that opt in share one container (startPostgres({ shared: true })); the others start
  // their own. Keep concurrency within the runner's deadline.
  integration: {
    suffixes: ['.integration-spec.ts'],
    flags: ['--test-timeout=300000', '--test-concurrency=2'],
  },
};

const [name = '', ...args] = process.argv.slice(2);
const suite = suites[name];
if (!suite) {
  console.error(`Unknown test suite "${name}". Expected one of: ${Object.keys(suites).join(', ')}`);
  process.exit(2);
}
const files = args
  .filter((arg) => arg !== '--')
  .flatMap((arg) => {
    const normalized = normalize(arg);
    const workspaceRelative =
      normalized === workspacePrefix || normalized.startsWith(`${workspacePrefix}${sep}`);
    const path = resolve(workspaceRelative ? workspaceRoot : apiRoot, normalized);
    return statSync(path, { throwIfNoEntry: false })?.isDirectory()
      ? suite.suffixes.map((suffix) => `${path}/**/*${suffix}`)
      : [path];
  });
const targets = files.length > 0 ? files : suite.suffixes.map((suffix) => `test/**/*${suffix}`);

/** Only files that ask for the run-wide container justify starting it (an isolated file stays cheap). */
function usesSharedPostgres(): boolean {
  // shortcut: globs (no files, or a directory) are not expanded here, so assume yes; start-up is ~5 s.
  if (files.length === 0 || files.some((file) => file.includes('*'))) return true;
  return files.some(
    (file) =>
      statSync(file, { throwIfNoEntry: false })?.isFile() &&
      readFileSync(file, 'utf8').includes('startHrStack('),
  );
}

let shared: SharedPostgres | undefined;
if (name === 'integration' && usesSharedPostgres()) {
  // Imported here so unit/e2e runs (no Docker needed) never load testcontainers or dist.
  const { startSharedPostgres } = await import('../test/setup-postgres.ts');
  const { hrTemplate } = await import('../test/hr-template.helper.ts');
  const started = await startSharedPostgres();
  shared = started;
  try {
    await started.prepare(hrTemplate);
  } catch (error) {
    console.error('Could not prepare the shared PostgreSQL template', error);
    await started.stop().catch(() => undefined);
    process.exit(1);
  }
}

const child = spawn(process.execPath, ['--test', ...suite.flags, ...targets], {
  cwd: apiRoot,
  stdio: 'inherit',
  env: shared ? { ...process.env, HRM_TEST_PG: JSON.stringify(shared.env) } : process.env,
});
// The container is owned by this process: stop it on every way out. testcontainers' reaper
// (Ryuk, on by default) removes it if this process is killed outright.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
const status = await new Promise<number>((done) => {
  child.on('error', () => done(1));
  child.on('exit', (code) => done(code ?? 1));
});
await shared
  ?.stop()
  .catch((error: unknown) => console.error('Could not stop the shared container', error));
process.exit(status);
