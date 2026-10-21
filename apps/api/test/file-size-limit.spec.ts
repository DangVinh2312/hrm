import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

// ADR 0033: lints hypothetical files with each app's real config (no TypeScript project needed).
const apps = {
  api: new ESLint({
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    overrideConfig: tseslint.configs.disableTypeChecked,
  }),
  web: new ESLint({
    cwd: fileURLToPath(new URL('../../web', import.meta.url)),
    overrideConfig: tseslint.configs.disableTypeChecked,
  }),
};

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`).join('\n');

async function sizeErrors(app: keyof typeof apps, file: string, code: string) {
  const root = app === 'api' ? '..' : '../../web';
  const [result] = await apps[app].lintText(`${code}\n`, {
    filePath: fileURLToPath(new URL(`${root}/${file}`, import.meta.url)),
  });
  assert.ok(result);
  return result.messages.filter((message) => message.ruleId === 'max-lines');
}

describe('file size limit (ADR 0033)', () => {
  test('rejects an API business file over 300 lines and accepts exactly 300', async () => {
    assert.equal(
      (await sizeErrors('api', 'src/modules/sample/sample.service.ts', lines(301))).length,
      1,
    );
    assert.equal(
      (await sizeErrors('api', 'src/modules/sample/sample.service.ts', lines(300))).length,
      0,
    );
  });

  test('does not count blank lines or comments', async () => {
    const padded = `${lines(300)}\n\n// comment\n/** block\n comment */\n`;
    assert.equal(
      (await sizeErrors('api', 'src/modules/sample/sample.service.ts', padded)).length,
      0,
    );
  });

  test('rejects a web component over 300 lines', async () => {
    assert.equal(
      (await sizeErrors('web', 'src/features/sample/sample.component.tsx', lines(301))).length,
      1,
    );
  });

  test('exempts declarative data files', async () => {
    for (const name of [
      'sample.declarations.ts',
      'sample.schema.ts',
      'sample.migration.ts',
      'sample.manifest.ts',
    ]) {
      assert.equal(
        (await sizeErrors('api', `src/modules/sample/${name}`, lines(400))).length,
        0,
        name,
      );
    }
  });

  test('keeps the temporary exception list explicit', async () => {
    const listed = 'src/authorization/services/product-authority.service.ts';
    assert.equal((await sizeErrors('api', listed, lines(400))).length, 0);
    assert.equal(
      (await sizeErrors('api', 'src/authorization/services/other.service.ts', lines(400))).length,
      1,
    );
  });
});
