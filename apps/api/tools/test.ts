// Runs an API node:test suite against the built app from any caller cwd.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = resolve(apiRoot, '../..');
const workspacePrefix = relative(workspaceRoot, apiRoot);

const suites: Record<string, { suffixes: string[]; flags: string[] }> = {
  unit: { suffixes: ['.spec.ts', '.smoke-spec.ts'], flags: [] },
  e2e: { suffixes: ['.e2e-spec.ts'], flags: ['--test-timeout=300000'] },
  // Each integration file starts a container; keep concurrency within the runner's deadline.
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
const result = spawnSync(
  process.execPath,
  [
    '--test',
    ...suite.flags,
    ...(files.length > 0 ? files : suite.suffixes.map((suffix) => `test/**/*${suffix}`)),
  ],
  { cwd: apiRoot, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
