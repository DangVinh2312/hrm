// Controller and input of the two account role routes without HTTP: the methods are called
// directly with a recording port. A malformed key or body never reaches the port, Origin and CSRF
// come before any input is parsed and "not found" is a 404. Route, guard and OpenAPI wiring are
// covered by structure.spec.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { AccountController } from '../dist/administration/controllers/account.controller.js';
import type { AdministrationHttpPort } from '../dist/administration/administration.http-port.js';

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
const id = '5f0c2a9e-1b7d-4c3a-9e84-3d6b2f1a7c10';

function fixture(result = true) {
  const calls: unknown[][] = [];

  const record =
    (name: string) =>
    (...args: unknown[]) => (calls.push([name, ...args]), Promise.resolve(result));

  const port = {
    config: { origin },
    assignRole: record('assignRole'),
    revokeRole: record('revokeRole'),
  } as unknown as AdministrationHttpPort;
  return { controller: new AccountController(port), calls };
}

test('POST and DELETE pass the session secret, the id and the role key to the port', async () => {
  const { controller, calls } = fixture();
  assert.deepEqual(await controller.assignRole(good, id, { roleKey: 'hr.admin' }), {
    status: 'assigned',
  });
  assert.deepEqual(await controller.revokeRole(good, id, 'custom.reader'), { status: 'revoked' });
  assert.deepEqual(calls, [
    ['assignRole', 's3cret', id, 'hr.admin'],
    ['revokeRole', 's3cret', id, 'custom.reader'],
  ]);
});

test('"not found" from the port is a 404 for both routes', async () => {
  const { controller } = fixture(false);
  await assert.rejects(controller.assignRole(good, id, { roleKey: 'hr.admin' }), NotFoundException);
  await assert.rejects(controller.revokeRole(good, id, 'hr.admin'), NotFoundException);
});

test('a write without a valid CSRF token or Origin is 403 before the body or the key is parsed', async () => {
  const { controller, calls } = fixture();
  await assert.rejects(controller.assignRole(noCsrf, id, 'garbage'), ForbiddenException);
  await assert.rejects(controller.revokeRole(noCsrf, id, 5 as never), ForbiddenException);
  const evil = { ...good, headers: { ...good.headers, origin: 'http://evil.test' } };
  await assert.rejects(controller.assignRole(evil, id, {}), ForbiddenException);
  assert.equal(calls.length, 0);
});

test('a key that is not a string, empty or over 96 bytes, or a body of another shape, is 400 and never reaches the port', async () => {
  const { controller, calls } = fixture();
  for (const body of [
    null,
    'hr.admin',
    [],
    {},
    { roleKey: 5 },
    { roleKey: null },
    { roleKey: '' },
    { roleKey: 'a'.repeat(97) },
    { roleKey: 'é'.repeat(49) },
    { roleKey: 'hr.admin', managedBy: 'code' },
  ])
    await assert.rejects(controller.assignRole(good, id, body), ProductInvalidRequest);
  for (const key of ['', 'a'.repeat(97), 'é'.repeat(49)])
    await assert.rejects(controller.revokeRole(good, id, key), ProductInvalidRequest);
  assert.equal(calls.length, 0);
});

test('96 bytes is the limit: 96 ASCII or 48 two-byte characters pass', async () => {
  const { controller, calls } = fixture();
  await controller.assignRole(good, id, { roleKey: 'a'.repeat(96) });
  await controller.revokeRole(good, id, 'é'.repeat(48));
  assert.equal(calls.length, 2);
});
