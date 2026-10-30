import type { CatalogPair, RoleRow } from './administration.client';

export const MAX_ROLE_GRANTS = 300;

export const MAX_LABEL_POINTS = 120;

const NAME = /^[a-z][a-z0-9_]{1,40}$/;

export const roleKeyOf = (name: string) => `custom.${name}`;

export const isRoleName = (name: string) => NAME.test(name);

export function isRoleLabel(label: string): boolean {
  const text = label.trim();
  const points = [...text];

  const control = (c: string) => (c.codePointAt(0) ?? 0) < 0x20 || c.codePointAt(0) === 0x7f;

  return text !== '' && points.length <= MAX_LABEL_POINTS && !points.some(control);
}

export const pairId = (pair: CatalogPair) =>
  `${pair.permission}\u0000${pair.template.key}\u0000${pair.template.version}`;

export const byPairId = (a: CatalogPair, b: CatalogPair) => {
  const [x, y] = [pairId(a), pairId(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

export function filterCatalog(
  catalog: readonly CatalogPair[],
  query: string,
): readonly CatalogPair[] {
  const needle = query.trim().toLowerCase();
  return needle === ''
    ? catalog
    : catalog.filter((pair) =>
        `${pair.permission} ${pair.template.key}`.toLowerCase().includes(needle),
      );
}

export const grantsOfRole = (role: Pick<RoleRow, 'grants'>): readonly CatalogPair[] =>
  role.grants.map((grant) => ({
    permission: grant.permission,
    template: { key: grant.template, version: grant.version },
  }));

/** `PUT` replaces the whole set with plain allow rules, so a role holding a deny or a parameter cannot round-trip through the form. */
export const isEditableRole = (role: Pick<RoleRow, 'source' | 'grants'>) =>
  role.source === 'runtime' &&
  role.grants.every(
    (grant) => grant.effect === 'allow' && Object.keys(grant.parameters).length === 0,
  );

const APPROVALS = 'hrCompany.approvals';
const DECIDE_FINAL = 'workRequest.decideFinal';

const has = (pairs: readonly CatalogPair[], permission: string) =>
  pairs.some((pair) => pair.permission === permission);

export const draftSelfApproval = (pairs: readonly CatalogPair[]) =>
  has(pairs, APPROVALS) && has(pairs, DECIDE_FINAL);

export const draftLacksFinalDecision = (pairs: readonly CatalogPair[]) =>
  has(pairs, APPROVALS) && !has(pairs, DECIDE_FINAL);
