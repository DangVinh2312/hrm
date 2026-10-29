// The HTTP routes of the second factor.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, hotp } from '../dist/authentication/helpers/totp.helper.js';
import { ProductOidcService } from '../dist/authentication/services/product-oidc.service.js';
import { AppModule } from '../dist/app.module.js';
import { loadConfig } from '../dist/config/app.config.js';
import { ProductRuntime } from '../dist/infrastructure/product-runtime.service.js';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { createServer, type AddressInfo } from 'node:net';
import {
  core,
  issuer,
  keyA,
  pools,
  runner,
  identity,
  session,
  account,
  stableStep,
  setupStack,
  teardownStack,
} from './product-mfa-stack.helper.ts';

before(setupStack);
after(teardownStack);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('HTTP: session + CSRF on every route, exact bodies, 400/401/403/409, secrets shown once', async (t) => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    MFA_ENCRYPTION_KEYS: `k1:${keyA}`,
    MFA_ENCRYPTION_KEY_ID: 'k1',
    OIDC_PROVIDERS_JSON: JSON.stringify([
      {
        issuer,
        clientId: 'fixture-client',
        redirectUri: `${origin}/api/auth/oidc/callback`,
        version: '1',
        assuranceMappings: [],
      },
    ]),
    ...Object.fromEntries(
      (['data', 'identity', 'authority', 'sync'] as const).map((p) => [
        `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
        `postgres://product_${p}:unused@127.0.0.1:1/product`,
      ]),
    ),
  });
  // The runtime as ProductRuntime.create composes it, over this file's pools (see sign-in spec).
  const Runtime = ProductRuntime as unknown as new (...args: unknown[]) => ProductRuntime;
  const runtime = new Runtime(
    config,
    core,
    pools,
    runner,
    identity,
    new ProductOidcService(identity, new Map()),
  );
  Object.assign(runtime, {
    onApplicationBootstrap: () => Promise.resolve(runtime.readiness.markReady()),
    onApplicationShutdown: () => Promise.resolve(),
  });
  const app: INestApplication = await NestFactory.create(AppModule.register(runtime), {
    logger: false,
    abortOnError: false,
  });
  t.after(() => app.close());
  await app.listen(port, '127.0.0.1');

  const jar = new Map<string, string>();
  let csrf = '';
  /** Max-Age of the last session cookie the server set (from the old deadline). */
  let sessionMaxAge: number | undefined;

  const request = async (path: string, method = 'POST', body?: unknown, withCsrf = true) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        origin,
        ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [first = ''] = cookie.split(';');
      const index = first.indexOf('=');
      jar.set(first.slice(0, index), first.slice(index + 1));
      const maxAge = /;\s*Max-Age=(\d+)/i.exec(cookie)?.[1];
      if (first.startsWith('authz_session=') && maxAge !== undefined)
        sessionMaxAge = Number(maxAge);
    }
    return response;
  };

  const refused = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { statusCode: status, code });
  };

  csrf = ((await (await request('/api/auth/csrf', 'GET')).json()) as { csrfToken: string })
    .csrfToken;
  const routes = [
    ['/api/auth/mfa/totp/setup', 'POST'],
    ['/api/auth/mfa/totp/confirm', 'POST'],
    ['/api/auth/mfa/verify', 'POST'],
    ['/api/auth/mfa/recovery-codes', 'POST'],
    ['/api/auth/mfa/totp', 'DELETE'],
  ] as const;
  for (const [path, method] of routes)
    await refused(await request(path, method, {}), 401, 'error.authenticationFailed');

  const { userId, secret } = await account();
  jar.set('authz_session', secret);
  for (const [path, method] of routes)
    await refused(await request(path, method, {}, false), 403, 'error.accessDenied');

  const own = async () =>
    ((await (await request('/api/auth/account', 'GET')).json()) as { mfa: unknown }).mfa;

  assert.deepEqual(await own(), { status: 'none', recoveryCodesRemaining: 0 });
  await refused(
    await request('/api/auth/mfa/totp/setup', 'POST', { extra: 1 }),
    400,
    'error.invalidRequest',
  );
  const setup = await request('/api/auth/mfa/totp/setup', 'POST');
  assert.equal(setup.status, 200);
  const { uri, secret: shown } = (await setup.json()) as { uri: string; secret: string };
  assert.ok(uri.startsWith('otpauth://totp/HRM:'));
  const account2 = await request('/api/auth/account', 'GET');
  const text = await account2.text();
  assert.ok(!text.includes(shown), 'the secret is shown by setup only');
  assert.deepEqual((JSON.parse(text) as { mfa: unknown }).mfa, {
    status: 'pending',
    recoveryCodesRemaining: 0,
  });
  for (const body of [{ code: '12345' }, { code: '１２３４５６' }, { code: '123456', x: 1 }, {}])
    await refused(
      await request('/api/auth/mfa/totp/confirm', 'POST', body),
      400,
      'error.invalidRequest',
    );
  const raw = base32Decode(shown);
  const step = await stableStep();
  await refused(
    await request('/api/auth/mfa/totp/confirm', 'POST', { code: hotp(raw, step + 3n) }),
    401,
    'error.authenticationFailed',
  );
  const confirmed = await request('/api/auth/mfa/totp/confirm', 'POST', {
    code: hotp(raw, step - 1n),
  });
  assert.equal(confirmed.status, 200);
  const confirmedText = await confirmed.text();
  assert.ok(!confirmedText.includes(shown), 'the secret is shown by setup only');
  const body = JSON.parse(confirmedText) as { expiresAt: string; recoveryCodes: string[] };
  assert.equal(body.recoveryCodes.length, 10);
  assert.notEqual(jar.get('authz_session'), secret, 'confirmation rotates the session cookie');

  // The fixture session ends in 2 h: the cookie keeps that deadline, never a new 12 h one.
  const keepsDeadline = () =>
    assert.ok(
      sessionMaxAge !== undefined && sessionMaxAge > 7000 && sessionMaxAge <= 7200,
      `Max-Age ${sessionMaxAge}`,
    );

  keepsDeadline();
  const accountText = await (await request('/api/auth/account', 'GET')).text();
  for (const code of body.recoveryCodes)
    assert.ok(!accountText.includes(code), 'recovery codes are shown by confirm only');
  assert.deepEqual(await own(), { status: 'enabled', recoveryCodesRemaining: 10 });
  await refused(await request('/api/auth/mfa/totp/setup', 'POST'), 409, 'error.conflict');
  for (const proofBody of [
    { code: hotp(raw, step), recoveryCode: body.recoveryCodes[0] },
    { recoveryCode: 'not-a-code' },
    { recoveryCode: 42 },
  ])
    await refused(
      await request('/api/auth/mfa/verify', 'POST', proofBody),
      400,
      'error.invalidRequest',
    );
  sessionMaxAge = undefined;
  const verified = await request('/api/auth/mfa/verify', 'POST', { code: hotp(raw, step) });
  assert.equal(verified.status, 200);
  assert.deepEqual(Object.keys((await verified.json()) as object), ['expiresAt']);
  keepsDeadline();
  const regenerated = await request('/api/auth/mfa/recovery-codes', 'POST');
  assert.equal(regenerated.status, 200);
  assert.equal(
    ((await regenerated.json()) as { recoveryCodes: string[] }).recoveryCodes.length,
    10,
  );
  // A session without a recent step-up: 403 for regeneration and removal.
  const fresh = jar.get('authz_session') ?? '';
  jar.set('authz_session', await session(userId));
  await refused(await request('/api/auth/mfa/recovery-codes', 'POST'), 403, 'error.accessDenied');
  await refused(await request('/api/auth/mfa/totp', 'DELETE'), 403, 'error.accessDenied');
  jar.set('authz_session', fresh);
  sessionMaxAge = undefined;
  const removed = await request('/api/auth/mfa/totp', 'DELETE');
  assert.equal(removed.status, 200);
  keepsDeadline();
  assert.deepEqual(await own(), { status: 'none', recoveryCodesRemaining: 0 });
  await refused(
    await request('/api/auth/mfa/verify', 'POST', { code: '123456' }),
    409,
    'error.conflict',
  );
});
