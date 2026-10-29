// Controller mapping of the three role write routes without HTTP: the methods are called
// directly with a recording port. Proves the session secret and the parsed input reach the port,
// that Origin and CSRF are enforced before any input is parsed and that a malformed key or body
// never reaches the port. Route, guard and OpenAPI wiring are covered by structure.spec.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { RoleController } from '../dist/modules/role/role.controller.js';
import type { RoleHttpPort } from '../dist/modules/role/role.http-port.js';

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
const digest = 'f'.repeat(64);
const grant = { permission: 'role.read', template: { key: 'role', version: 1 } };

function fixture() {
  const calls: unknown[][] = [];

  const record =
    (name: string, result: unknown) =>
    (...args: unknown[]) => (calls.push([name, ...args]), Promise.resolve(result));

  const port = {
    config: { origin },
    list: record('list', undefined),
    accountPermissions: record('accountPermissions', undefined),
    create: record('create', { key: 'custom.ab', digest }),
    update: record('update', { key: 'custom.ab', digest }),
    remove: record('remove', { status: 'deleted' }),
  } as unknown as RoleHttpPort;
  return { controller: new RoleController(port), calls };
}

test('POST, PUT and DELETE pass the session secret and the parsed input to the port', async () => {
  const { controller, calls } = fixture();
  await controller.create(good, { key: 'custom.ab', label: ' Nhãn ', grants: [grant] });
  await controller.update(good, 'custom.ab', { label: 'Nhãn', grants: [], expectedDigest: digest });
  await controller.remove(good, 'custom.ab');
  assert.deepEqual(calls, [
    ['create', 's3cret', { key: 'custom.ab', label: 'Nhãn', grants: [grant] }],
    ['update', 's3cret', { key: 'custom.ab', label: 'Nhãn', grants: [], expectedDigest: digest }],
    ['remove', 's3cret', 'custom.ab'],
  ]);
});

test('a write without a valid CSRF token or Origin is 403 before the body or the key is parsed', () => {
  const { controller, calls } = fixture();
  assert.throws(() => controller.create(noCsrf, 'garbage'), ForbiddenException);
  assert.throws(() => controller.update(noCsrf, 'not a key', null), ForbiddenException);
  assert.throws(() => controller.remove(noCsrf, 'not a key'), ForbiddenException);
  const evil = { ...good, headers: { ...good.headers, origin: 'http://evil.test' } };
  assert.throws(() => controller.create(evil, {}), ForbiddenException);
  assert.equal(calls.length, 0);
});

test('a malformed key or body is 400 and never reaches the port', () => {
  const { controller, calls } = fixture();
  assert.throws(
    () => controller.create(good, { key: 'hr.admin', label: 'x', grants: [] }),
    ProductInvalidRequest,
  );
  assert.throws(
    () => controller.create(good, { key: 'custom.ab', label: 'x', grants: [], managedBy: 'code' }),
    ProductInvalidRequest,
  );
  assert.throws(
    () => controller.update(good, 'hr.admin', { label: 'x', grants: [], expectedDigest: digest }),
    ProductInvalidRequest,
  );
  assert.throws(
    () => controller.update(good, 'custom.ab', { label: 'x', grants: [] }),
    ProductInvalidRequest,
  );
  assert.throws(() => controller.remove(good, 'hr.admin'), ProductInvalidRequest);
  assert.throws(() => controller.remove(good, `custom.ab${'b'.repeat(60)}`), ProductInvalidRequest);
  assert.equal(calls.length, 0);
});
