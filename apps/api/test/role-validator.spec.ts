// Input of role.create / role.update / role.delete: every limit and shape is decided from
// `unknown` before any transaction. Pure; the catalog is the real release.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import {
  checkRoleCatalog,
  parseRoleCreate,
  parseRoleKey,
  parseRoleUpdate,
} from '../dist/modules/role/role.validator.js';
import { lacksFinalDecision } from '../dist/modules/role/role-risk.helper.js';

const declarations = createProductRelease(createProductAuthorizationCore()).declarations;

const grant = (permission: string, template: string, version = 1) => ({
  permission,
  template: { key: template, version },
});

const digest = 'a'.repeat(64);

const invalid = (run: () => unknown) => assert.throws(run, ProductInvalidRequest);

test('key: only custom.<name>; anything else is 400 before any lookup', () => {
  assert.equal(parseRoleKey('custom.hr_lead'), 'custom.hr_lead');
  for (const bad of ['hr.admin', 'custom.', 'custom.A', `custom.a${'b'.repeat(41)}`, 5, null, ''])
    invalid(() => parseRoleKey(bad));
});

test('create body: exactly key, label, grants; label trimmed; unknown keys refused', () => {
  const body = {
    key: 'custom.reader',
    label: '  Người đọc  ',
    grants: [grant('role.read', 'role')],
  };
  assert.deepEqual(parseRoleCreate(body), {
    key: 'custom.reader',
    label: 'Người đọc',
    grants: [grant('role.read', 'role')],
  });
  invalid(() => parseRoleCreate({ ...body, managedBy: 'code' }));
  invalid(() => parseRoleCreate({ key: body.key, label: body.label }));
  invalid(() => parseRoleCreate({ ...body, key: 'hr.admin' }));
  invalid(() => parseRoleCreate({ ...body, label: '' }));
  invalid(() => parseRoleCreate({ ...body, label: 'a'.repeat(121) }));
  invalid(() => parseRoleCreate({ ...body, label: 'a\u0000b' }));
  for (const bad of [null, [], 'x', 5, undefined]) invalid(() => parseRoleCreate(bad));
});

test('create body: label of exactly 120 code points is accepted, grants of exactly 300 are accepted', () => {
  const grants = Array.from({ length: 300 }, (_, i) => grant(`p.a${i}`, 't'));
  assert.equal(
    parseRoleCreate({ key: 'custom.edge', label: '😀'.repeat(120), grants }).grants.length,
    300,
  );
  invalid(() =>
    parseRoleCreate({ key: 'custom.edge', label: 'x', grants: [...grants, grant('p.z', 't')] }),
  );
});

test('grants: shape, duplicates and parameters are 400', () => {
  const base = { key: 'custom.reader', label: 'x' };
  const ok = grant('role.read', 'role');
  invalid(() => parseRoleCreate({ ...base, grants: 'x' }));
  invalid(() => parseRoleCreate({ ...base, grants: [null] }));
  invalid(() => parseRoleCreate({ ...base, grants: [{ permission: 'role.read' }] }));
  invalid(() => parseRoleCreate({ ...base, grants: [{ ...ok, parameters: {} }] }));
  invalid(() => parseRoleCreate({ ...base, grants: [{ ...ok, effect: 'deny' }] }));
  invalid(() =>
    parseRoleCreate({ ...base, grants: [{ permission: 'role.read', template: 'role' }] }),
  );
  invalid(() =>
    parseRoleCreate({
      ...base,
      grants: [{ permission: 'role.read', template: { key: 'role', version: 1, extra: 1 } }],
    }),
  );
  for (const version of [0, -1, 1.5, '1', 2 ** 31])
    invalid(() =>
      parseRoleCreate({
        ...base,
        grants: [{ permission: 'role.read', template: { key: 'role', version } }],
      }),
    );
  invalid(() => parseRoleCreate({ ...base, grants: [ok, ok] }));
  invalid(() => parseRoleCreate({ ...base, grants: [{ ...ok, permission: 5 }] }));
});

test('update body: label, grants and a sha-256 expectedDigest for the key of the route', () => {
  const body = { label: 'Đọc', grants: [grant('role.read', 'role')], expectedDigest: digest };
  assert.deepEqual(parseRoleUpdate('custom.reader', body), {
    key: 'custom.reader',
    label: 'Đọc',
    grants: body.grants,
    expectedDigest: digest,
  });
  invalid(() => parseRoleUpdate('hr.admin', body));
  invalid(() => parseRoleUpdate('custom.reader', { ...body, key: 'custom.other' }));
  for (const bad of [undefined, 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 5])
    invalid(() => parseRoleUpdate('custom.reader', { ...body, expectedDigest: bad }));
  invalid(() => parseRoleUpdate('custom.reader', { label: 'x', grants: [] }));
});

test('catalog: the permission and the template must be declared for the same resource, never document', () => {
  const ok = [grant('role.read', 'role'), grant('employee.read', 'allEmployees')];
  assert.doesNotThrow(() => checkRoleCatalog(declarations, ok));
  invalid(() => checkRoleCatalog(declarations, [grant('nope.read', 'role')]));
  invalid(() => checkRoleCatalog(declarations, [grant('role.nope', 'role')]));
  invalid(() => checkRoleCatalog(declarations, [grant('role.read', 'allEmployees')]));
  invalid(() => checkRoleCatalog(declarations, [grant('role.read', 'role', 2)]));
  invalid(() => checkRoleCatalog(declarations, [grant('document.read', 'ownedDocuments')]));
  invalid(() => checkRoleCatalog(declarations, [grant('document.update', 'ownedDocuments')]));
});

test('catalog: approvals without decideFinal is refused, both together or neither pass', () => {
  assert.equal(lacksFinalDecision([grant('hrCompany.approvals', 'company')]), true);
  assert.equal(
    lacksFinalDecision([
      grant('hrCompany.approvals', 'company'),
      grant('workRequest.decideFinal', 'finalQueue'),
    ]),
    false,
  );
  assert.equal(lacksFinalDecision([grant('workRequest.decideFinal', 'finalQueue')]), false);
  assert.equal(lacksFinalDecision([]), false);
  invalid(() => checkRoleCatalog(declarations, [grant('hrCompany.approvals', 'company')]));
  assert.doesNotThrow(() =>
    checkRoleCatalog(declarations, [
      grant('hrCompany.approvals', 'company'),
      grant('workRequest.decideFinal', 'finalQueue'),
    ]),
  );
});
