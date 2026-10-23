import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  parseSharedEnv,
  quoteIdentifier,
  sharedDatabaseName,
  sharedEnvName,
  treeDigest,
} from './postgres-shared.helper.ts';

const valid = {
  host: '127.0.0.1',
  port: 5432,
  superPassword: 'a',
  adminPassword: 'b',
  passwords: { data: 'c' },
};

test('an unset shared env means "start your own container"; a malformed one fails closed', () => {
  assert.equal(parseSharedEnv(undefined), undefined);
  assert.equal(parseSharedEnv(''), undefined);
  assert.deepEqual(parseSharedEnv(JSON.stringify(valid)), valid);
  for (const bad of ['{', '[]', 'null', JSON.stringify({ ...valid, port: '5432' }), '{"host":"h"}'])
    assert.throws(() => parseSharedEnv(bad), TypeError, bad);
  assert.equal(sharedEnvName, 'HRM_TEST_PG');
});

test('database names are unique per call and always safe identifiers', () => {
  const names = new Set(Array.from({ length: 50 }, () => sharedDatabaseName()));
  assert.equal(names.size, 50);
  for (const name of names) assert.equal(quoteIdentifier(name), `"${name}"`);
});

test('quoteIdentifier refuses anything but a plain lower-case identifier', () => {
  for (const bad of ['', 'A', 'a b', 'a"b', 'a;drop', '1a', 'a'.repeat(64), 'a\0'])
    assert.throws(() => quoteIdentifier(bad), TypeError, bad);
});

test('treeDigest changes with any file content, name or addition, and ignores non-listed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-digest-'));
  try {
    mkdirSync(join(dir, 'm'));
    writeFileSync(join(dir, 'm', 'a.js'), 'one');
    writeFileSync(join(dir, 'b.txt'), 'ignored');
    const base = treeDigest([dir], ['.js']);
    assert.equal(treeDigest([dir], ['.js']), base);
    writeFileSync(join(dir, 'b.txt'), 'still ignored');
    assert.equal(treeDigest([dir], ['.js']), base);
    writeFileSync(join(dir, 'm', 'a.js'), 'two');
    const edited = treeDigest([dir], ['.js']);
    assert.notEqual(edited, base);
    writeFileSync(join(dir, 'm', 'c.js'), '');
    assert.notEqual(treeDigest([dir], ['.js']), edited);
    assert.throws(() => treeDigest([join(dir, 'missing')], ['.js']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
