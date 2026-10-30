import { describe, expect, it } from 'vitest';
import {
  MAX_ROLE_GRANTS,
  filterCatalog,
  grantsOfRole,
  draftLacksFinalDecision,
  draftSelfApproval,
  isEditableRole,
  isRoleLabel,
  isRoleName,
  pairId,
  roleKeyOf,
} from '../src/features/administration/role-form.helper';

const pair = (permission: string, key: string, version = 1) => ({
  permission,
  template: { key, version },
});

const role = (grants: object[], over = {}) => ({
  key: 'custom.helper',
  label: 'Helper',
  source: 'runtime' as const,
  holders: 0,
  digest: 'a'.repeat(64),
  capabilities: [],
  grants: grants as never,
  ...over,
});

const rule = (permission: string, over = {}) => ({
  permission,
  effect: 'allow',
  template: 'allEmployees',
  version: 1,
  parameters: {},
  ...over,
});

describe('role name and label', () => {
  it('builds the key as custom.<name> and accepts only the API grammar', () => {
    expect(roleKeyOf('qa_lead')).toBe('custom.qa_lead');
    for (const ok of ['ab', 'a1', 'qa_lead', `a${'b'.repeat(40)}`])
      expect(isRoleName(ok)).toBe(true);
    for (const bad of ['', 'a', '1ab', 'Ab', 'a-b', 'a.b', 'a b', `a${'b'.repeat(41)}`, 'qa\n'])
      expect(isRoleName(bad)).toBe(false);
  });

  it('accepts a trimmed label of 1..120 code points without control characters', () => {
    expect(isRoleLabel(' Trưởng nhóm ')).toBe(true);
    expect(isRoleLabel('a'.repeat(120))).toBe(true);
    expect(isRoleLabel('😀'.repeat(120))).toBe(true);
    for (const bad of ['', '   ', 'a'.repeat(121), 'a\u0000b', 'a\nb'])
      expect(isRoleLabel(bad)).toBe(false);
  });

  it('caps the grants at the API limit', () => {
    expect(MAX_ROLE_GRANTS).toBe(300);
  });
});

describe('catalog helpers', () => {
  const catalog = [
    pair('employee.read', 'allEmployees'),
    pair('team.read', 'allTeams'),
    pair('workRequest.decideFinal', 'finalQueue'),
  ];

  it('identifies a pair by permission, template key and version', () => {
    expect(pairId(pair('a.b', 't', 2))).not.toBe(pairId(pair('a.b', 't', 1)));
    expect(pairId(pair('a.b', 't'))).toBe(pairId(pair('a.b', 't')));
  });

  it('filters by any part of permission or template, ignoring case and surrounding space', () => {
    expect(filterCatalog(catalog, '')).toEqual(catalog);
    expect(filterCatalog(catalog, ' TEAM ')).toEqual([catalog[1]]);
    expect(filterCatalog(catalog, 'queue')).toEqual([catalog[2]]);
    expect(filterCatalog(catalog, 'nothing')).toEqual([]);
  });
});

describe('editing a role', () => {
  it('turns stored rules into catalog pairs', () => {
    expect(grantsOfRole(role([rule('employee.read')]))).toEqual([
      pair('employee.read', 'allEmployees'),
    ]);
  });

  it('is editable only for a runtime role made of plain allow rules', () => {
    expect(isEditableRole(role([rule('employee.read')]))).toBe(true);
    expect(isEditableRole(role([], { source: 'code' }))).toBe(false);
    expect(isEditableRole(role([rule('employee.read', { effect: 'deny' })]))).toBe(false);
    expect(isEditableRole(role([rule('employee.read', { parameters: { team: 'x' } })]))).toBe(
      false,
    );
  });
});

describe('draft risk checks', () => {
  const approvals = pair('hrCompany.approvals', 'company');
  const decideFinal = pair('workRequest.decideFinal', 'finalQueue');

  it('flags the self-approval pair only when both permissions are chosen', () => {
    expect(draftSelfApproval([approvals, decideFinal])).toBe(true);
    expect(draftSelfApproval([approvals])).toBe(false);
    expect(draftSelfApproval([decideFinal])).toBe(false);
  });

  it('flags approvals chosen without a final decision, as the API refuses it', () => {
    expect(draftLacksFinalDecision([approvals])).toBe(true);
    expect(draftLacksFinalDecision([approvals, decideFinal])).toBe(false);
    expect(draftLacksFinalDecision([decideFinal])).toBe(false);
  });
});
