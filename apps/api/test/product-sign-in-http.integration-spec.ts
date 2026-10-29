// Sign-in methods: the HTTP callback targets and account projection.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ProductOidcService } from '../dist/authentication/services/product-oidc.service.js';
import { AppModule } from '../dist/app.module.js';
import { loadConfig } from '../dist/config/app.config.js';
import { ProductRuntime } from '../dist/infrastructure/product-runtime.service.js';
import {
  core,
  issuer,
  pools,
  runner,
  identity,
  responseFor,
  fixtureProvider,
  setupStack,
  teardownStack,
} from './product-sign-in-stack.helper.ts';
import { account, bind, verified, cancelledFor } from './product-sign-in-fixtures.helper.ts';

before(setupStack);
after(teardownStack);

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

test('HTTP: fixed callback targets, removed link and reauth routes are 404, account projection without subject or removable', async (t) => {
  const appPort = await freePort();
  const origin = `http://127.0.0.1:${appPort}`;
  const callbackUri = `${origin}/api/auth/oidc/callback`;
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    MFA_ENCRYPTION_KEYS: `fixture:${randomBytes(32).toString('base64')}`,
    MFA_ENCRYPTION_KEY_ID: 'fixture',
    OIDC_PROVIDERS_JSON: JSON.stringify([
      {
        issuer,
        clientId: 'fixture-client',
        redirectUri: callbackUri,
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
  const service = new ProductOidcService(
    identity,
    new Map([[issuer, fixtureProvider(issuer, '1', callbackUri)]]),
  );
  // The runtime as ProductRuntime.create composes it, over this file's pools; its bootstrap
  // (privilege probe of application tables, manifest sync) is covered elsewhere.
  const Runtime = ProductRuntime as unknown as new (...args: unknown[]) => ProductRuntime;
  const runtime = new Runtime(config, core, pools, runner, identity, service);
  Object.assign(runtime, {
    onApplicationBootstrap: () => Promise.resolve(runtime.readiness.markReady()),
    onApplicationShutdown: () => Promise.resolve(),
  });
  const app: INestApplication = await NestFactory.create(AppModule.register(runtime), {
    logger: false,
    abortOnError: false,
  });
  t.after(() => app.close());
  await app.listen(appPort, '127.0.0.1');

  const user = await account();
  await bind(user.id, issuer, 'http-subject');
  const jar = new Map<string, string>();
  let csrf = '';

  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      redirect: 'manual',
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        origin,
        'x-csrf-token': csrf,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';')[0]!;
      const index = first.indexOf('=');
      jar.set(first.slice(0, index), first.slice(index + 1));
    }
    return response;
  };

  /** begin over HTTP, then the provider's answer (code or error) back to the callback. */
  const signIn = async (answer: (start: URL) => URL) => {
    const begun = await request('/api/auth/oidc/begin', 'POST', { issuer });
    assert.equal(begun.status, 200);
    const { authorizationUrl } = (await begun.json()) as { authorizationUrl: string };
    const back = answer(new URL(authorizationUrl));
    return request(back.pathname + back.search);
  };

  const removed = [
    ['/api/auth/oidc/link', 'POST'],
    ['/api/auth/oidc/link/pending', 'GET'],
    ['/api/auth/oidc/link/pending', 'DELETE'],
    ['/api/auth/oidc/link/confirm', 'POST'],
    ['/api/auth/oidc/unlink', 'POST'],
    ['/api/auth/oidc/reauthenticate', 'POST'],
    // Local sign-in is gone too.
    ['/api/auth/login', 'POST'],
    ['/api/auth/activate', 'POST'],
    ['/api/auth/reauthenticate', 'POST'],
    ['/api/auth/password', 'POST'],
    ['/api/auth/recovery/request', 'POST'],
    ['/api/auth/recovery/reset', 'POST'],
  ] as const;

  const notFound = async () => {
    for (const [path, method] of removed) {
      const response = await request(path, method, method === 'GET' ? undefined : { issuer });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { statusCode: 404, code: 'error.notFound' });
    }
  };

  csrf = ((await (await request('/api/auth/csrf')).json()) as { csrfToken: string }).csrfToken;
  await notFound();
  // One sign-in method; the shape of the public options stays.
  const options = await request('/api/auth/options');
  assert.equal(options.status, 200);
  assert.deepEqual(await options.json(), { methods: ['oidc'] });
  // No attempt (unknown state), or a cancelled login: the login page.
  const unknown = await request('/api/auth/oidc/callback?state=unknown-state&code=x');
  assert.equal(unknown.status, 303);
  assert.equal(unknown.headers.get('location'), '/login?error=oidc');
  const cancelled = await signIn(cancelledFor);
  assert.equal(cancelled.status, 303);
  assert.equal(cancelled.headers.get('location'), '/login?error=oidc');
  const signedIn = await signIn((start) =>
    responseFor(start, verified('http-subject', user.email)),
  );
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/');
  assert.equal((await request('/api/auth/session')).status, 200);
  // Signed in, the removed routes are still unknown (not 401/403: nothing is left to refuse).
  await notFound();

  const own = await request('/api/auth/account');
  assert.equal(own.status, 200);
  const ownBody = (await own.json()) as { identities: Record<string, unknown>[] };
  assert.equal(JSON.stringify(ownBody).includes('http-subject'), false);
  // The projection also carries the second factor status, nothing more of it.
  assert.deepEqual(Object.keys(ownBody).sort(), ['email', 'identities', 'mfa']);
  assert.deepEqual((ownBody as { mfa?: unknown }).mfa, {
    status: 'none',
    recoveryCodesRemaining: 0,
  });
  // Nothing is removable any more, so the flag is gone.
  assert.deepEqual(
    ownBody.identities.map((i) => Object.keys(i).sort()),
    [['issuer', 'reference']],
  );
});
