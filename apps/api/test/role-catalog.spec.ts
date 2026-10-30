// The (permission, template) pairs a runtime role may pick, derived from the release compiled from
// src: same resource, no parameters, never `document`, and the pairs `checkRoleCatalog` accepts once
// `hrCompany.approvals` comes with `workRequest.decideFinal`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductInvalidRequest } from '../dist/authorization/product-data.gateway.js';
import {
  createProductAuthorizationCore,
  createProductRelease,
} from '../dist/authorization/product.manifest.js';
import { MAX_ROLE_CATALOG_PAIRS, roleCatalog } from '../dist/modules/role/role-catalog.helper.js';
import { checkRoleCatalog } from '../dist/modules/role/role.validator.js';

const declarations = createProductRelease(createProductAuthorizationCore()).declarations;

const finalDecision = {
  permission: 'workRequest.decideFinal',
  template: { key: 'finalQueue', version: 1 },
};

// A lone `hrCompany.approvals` is refused on its own (`lacksFinalDecision`), so it is checked with its pair.
const accepted = (permission: string, key: string, version: number) => {
  try {
    const grant = { permission, template: { key, version } };
    checkRoleCatalog(
      declarations,
      permission === 'hrCompany.approvals' ? [grant, finalDecision] : [grant],
    );
    return true;
  } catch (error) {
    if (error instanceof ProductInvalidRequest) return false;
    throw error;
  }
};

test('the catalog never names a document permission or a template of another resource', () => {
  const catalog = roleCatalog(declarations);
  assert.ok(catalog.length > 0);
  assert.ok(!catalog.some((pair) => pair.permission.startsWith('document.')));
  for (const pair of catalog) {
    const template = declarations.templates[`${pair.template.key}@${pair.template.version}`];
    assert.equal(template?.resource, pair.permission.slice(0, pair.permission.indexOf('.')));
    assert.deepEqual(Object.keys(pair).sort(), ['permission', 'template']);
    assert.deepEqual(Object.keys(pair.template).sort(), ['key', 'version']);
  }
});

test('every catalog pair passes the role validator and every other candidate pair fails it', () => {
  const catalog = roleCatalog(declarations);
  const listed = new Set(
    catalog.map((pair) => `${pair.permission} ${pair.template.key}@${pair.template.version}`),
  );
  assert.equal(listed.size, catalog.length, 'no pair is listed twice');
  let candidates = 0;
  for (const [resource, declared] of Object.entries(declarations.resources))
    for (const action of Object.keys(declared.actions))
      for (const template of Object.values(declarations.templates)) {
        candidates += 1;
        const id = `${resource}.${action} ${template.key}@${template.version}`;
        assert.equal(
          accepted(`${resource}.${action}`, template.key, template.version),
          listed.has(id),
          id,
        );
      }
  assert.ok(candidates > catalog.length, 'the check also covered pairs that are not selectable');
});

test('the catalog is sorted, stable and bounded', () => {
  const catalog = roleCatalog(declarations);
  const ids = catalog.map((pair) => `${pair.permission} ${pair.template.key}`);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(roleCatalog(declarations), catalog);
  assert.equal(catalog.length, 132);
  assert.ok(catalog.length <= MAX_ROLE_CATALOG_PAIRS);
});

test('a catalog above the bound is refused instead of cut', () => {
  const template = {
    key: 't',
    version: 1,
    resource: 'r',
    parameters: {},
    expression: { op: 'constant', value: true },
  };
  const actions = Object.fromEntries(
    Array.from({ length: MAX_ROLE_CATALOG_PAIRS + 1 }, (_, i) => [`a${i}`, {}]),
  );
  const big = {
    ...declarations,
    resources: { r: { actions } },
    templates: { 't@1': template },
  } as unknown as typeof declarations;
  assert.throws(() => roleCatalog(big), /catalog/i);
});
