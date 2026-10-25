// Controller mapping of the setting routes without HTTP: the methods are called directly with a
// recording port. Proves which group each PUT route passes, that CSRF is enforced before any input
// is parsed, and that an unreachable read is 404. Cookie, guard and route wiring are covered by
// structure.spec.ts (route inventory); no real HTTP or e2e is run here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { SettingController } from '../dist/modules/setting/setting.controller.js';
import type { SettingHttpPort } from '../dist/modules/setting/setting.http-port.js';

const origin = new URL('http://127.0.0.1:3000');
const csrf = 'A'.repeat(43);
const good = {
  headers: {
    origin: origin.origin,
    'x-csrf-token': csrf,
    cookie: `authz_csrf=${csrf}; authz_session=s3cret`,
  },
  originalUrl: '/',
};
const noCsrf = {
  headers: { origin: origin.origin, cookie: 'authz_session=s3cret' },
  originalUrl: '/',
};

function fixture(read: unknown = undefined) {
  const calls: unknown[][] = [];
  const port = {
    config: { origin },
    list: (...args: unknown[]) => (calls.push(['list', ...args]), Promise.resolve(read)),
    profile: (...args: unknown[]) => (calls.push(['profile', ...args]), Promise.resolve(read)),
    security: (...args: unknown[]) => (calls.push(['security', ...args]), Promise.resolve(read)),
    history: (...args: unknown[]) => (calls.push(['history', ...args]), Promise.resolve(read)),
    update: (...args: unknown[]) => (
      calls.push(['update', ...args]),
      Promise.resolve({ version: '1' })
    ),
  } as unknown as SettingHttpPort;
  return { controller: new SettingController(port), calls };
}

test('PUT rule/:key parses for group rule and PUT profile/:key for group profile, with the session secret', async () => {
  const { controller, calls } = fixture();
  await controller.updateRule(good, 'hr.wfhMonthLimit', { value: 6, expectedVersion: '0' });
  await controller.updateProfile(good, 'company.name', { value: 'X', expectedVersion: '0' });
  assert.deepEqual(calls, [
    ['update', 's3cret', { key: 'hr.wfhMonthLimit', value: 6, expectedVersion: '0' }],
    ['update', 's3cret', { key: 'company.name', value: 'X', expectedVersion: '0' }],
  ]);
  // A key of the other group is refused before the port is reached.
  assert.throws(
    () => controller.updateRule(good, 'company.name', { value: 'X', expectedVersion: '0' }),
    ProductInvalidRequest,
  );
  assert.throws(
    () => controller.updateProfile(good, 'hr.wfhMonthLimit', { value: 6, expectedVersion: '0' }),
    ProductInvalidRequest,
  );
  assert.equal(calls.length, 2);
});

test('a PUT without a valid CSRF token is 403 before the body is parsed', () => {
  const { controller, calls } = fixture();
  // The body is invalid too: the CSRF failure must win (403, not 400).
  assert.throws(
    () => controller.updateRule(noCsrf, 'hr.wfhMonthLimit', 'garbage'),
    ForbiddenException,
  );
  assert.throws(() => controller.updateProfile(noCsrf, 'company.name', null), ForbiddenException);
  assert.throws(
    () =>
      controller.updateRule(
        { ...good, headers: { ...good.headers, origin: 'http://evil.test' } },
        'hr.wfhMonthLimit',
        {},
      ),
    ForbiddenException,
  );
  assert.equal(calls.length, 0);
});

test('a read that reaches nothing (undefined) is 404, a view is returned as is', async () => {
  const empty = fixture(undefined);
  await assert.rejects(empty.controller.list(good), NotFoundException);
  await assert.rejects(empty.controller.profile(good), NotFoundException);
  await assert.rejects(empty.controller.security(good), NotFoundException);
  await assert.rejects(empty.controller.history(good, 'hr.wfhMonthLimit', {}), NotFoundException);
  const view = { items: [], total: '0' };
  assert.equal(
    await fixture(view).controller.history(good, 'hr.wfhMonthLimit', { limit: '5' }),
    view,
  );
  // The key and the page are validated before the port.
  await assert.rejects(
    Promise.resolve().then(() => empty.controller.history(good, 'nope', {})),
    ProductInvalidRequest,
  );
  assert.equal(empty.calls.filter(([name]) => name === 'history').length, 1);
});
