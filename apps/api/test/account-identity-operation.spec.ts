// account.changeEmail / resetMfa / resetGoogleBinding (ADR-15 D11) without a database: the
// declarations of the three actions and of identityAdministration@1, the release that adds them
// and the three routes called directly with a recording port. Route, guard and OpenAPI wiring are
// covered by structure.spec.ts; the invariants on real PostgreSQL by
// product-identity-operation*.integration-spec.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccountController } from '../dist/administration/controllers/account.controller.js';
import type { AdministrationHttpPort } from '../dist/administration/administration.http-port.js';
import {
  accountBinding,
  accountDeclarations,
} from '../dist/administration/account.declarations.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../dist/authorization/product.manifest.js';
import { highRiskGrantPairs } from '../dist/modules/role/role-risk.helper.js';

const IDENTITY = ['account.changeEmail', 'account.resetMfa', 'account.resetGoogleBinding'];

const boundary = productDeclarations.boundaries.find((b) => b.key === 'identityAdministration');

const action = (permission: string) => {
  const [resource, name] = permission.split('.');
  return productDeclarations.resources.find((r) => r.key === resource)?.actions[name!];
};

test('identityAdministration@1 holds exactly the three identity permissions, each with the constant scope and no context requirement', () => {
  assert.equal(boundary?.version, 1);
  assert.deepEqual(boundary?.entries.map((e) => e.permission).sort(), [...IDENTITY].sort());
  for (const entry of boundary?.entries ?? []) {
    assert.deepEqual(entry.requiredScope, { op: 'constant', value: true });
    assert.deepEqual(entry.contextRequirements, []);
  }
});

test('accountAdministration@1 is unchanged: none of the identity permissions joined it', () => {
  const administration = productDeclarations.boundaries.find(
    (b) => b.key === 'accountAdministration',
  );
  assert.equal(administration?.version, 1);
  assert.equal(administration?.entries.length, 9);
  for (const permission of IDENTITY)
    assert.equal(
      administration?.entries.some((e) => e.permission === permission),
      false,
      permission,
    );
});

test('the three actions are boundary required with the fresh policy (which carries the audit obligation)', () => {
  for (const permission of IDENTITY) {
    assert.equal(action(permission)?.boundary, 'required', permission);
    assert.deepEqual(action(permission)?.policy, { key: 'freshAuthentication', version: 1 });
  }
  const policy = accountDeclarations.policies.find((p) => p.key === 'freshAuthentication');
  assert.deepEqual(
    policy?.contextRequirements.map((r) => r.validator),
    ['fresh@1'],
  );
  assert.deepEqual(
    policy?.obligations.map((o) => o.handler),
    ['audit@1'],
  );
});

test('no identity permission has a release grant, in any role', () => {
  assert.equal(
    productReleaseSource.defaultGrants.filter((g) => IDENTITY.includes(g.permission)).length,
    0,
  );
});

test('every account action acts on the IAM-only projection, so none can name a Root account', () => {
  assert.equal(accountBinding.table, 'account_directory');
  const account = accountDeclarations.resources.find((r) => r.key === 'account');
  for (const name of Object.keys(account?.actions ?? {}))
    assert.equal(/root/i.test(name), false, name);
  for (const permission of IDENTITY) assert.equal(/root/i.test(permission), false);
});

test('the identity pairs are in the high-risk registry with every allAccounts template', () => {
  const pairs = highRiskGrantPairs.filter((p) => IDENTITY.includes(p.permission));
  assert.deepEqual(
    pairs.map((p) => [p.permission, p.template, p.risk]).sort(),
    IDENTITY.map((p) => [p, 'allAccounts', 'accountAdministration']).sort(),
  );
});

test('release sequence 5 over 4', () => {
  assert.deepEqual([productReleaseSource.sequence, productReleaseSource.predecessor], ['5', '4']);
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
    changeEmail: record('changeEmail'),
    resetMfa: record('resetMfa'),
    resetGoogleBinding: record('resetGoogleBinding'),
  } as unknown as AdministrationHttpPort;
  return { controller: new AccountController(port), calls };
}

test('the three routes pass the session secret, the id and (for the email) the email to the port and answer with a status only', async () => {
  const { controller, calls } = fixture();
  assert.deepEqual(await controller.changeEmail(good, id, { email: 'New.Person@Example.test' }), {
    status: 'changed',
  });
  assert.deepEqual(await controller.resetMfa(good, id), { status: 'reset' });
  assert.deepEqual(await controller.resetGoogleBinding(good, id), { status: 'reset' });
  assert.deepEqual(calls, [
    ['changeEmail', 's3cret', id, 'New.Person@Example.test'],
    ['resetMfa', 's3cret', id],
    ['resetGoogleBinding', 's3cret', id],
  ]);
});

test('"not found" from the port is a 404 for all three routes', async () => {
  const { controller } = fixture(false);
  await assert.rejects(controller.changeEmail(good, id, { email: 'a@b.test' }), NotFoundException);
  await assert.rejects(controller.resetMfa(good, id), NotFoundException);
  await assert.rejects(controller.resetGoogleBinding(good, id), NotFoundException);
});

test('a write without a valid CSRF token or Origin is 403 before the body is parsed', async () => {
  const { controller, calls } = fixture();
  await assert.rejects(controller.changeEmail(noCsrf, id, 'garbage'), ForbiddenException);
  await assert.rejects(controller.resetMfa(noCsrf, id), ForbiddenException);
  await assert.rejects(controller.resetGoogleBinding(noCsrf, id), ForbiddenException);
  const evil = { ...good, headers: { ...good.headers, origin: 'http://evil.test' } };
  await assert.rejects(controller.changeEmail(evil, id, {}), ForbiddenException);
  await assert.rejects(controller.resetMfa(evil, id), ForbiddenException);
  assert.equal(calls.length, 0);
});

test('the email body is an allowlist of one string field; anything else is 400 and never reaches the port', async () => {
  const { controller, calls } = fixture();
  for (const body of [
    null,
    'a@b.test',
    [],
    {},
    { email: 5 },
    { email: null },
    { email: 'a@b.test', state: 'active' },
    { email: 'a@b.test', authEpoch: 9 },
    { email: 'x'.repeat(2049) },
  ])
    await assert.rejects(controller.changeEmail(good, id, body), BadRequestException);
  assert.equal(calls.length, 0);
});
