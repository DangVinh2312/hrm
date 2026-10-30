// account.bindBoundary / account.unbindBoundary (ADR-13 D5) without a database: the declarations
// of the package, the pure rules of a boundary reference and the two routes called directly with
// a recording port. Route, guard and OpenAPI wiring are covered by structure.spec.ts; the
// invariants on real PostgreSQL by product-account-boundary.integration-spec.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import { AccountController } from '../dist/administration/controllers/account.controller.js';
import type { AdministrationHttpPort } from '../dist/administration/administration.http-port.js';
import {
  MAX_BOUNDARY_PACKAGE,
  isBoundaryKey,
  isBoundaryVersion,
} from '../dist/authorization/helpers/boundary-binding.helper.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';

const PACKAGE = [
  'account.provision',
  'account.suspend',
  'account.reactivate',
  'account.assignRole',
  'account.revokeRole',
  'account.bindBoundary',
  'account.unbindBoundary',
  'role.update',
  'role.delete',
];

const boundary = productDeclarations.boundaries.find((b) => b.key === 'accountAdministration');

const action = (permission: string) => {
  const [resource, name] = permission.split('.');
  return productDeclarations.resources.find((r) => r.key === resource)?.actions[name!];
};

test('accountAdministration@1 holds exactly the nine permissions, each with the constant scope and no context requirement', () => {
  assert.equal(boundary?.version, 1);
  assert.deepEqual(boundary?.entries.map((e) => e.permission).sort(), [...PACKAGE].sort());
  for (const entry of boundary?.entries ?? []) {
    assert.deepEqual(entry.requiredScope, { op: 'constant', value: true });
    assert.deepEqual(entry.contextRequirements, []);
  }
});

test('every permission of the package is boundary required', () => {
  for (const permission of PACKAGE)
    assert.equal(action(permission)?.boundary, 'required', permission);
});

test('account.bindBoundary and account.unbindBoundary use the fresh policy and no permission of the package has a release grant', () => {
  for (const permission of ['account.bindBoundary', 'account.unbindBoundary']) {
    assert.deepEqual(action(permission)?.policy, { key: 'freshAuthentication', version: 1 });
    assert.equal(
      productReleaseSource.defaultGrants.filter((g) => g.permission === permission).length,
      0,
    );
  }
  assert.equal(
    productReleaseSource.defaultGrants.filter((g) => PACKAGE.includes(g.permission)).length,
    0,
    'no permission of the package has a default grant',
  );
});

test('boundary key and version grammar', () => {
  for (const key of ['accountAdministration', 'a', 'A1._-b', 'a'.repeat(96)])
    assert.equal(isBoundaryKey(key), true, key);
  for (const key of ['', '1a', 'a b', 'a'.repeat(97), 'é', '-a', null, 5, undefined])
    assert.equal(isBoundaryKey(key), false, String(key));
  for (const version of [1, 2, 2147483647]) assert.equal(isBoundaryVersion(version), true);
  for (const version of [0, -1, 1.5, 2147483648, NaN, '1', null, undefined, Infinity])
    assert.equal(isBoundaryVersion(version), false, String(version));
  assert.ok(MAX_BOUNDARY_PACKAGE >= PACKAGE.length);
});

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
    bindBoundary: record('bindBoundary'),
    unbindBoundary: record('unbindBoundary'),
  } as unknown as AdministrationHttpPort;
  return { controller: new AccountController(port), calls };
}

test('POST and DELETE pass the session secret, the id and the parsed reference to the port', async () => {
  const { controller, calls } = fixture();
  const ref = { key: 'accountAdministration', version: 1 };
  assert.deepEqual(await controller.bindBoundary(good, id, ref), { status: 'bound' });
  assert.deepEqual(await controller.unbindBoundary(good, id, 'accountAdministration', '1'), {
    status: 'unbound',
  });
  assert.deepEqual(calls, [
    ['bindBoundary', 's3cret', id, ref],
    ['unbindBoundary', 's3cret', id, ref],
  ]);
});

test('"not found" from the port is a 404 for both routes', async () => {
  const { controller } = fixture(false);
  const ref = { key: 'accountAdministration', version: 1 };
  await assert.rejects(controller.bindBoundary(good, id, ref), NotFoundException);
  await assert.rejects(
    controller.unbindBoundary(good, id, 'accountAdministration', '1'),
    NotFoundException,
  );
});

test('a write without a valid CSRF token or Origin is 403 before the body or the reference is parsed', async () => {
  const { controller, calls } = fixture();
  await assert.rejects(controller.bindBoundary(noCsrf, id, 'garbage'), ForbiddenException);
  await assert.rejects(
    controller.unbindBoundary(noCsrf, id, 5 as never, {} as never),
    ForbiddenException,
  );
  const evil = { ...good, headers: { ...good.headers, origin: 'http://evil.test' } };
  await assert.rejects(controller.bindBoundary(evil, id, {}), ForbiddenException);
  assert.equal(calls.length, 0);
});

test('a malformed reference or body is 400 and never reaches the port', async () => {
  const { controller, calls } = fixture();
  for (const body of [
    null,
    'x',
    [],
    {},
    { key: 'a' },
    { version: 1 },
    { key: 5, version: 1 },
    { key: '', version: 1 },
    { key: 'a b', version: 1 },
    { key: 'a'.repeat(97), version: 1 },
    { key: 'a', version: 0 },
    { key: 'a', version: '1' },
    { key: 'a', version: 1.5 },
    { key: 'a', version: 2147483648 },
    { key: 'a', version: 1, seeded: false },
  ])
    await assert.rejects(controller.bindBoundary(good, id, body), ProductInvalidRequest);
  for (const [key, version] of [
    ['', '1'],
    ['a b', '1'],
    ['a'.repeat(97), '1'],
    ['a', ''],
    ['a', '0'],
    ['a', '01'],
    ['a', '1.5'],
    ['a', '-1'],
    ['a', '2147483648'],
    ['a', '99999999999'],
  ] as const)
    await assert.rejects(controller.unbindBoundary(good, id, key, version), ProductInvalidRequest);
  assert.equal(calls.length, 0);
});

test('the largest key and version pass', async () => {
  const { controller, calls } = fixture();
  await controller.bindBoundary(good, id, { key: 'a'.repeat(96), version: 2147483647 });
  await controller.unbindBoundary(good, id, 'a'.repeat(96), '2147483647');
  assert.equal(calls.length, 2);
});
