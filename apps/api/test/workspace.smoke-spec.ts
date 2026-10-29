import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const apiMain = fileURLToPath(new URL('../dist/main.js', import.meta.url));

const validEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  APP_ORIGIN: 'http://127.0.0.1:3000',
  // Google only: one trusted provider is required.
  OIDC_PROVIDERS_JSON: JSON.stringify([
    {
      issuer: 'https://idp.example.test',
      clientId: 'fixture-client',
      redirectUri: 'http://127.0.0.1:3000/api/auth/oidc/callback',
      version: '1',
      assuranceMappings: [],
    },
  ]),
  // Synthetic fixture key; never a real one.
  MFA_ENCRYPTION_KEYS: 'fixture:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  MFA_ENCRYPTION_KEY_ID: 'fixture',
  PRODUCT_DATA_DATABASE_URL: 'postgres://product_data:fixture-secret@127.0.0.1:1/product',
  PRODUCT_IDENTITY_DATABASE_URL: 'postgres://product_identity:fixture-secret@127.0.0.1:1/product',
  PRODUCT_AUTHORITY_DATABASE_URL: 'postgres://product_authority:fixture-secret@127.0.0.1:1/product',
  PRODUCT_SYNC_DATABASE_URL: 'postgres://product_sync:fixture-secret@127.0.0.1:1/product',
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

function runApiExpectingExit(env: Record<string, string>) {
  return spawnSync(process.execPath, [apiMain], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('API refuses business listener when the authority database is unavailable', async () => {
  const port = await freePort();
  const result = runApiExpectingExit({ ...validEnv, PORT: String(port) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Application startup failed/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health/live`));
});
for (const missing of [
  'PRODUCT_DATA_DATABASE_URL',
  'PRODUCT_IDENTITY_DATABASE_URL',
  'PRODUCT_AUTHORITY_DATABASE_URL',
  'PRODUCT_SYNC_DATABASE_URL',
  'NODE_ENV',
  'APP_ORIGIN',
  'OIDC_PROVIDERS_JSON',
  'MFA_ENCRYPTION_KEYS',
  'MFA_ENCRYPTION_KEY_ID',
] as const) {
  test(`API refuses to boot without ${missing}`, () => {
    const env: Record<string, string> = { ...validEnv };
    delete env[missing];
    const result = runApiExpectingExit(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(missing));
  });
}
test('AUTH_METHODS is gone: an env that still sets it fails the boot instead of being ignored', async () => {
  const { loadConfig } = await import('../dist/config/app.config.js');
  assert.equal(loadConfig(validEnv).oidcProviders.length, 1);
  for (const value of ['oidc', 'local', 'local,oidc', ''])
    assert.throws(() => loadConfig({ ...validEnv, AUTH_METHODS: value }), /AUTH_METHODS/, value);
  const refused = runApiExpectingExit({ ...validEnv, AUTH_METHODS: 'oidc' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /AUTH_METHODS/);
});

test('configuration rejects offline credentials without leaking secrets', () => {
  const result = runApiExpectingExit({
    ...validEnv,
    PRODUCT_DATA_DATABASE_URL: 'mysql://leaky_user:do-not-print-me@127.0.0.1/product',
    PRODUCT_BOOTSTRAP_DATABASE_URL: 'do-not-print-me-either',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PRODUCT_DATA_DATABASE_URL/);
  assert.match(result.stderr, /PRODUCT_BOOTSTRAP_DATABASE_URL/);
  assert.doesNotMatch(result.stderr + result.stdout, /do-not-print-me|leaky_user/);
  // A malformed key ring names the variables, never the key material.
  const leaky = Buffer.from('do-not-print-this-key-material!!').toString('base64');
  for (const keys of [
    `fixture:${leaky.slice(0, -2)}`,
    `other:${leaky}`,
    `fixture:${leaky},fixture:${leaky}`,
  ]) {
    const refused = runApiExpectingExit({ ...validEnv, MFA_ENCRYPTION_KEYS: keys });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /MFA_ENCRYPTION_KEYS/);
    assert.doesNotMatch(refused.stderr + refused.stdout, new RegExp(leaky.slice(0, 12)));
  }
});

test('importing the authorization core loads no framework, ORM, driver or value library', () => {
  const probe = `
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); loaded.push(r.url); return r; } });
    const core = await import('./apps/api/dist/authorization/core/authorization.factory.js');
    console.log(JSON.stringify({ exports: Object.keys(core), loaded }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const { exports, loaded } = JSON.parse(result.stdout) as { exports: string[]; loaded: string[] };
  assert.ok(exports.length > 0, 'core factory must expose its constructor');
  assert.ok(loaded.some((url) => url.includes('/apps/api/dist/authorization/core/')));
  const forbidden = loaded.filter((url) =>
    /node_modules\/(@nestjs|typeorm|pg|pg-[a-z]+|reflect-metadata|express|dayjs|moment)\/|\/authorization\/values\//.test(
      url,
    ),
  );
  assert.deepEqual(forbidden, []);
  assert.ok(exports.includes('createAuthorizationCore'));
});

test('API runtime and offline CLI take their codecs from one composition', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  // The only place that picks value codecs for the product; both entry points call it.
  const manifest = read('../src/authorization/product.manifest.ts');
  assert.match(
    manifest,
    /createStandardValueCodecs\(\{ timestamp: createDayjsTimestampCodec\(\) \}\)/,
  );
  for (const path of ['../src/infrastructure/product-runtime.service.ts', '../tools/product.ts']) {
    const source = read(path);
    assert.match(source, /createProductAuthorizationCore\(\)/, path);
    assert.doesNotMatch(source, /createAuthorizationCore\(|createStandardValueCodecs\(/, path);
  }
});
