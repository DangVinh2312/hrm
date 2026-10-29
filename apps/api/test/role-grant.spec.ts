// Pure rules of runtime roles (ADR 0041 §3, ADR 0047): key grammar, label, catalog-only grants,
// limits and the canonical digest. No database; declarations come from the real release.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ROLE_GRANTS,
  MAX_RUNTIME_ROLES,
  checkRoleGrants,
  grantsDigest,
  grantsAsFacts,
  isRuntimeRoleKey,
  roleLabel,
} from '../dist/authorization/helpers/role-grant.helper.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';

const declarations = createProductRelease(createProductAuthorizationCore()).declarations;

const grant = (permission: string, template: string, version = 1) => ({
  permission,
  template: { key: template, version },
});

test('runtime role key: custom. + lowercase name of 2..41 characters, nothing else', () => {
  for (const ok of ['custom.ab', 'custom.hr_lead', `custom.a${'b'.repeat(40)}`, 'custom.a1'])
    assert.equal(isRuntimeRoleKey(ok), true, ok);
  for (const bad of [
    'hr.admin',
    'custom.',
    'custom.a',
    'custom.A1',
    'custom.1a',
    'custom.a-b',
    'custom.a.b',
    'Custom.ab',
    ' custom.ab',
    'custom.ab\n',
    `custom.a${'b'.repeat(41)}`,
    'system.root',
    42,
    undefined,
    null,
  ])
    assert.equal(isRuntimeRoleKey(bad), false, String(bad));
});

test('label: trimmed, 1..120 characters, no control character', () => {
  assert.equal(roleLabel('  Người duyệt  '), 'Người duyệt');
  assert.equal(roleLabel('a'.repeat(120)), 'a'.repeat(120));
  for (const bad of ['', '   ', 'a'.repeat(121), 'a\u0000b', 'a\nb', 'a\u007fb', 5, null])
    assert.equal(roleLabel(bad), undefined, String(bad));
});

test('limits are the ADR 0041 §3 numbers', () => {
  assert.equal(MAX_RUNTIME_ROLES, 100);
  assert.equal(MAX_ROLE_GRANTS, 300);
});

test('grants come only from registered (permission, template) pairs of the same resource', () => {
  assert.deepEqual(checkRoleGrants(declarations, [grant('workRequest.read', 'ownRequests')]), {
    ok: true,
  });
  assert.deepEqual(checkRoleGrants(declarations, []), { ok: true });

  const refused = (grants: Parameters<typeof checkRoleGrants>[1], reason: string) =>
    assert.deepEqual(checkRoleGrants(declarations, grants), { ok: false, reason });

  refused([grant('nothing.read', 'ownRequests')], 'unknown_permission');
  refused([grant('workRequest.nothing', 'ownRequests')], 'unknown_permission');
  refused([grant('workRequest', 'ownRequests')], 'unknown_permission');
  refused([grant('workRequest.read.x', 'ownRequests')], 'unknown_permission');
  refused([grant('workRequest.read', 'missingTemplate')], 'unknown_template');
  refused([grant('workRequest.read', 'ownRequests', 9)], 'unknown_template');
  // A real template of another resource: the database foreign key would accept it, the command must not.
  refused([grant('workRequest.read', 'allAccounts')], 'wrong_resource');
  refused([grant('account.read', 'ownRequests')], 'wrong_resource');
  refused(
    [grant('workRequest.read', 'ownRequests'), grant('workRequest.read', 'ownRequests')],
    'duplicate',
  );
  // Prototype-chain names are not catalog entries.
  refused([grant('constructor.read', 'ownRequests')], 'unknown_permission');
  refused([grant('workRequest.constructor', 'ownRequests')], 'unknown_permission');
  refused([grant('workRequest.read', '__proto__')], 'unknown_template');
});

test('more than 300 grants are refused before any lookup', () => {
  const many = Array.from({ length: MAX_ROLE_GRANTS + 1 }, (_, i) => grant(`x${i}.read`, 'y'));
  assert.deepEqual(checkRoleGrants(declarations, many), { ok: false, reason: 'too_many' });
});

test('digest is canonical: order of grants does not matter, content does', () => {
  const a = grant('workRequest.read', 'ownRequests');
  const b = grant('account.read', 'allAccounts');
  assert.equal(grantsDigest([a, b]), grantsDigest([b, a]));
  assert.match(grantsDigest([a, b]), /^[0-9a-f]{64}$/);
  assert.notEqual(grantsDigest([a, b]), grantsDigest([a]));
  assert.notEqual(grantsDigest([a]), grantsDigest([grant('workRequest.read', 'ownRequests', 2)]));
  assert.equal(grantsDigest([]), grantsDigest([]));
});

test('facts of a role grant are plain role allows without parameters', () => {
  assert.deepEqual(grantsAsFacts([grant('account.read', 'allAccounts')]), [
    {
      source: 'role',
      effect: 'allow',
      permission: 'account.read',
      template: { key: 'allAccounts', version: 1 },
      parameters: {},
    },
  ]);
});
