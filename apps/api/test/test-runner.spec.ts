import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../tools/test.ts', import.meta.url));
const fixtures = [
  ['spec.ts', 'unit-fixture'],
  ['smoke-spec.ts', 'smoke-fixture'],
  ['integration-spec.ts', 'integration-fixture'],
  ['e2e-spec.ts', 'e2e-fixture'],
] as const;

for (const [suite, expected] of [
  ['unit', ['unit-fixture', 'smoke-fixture']],
  ['integration', ['integration-fixture']],
  ['e2e', ['e2e-fixture']],
] as const) {
  test(`directory filters select only ${suite} tests independently of the caller cwd`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'api-test-runner-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const [suffix, marker] of fixtures) {
      await writeFile(
        join(directory, `fixture.${suffix}`),
        `import { writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('${marker}', () => { writeFileSync(new URL('${marker}.ran', import.meta.url), 'ran'); });\n`,
      );
    }
    const env = { ...process.env };
    // Start an independent runner rather than another worker of the enclosing node:test run.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, suite, '--', directory], {
      cwd: tmpdir(),
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const [, marker] of fixtures) {
      assert.equal(
        existsSync(join(directory, `${marker}.ran`)),
        expected.some((name) => name === marker),
        marker,
      );
    }
  });
}

for (const path of [
  'apps/api/test/product-identity.spec.ts',
  './apps/api/test/product-identity.spec.ts',
  'apps/../apps/api/test/product-identity.spec.ts',
]) {
  test(`workspace-relative file filter resolves ${path} from an unrelated cwd`, () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, 'unit', '--', path], {
      cwd: tmpdir(),
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
  });
}
