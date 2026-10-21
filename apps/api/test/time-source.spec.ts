// ADR 0022 §2–§4: the DB clock decides validity; the API never reads the wall clock for auth.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));

// `Date(` without `new` also returns the wall-clock string; `(?<![\w$.])` keeps `toDate(`/`x.Date(` out.
const wallClock =
  /\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bDate\.UTC\s*\(|\bDate\.parse\s*\(|(?<![\w$.])Date\s*\(/;

const unixClock = /\bDate\.now\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(join(src, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** `file:line` of every line matching `pattern`. */
function offenders(files: readonly string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        pattern.test(line) ? [`${relative(src, file)}:${String(index + 1)}`] : [],
      ),
  );
}

test('the patterns catch every wall-clock form they are meant to ban', () => {
  for (const line of [
    'const t = Date.now();',
    'if (Date.now () - at > 300000)',
    'const d = new Date(value * 1000);',
    'const d = new   Date();',
    'new Date(Date.UTC(year, month - 1, day))',
    'const ms = Date.parse(value);',
    'const text = Date();',
  ])
    assert.ok(wallClock.test(line), line);
  assert.ok(unixClock.test('const started = Date.now();'));
  for (const line of [
    'const started = performance.now();',
    'expiresAt: string; // DB-formatted',
    'statement_timestamp()',
    'const updatedAt = row.updated_at;',
    'dayjs.utc(value, format, true)',
    'const d = toDate(value);',
    'updateDate(row);',
    'this.Date(x)',
  ])
    assert.ok(!wallClock.test(line), line);
});

test('auth and authorization services take no time decision from the API clock', () => {
  const files = [...sources('auth'), ...sources('authorization/services')];
  assert.ok(files.length > 3, 'scan found the source tree');
  assert.deepEqual(offenders(files, wallClock), []);
});

test('the transaction runner measures durations with the monotonic clock only', () => {
  const runner = join(src, 'database/product-transaction.runner.ts');
  assert.deepEqual(offenders([runner], unixClock), []);
  assert.match(readFileSync(runner, 'utf8'), /performance\.now\(\)/);
});

test('business dates are checked by strict Day.js parsing, not by Date arithmetic', () => {
  const helper = join(src, 'modules/hr/helpers/hr-input.helper.ts');
  assert.deepEqual(offenders([helper], wallClock), []);
  assert.match(readFileSync(helper, 'utf8'), /dayjs\.utc\([^)]*, true\)/);
});
