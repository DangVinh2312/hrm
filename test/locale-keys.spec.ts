import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { API_ERROR_CODES } from '../apps/api/src/infrastructure/helpers/api-error.helper.ts';

// Contract between the two apps, which never import each other: the API answers errors with
// locale keys and the web shows them only when its dictionaries define them.
const locales = ['vi', 'en'] as const;

const dictionary = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`../apps/web/src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

test('web locales define the same keys with non-empty text', () => {
  const [source, ...others] = locales.map(dictionary);
  assert.ok(source);
  const keys = Object.keys(source).sort();
  for (const key of keys) assert.match(key, KEY);
  for (const [index, messages] of [source, ...others].entries()) {
    assert.deepEqual(Object.keys(messages).sort(), keys, `${locales[index]} keys differ from vi`);
    for (const [key, text] of Object.entries(messages))
      assert.ok(
        typeof text === 'string' && text.trim() !== '',
        `${locales[index]}: ${key} is empty`,
      );
  }
});

test('API error codes are exactly the error.* keys of every web locale', () => {
  for (const code of API_ERROR_CODES) assert.match(code, KEY);
  for (const locale of locales)
    assert.deepEqual(
      Object.keys(dictionary(locale))
        .filter((key) => key.startsWith('error.'))
        .sort(),
      [...API_ERROR_CODES].sort(),
      `${locale} error keys differ from the API`,
    );
});
