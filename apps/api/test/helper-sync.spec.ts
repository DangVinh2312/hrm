import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

// ADR 0033 (commit E): lints hypothetical files with the real app config.
const eslint = new ESLint({
  cwd: fileURLToPath(new URL('../../..', import.meta.url)),
  overrideConfig: tseslint.configs.disableTypeChecked,
});

async function restricted(file: string, code: string) {
  const [result] = await eslint.lintText(`${code}\n`, {
    filePath: fileURLToPath(new URL(`../../../${file}`, import.meta.url)),
  });
  assert.ok(result);
  return result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
}

const helper = 'apps/api/src/sample/sample.helper.ts';

describe('helpers stay synchronous (ADR 0033)', () => {
  const rejected: Record<string, string> = {
    'async function': 'export async function load() { return 1; }',
    'async function expression': 'export const load = async function () { return 1; };',
    'async arrow': 'export const load = async () => 1;',
    'async method': 'export const box = { async load() { return 1; } };',
    await: 'declare const p: unknown;\nexport const f = () => { await p; };',
    'for await':
      'declare const p: AsyncIterable<number>;\nexport const f = () => { for await (const x of p) { x; } };',
    'Promise return type': 'export function load(): Promise<void> { throw new Error(); }',
    'new Promise': 'export const p = new Promise<void>((resolve) => resolve());',
    'Promise.all': 'export const p = Promise.all([]);',
  };

  for (const [name, code] of Object.entries(rejected)) {
    test(`rejects ${name} in a helper`, async () => {
      assert.ok((await restricted(helper, code)).length >= 1);
    });
  }

  test('accepts a synchronous helper', async () => {
    const code = 'export function double(value: number): number { return value * 2; }';
    assert.equal((await restricted(helper, code)).length, 0);
  });

  test('does not restrict services, repositories or files outside src', async () => {
    const code =
      'export async function load(): Promise<number> { return await Promise.resolve(1); }';
    for (const file of [
      'apps/api/src/sample/sample.service.ts',
      'apps/api/src/sample/repositories/sample.repository.ts',
      'apps/api/test/sample.helper.ts',
      'apps/api/test/sample.spec.ts',
    ]) {
      assert.equal((await restricted(file, code)).length, 0, file);
    }
  });

  test('helpers keep the planUnrestricted restriction (ADR 0012)', async () => {
    const code =
      'declare const core: { planUnrestricted(a: unknown): unknown };\nexport const x = core.planUnrestricted({});';
    const found = await restricted(helper, code);
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? '', /unrestricted/);
    assert.equal((await restricted('apps/api/src/sample/sample.service.ts', code)).length, 1);
  });
});
