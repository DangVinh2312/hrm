// Pure rules of runtime roles: key grammar, label, catalog-only grants,
// limits and the canonical digest. No database; declarations come from the real release.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('limits are 100 runtime roles and 300 grants per role', () => {
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

test('digest is canonical and covers the label and the grants: order of grants does not matter, content does', () => {
  const a = grant('workRequest.read', 'ownRequests');
  const b = grant('account.read', 'allAccounts');
  assert.equal(grantsDigest('Label', [a, b]), grantsDigest('Label', [b, a]));
  assert.match(grantsDigest('Label', [a, b]), /^[0-9a-f]{64}$/);
  assert.notEqual(grantsDigest('Label', [a, b]), grantsDigest('Label', [a]));
  assert.notEqual(
    grantsDigest('Label', [a]),
    grantsDigest('Label', [grant('workRequest.read', 'ownRequests', 2)]),
  );
  assert.equal(grantsDigest('Label', []), grantsDigest('Label', []));
  assert.notEqual(grantsDigest('Label', [a, b]), grantsDigest('Other', [a, b]));
  assert.notEqual(grantsDigest('Label', []), grantsDigest('Label ', []));
});

test('digest is the SHA-256 of the canonical JSON of [label, sorted canonical grants]', () => {
  const rows = [
    JSON.stringify(['account.read', 'allAccounts', 1]),
    JSON.stringify(['workRequest.read', 'ownRequests', 1]),
  ];
  const expected = createHash('sha256')
    .update(JSON.stringify(['Người duyệt', rows]))
    .digest('hex');
  assert.equal(
    grantsDigest('Người duyệt', [
      grant('workRequest.read', 'ownRequests'),
      grant('account.read', 'allAccounts'),
    ]),
    expected,
  );
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
