import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// SQL in src/ names its columns. This is a source scan, not a SQL parser: it cannot see
// SQL assembled from fragments, and a `//` inside a string hides the rest of that line.
const srcDir = fileURLToPath(new URL('../src', import.meta.url));

/** Whole-row `to_jsonb` is the definition of the code-owned state hash; changing it changes the hash. */
const wholeRowAllowed = new Set(['authorization/repositories/protected-state.repository.ts']);

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

export function violations(file: string, source: string): string[] {
  const text = withoutComments(source);
  // `SELECT * FROM x` stays valid for a CTE the file defines itself (`WITH x AS (UPDATE ... RETURNING cols)`),
  // which only forwards the columns its own statement listed.
  const ctes = new Set(
    [...text.matchAll(/\b(\w+)\s+AS\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase()),
  );
  const found: string[] = [];
  for (const m of text.matchAll(/RETURNING\s+(?:\w+\.)?\*/gi)) found.push(`RETURNING * (${m[0]})`);
  for (const m of text.matchAll(/(?:SELECT|,)\s+(?:DISTINCT\s+)?\w+\.\*/gi))
    found.push(`alias.* (${m[0]})`);
  for (const m of text.matchAll(/SELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+(\(|[\w.]+)/gi)) {
    const source = (m[1] ?? '').toLowerCase();
    if (source !== '(' && !ctes.has(source)) found.push(`SELECT * FROM ${source}`);
  }
  if (!wholeRowAllowed.has(file))
    for (const m of text.matchAll(/row_to_json\s*\(|to_jsonb\s*\(\s*\w+\s*\)/gi))
      found.push(`whole-row JSON (${m[0]})`);
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'migrations' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.migration.ts') ? [path] : [];
  });
}

describe('SQL names its columns', () => {
  test('src has no SELECT *, alias.*, RETURNING * or whole-row JSON outside the allowlist', () => {
    const bad = sources(srcDir).flatMap((path) => {
      const file = relative(srcDir, path).split(sep).join('/');
      return violations(file, readFileSync(path, 'utf8')).map((v) => `${file}: ${v}`);
    });
    assert.deepEqual(bad, []);
  });

  test('the scan rejects what it claims to reject', () => {
    assert.equal(violations('a.ts', 'q(`SELECT * FROM employee`)').length, 1);
    assert.equal(violations('a.ts', 'q(`SELECT s.id, x.* FROM t x`)').length, 1);
    assert.equal(violations('a.ts', 'q(`SELECT s.* FROM public.resolve_session($1) s`)').length, 1);
    assert.equal(violations('a.ts', 'q(`UPDATE t SET a = 1 RETURNING *`)').length, 1);
    assert.equal(violations('a.ts', 'q(`SELECT to_jsonb(t) FROM t`)').length, 1);
    assert.equal(violations('a.ts', 'q(`SELECT row_to_json(t) FROM t`)').length, 1);
  });

  test('the scan accepts explicit columns, CTE forwarding, subquery wrappers and comments', () => {
    const cte = 'q(`WITH u AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM u`)';
    assert.deepEqual(violations('a.ts', cte), []);
    assert.deepEqual(violations('a.ts', 'q(`SELECT * FROM (SELECT a, b FROM t) p`)'), []);
    assert.deepEqual(violations('a.ts', 'q(`SELECT a, b FROM t`) // SELECT * FROM t'), []);
    assert.deepEqual(violations('a.ts', '/* matrix `report.*` */ q(`SELECT a FROM t`)'), []);
  });

  test('whole-row JSON is allowed only for the code-owned state hash', () => {
    const hash = 'q(`SELECT to_jsonb(t) fact FROM x t`)';
    assert.deepEqual(
      violations('authorization/repositories/protected-state.repository.ts', hash),
      [],
    );
    assert.equal(violations('other.ts', hash).length, 1);
  });
});
