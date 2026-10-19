import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { loadConfig } from '../dist/config/app.config.js';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
} from '../dist/authorization/services/product-authority.service.js';
import {
  ProductAuthenticationError,
  rateLimitClient,
} from '../dist/auth/services/product-identity.service.js';
import {
  bodyFields,
  enforceCsrf,
  cookieName,
  sessionSecret,
} from '../dist/infrastructure/http-security.helper.js';
import { ProductErrorFilter } from '../dist/infrastructure/product-error.filter.js';
import { API_ERROR_CODES, apiErrorCode } from '../dist/infrastructure/api-error.helper.js';
import { ProductMetrics } from '../dist/health/services/product-metrics.service.js';

const env = {
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:3000',
  OIDC_PROVIDERS_JSON: JSON.stringify([
    {
      issuer: 'https://idp.example.test',
      clientId: 'fixture-client',
      redirectUri: 'http://localhost:3000/api/auth/oidc/callback',
      version: '1',
      assuranceMappings: [],
    },
  ]),
  MFA_ENCRYPTION_KEYS: 'fixture:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  MFA_ENCRYPTION_KEY_ID: 'fixture',
  ...Object.fromEntries(
    ['data', 'identity', 'authority', 'sync'].map((p) => [
      `PRODUCT_${p.toUpperCase()}_DATABASE_URL`,
      `postgres://product_${p}:synthetic@localhost/product`,
    ]),
  ),
};
const config = loadConfig(env);
test('HTTP mutations require exact trusted Origin and matching canonical CSRF cookie/header', () => {
  const token = 'a'.repeat(43);
  const req = {
    headers: {
      origin: config.origin.origin,
      cookie: `${cookieName(config, 'csrf')}=${token}`,
      'x-csrf-token': token,
    },
    originalUrl: '/api/auth/login',
  };
  assert.doesNotThrow(() => enforceCsrf(req, config));
  assert.throws(() =>
    enforceCsrf({ ...req, headers: { ...req.headers, origin: 'https://attacker.test' } }, config),
  );
  assert.throws(() =>
    enforceCsrf({ ...req, headers: { ...req.headers, 'x-csrf-token': 'b'.repeat(43) } }, config),
  );
  assert.throws(() =>
    bodyFields({ email: 'a', password: 'b', managed_by: 'code' }, ['email', 'password']),
  );
});
test('runtime metrics keep finite mode labels and cumulative bounded histograms', () => {
  const m = new ProductMetrics();
  m.observe('lock_wait', 'read', 10);
  m.observe('lock_wait', 'read', 100);
  const [row] = m.snapshot();
  assert.equal(row?.count, 2);
  assert.equal(row?.sum, 110);
  assert.equal(row?.buckets.find((b) => b.upper === 10)?.count, 1);
  assert.equal(row?.buckets.at(-1)?.count, 2);
  assert.equal(m.snapshot().length, 1);
});
test('trusted proxy hops are explicit: direct by default, bounded count otherwise', () => {
  assert.equal(config.trustProxy, 0);
  assert.equal(loadConfig({ ...env, TRUST_PROXY: '1' }).trustProxy, 1);
  for (const value of ['true', '-1', '10', '1.5', 'loopback'])
    assert.throws(() => loadConfig({ ...env, TRUST_PROXY: value }), /TRUST_PROXY/);
});
test('only own cookies are parsed: foreign junk is ignored, a repeated own cookie fails closed', () => {
  const name = cookieName(config, 'session');

  const req = (cookie: string) => ({ headers: { cookie }, originalUrl: '/' });

  assert.equal(sessionSecret(req(`junk; a=1; a=2; ${name}=s; =x`), config), 's');
  assert.throws(() => sessionSecret(req(`${name}=s; ${name}=t`), config));
});
test('error filter: caller input is 400, programming faults are 503 and logged', () => {
  const bodies: unknown[] = [];

  const status = (error: unknown) => {
    let code = 0;
    new ProductErrorFilter().catch(error, {
      switchToHttp: () => ({
        getResponse: () => ({
          status: (c: number) => ((code = c), { json: (body: unknown) => bodies.push(body) }),
        }),
      }),
    } as never);
    return code;
  };

  const logged: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeError = process.stderr.write.bind(process.stderr);
  process.stdout.write = process.stderr.write = ((chunk: string | Uint8Array) =>
    logged.push(String(chunk)) > 0) as typeof process.stdout.write;
  try {
    assert.equal(status(new ProductInvalidRequest('bad key')), 400);
    // A command's business refusal (stale version, wrong state) is a conflict, not a fault.
    assert.equal(status(new ProductCommandRejected('invalid_transition')), 409);
    // A deliberate 503 (an unconfigured capability, e.g. provisioning without one issuer).
    const unavailable: unknown = new ServiceUnavailableException();
    assert.equal(status(unavailable), 503);
    assert.equal(logged.length, 0, 'deliberate HTTP responses are not logged');
    const fault = new TypeError(
      'secret-value\nsecond-line person@example.test\n    at injected-frame (person@example.test)',
    );
    assert.equal(status(fault), 503);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeError;
  }
  const log = logged.join('');
  assert.match(log, /TypeError/);
  assert.match(log, / at /);
  assert.doesNotMatch(log, /secret-value|second-line|person@|injected-frame/);
  // Bodies carry only the status and its locale key, never the error's message or payload.
  assert.deepEqual(bodies, [
    { statusCode: 400, code: 'error.invalidRequest' },
    { statusCode: 409, code: 'error.conflict' },
    { statusCode: 503, code: 'error.unavailable' },
    { statusCode: 503, code: 'error.unavailable' },
  ]);
});
test('error keys follow the status only and stay in the closed set', () => {
  for (const [status, code] of Object.entries({
    400: 'error.invalidRequest',
    401: 'error.authenticationFailed',
    403: 'error.accessDenied',
    404: 'error.notFound',
    409: 'error.conflict',
    413: 'error.invalidRequest',
    500: 'error.unavailable',
    503: 'error.unavailable',
  }))
    assert.equal(apiErrorCode(Number(status)), code);
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 503])
    assert.ok(API_ERROR_CODES.includes(apiErrorCode(status)));
  const bodies: unknown[] = [];

  const respond = (error: unknown) =>
    new ProductErrorFilter().catch(error, {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json: (body: unknown) => bodies.push(body) }) }),
      }),
    } as never);

  respond(new ProductAuthenticationError());
  respond(new ProductAccessDenied());
  respond(new NotFoundException('document 42 belongs to someone else'));
  respond(new ServiceUnavailableException({ status: 'not_ready', code: 'error.custom' }));
  assert.deepEqual(bodies, [
    { statusCode: 401, code: 'error.authenticationFailed' },
    { statusCode: 403, code: 'error.accessDenied' },
    { statusCode: 404, code: 'error.notFound' },
    { statusCode: 503, code: 'error.unavailable' },
  ]);
});
test('limiter groups an IPv6 /64 into one client, unmaps IPv4 forms and drops ports', () => {
  assert.equal(rateLimitClient('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitClient('2001:db8:1:2:bbbb:cccc:dddd:eeee'), '2001:db8:1:2::/64');
  assert.equal(rateLimitClient('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitClient('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(rateLimitClient('::ffff:192.0.2.1'), '192.0.2.1');
  for (const v4 of [
    '::1.2.3.4',
    '::ffff:0102:0304',
    '0:0:0:0:0:ffff:1.2.3.4',
    '64:ff9b::102:304',
    '1.2.3.4:5678',
  ])
    assert.equal(rateLimitClient(v4), '1.2.3.4', v4);
  assert.equal(rateLimitClient('[2001:db8::1]:443'), '2001:db8:0:0::/64');
  assert.equal(rateLimitClient('192.0.2.1'), '192.0.2.1');
  assert.equal(rateLimitClient('unknown'), 'unknown');
});
