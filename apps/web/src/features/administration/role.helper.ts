import type { AccountBoundary, RoleGrant } from './administration.client';

/** `employee.readLeaveBalance` → resource `employee`, action `readLeaveBalance`. */
export function splitPermission(permission: string): { resource: string; action: string } {
  const dot = permission.indexOf('.');
  return dot < 0
    ? { resource: permission, action: '' }
    : { resource: permission.slice(0, dot), action: permission.slice(dot + 1) };
}

export interface GrantGroup<G> {
  readonly resource: string;
  readonly items: readonly (G & { readonly action: string })[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Rules grouped by resource, resources and actions in a fixed order (the page never depends on API order). */
export function groupByResource<G extends Pick<RoleGrant, 'permission' | 'template'>>(
  grants: readonly G[],
): readonly GrantGroup<G>[] {
  const groups = new Map<string, (G & { action: string })[]>();
  for (const grant of grants) {
    const { resource, action } = splitPermission(grant.permission);
    const items = groups.get(resource) ?? [];
    items.push({ ...grant, action });
    groups.set(resource, items);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([resource, items]) => ({
      resource,
      items: items.sort((a, b) => byText(a.action, b.action) || byText(a.template, b.template)),
    }));
}

/** The scope of a rule as text: `template`, then its parameters when it has any. */
export function grantScopeText(grant: Pick<RoleGrant, 'template' | 'parameters'>): string {
  const parameters = Object.entries(grant.parameters)
    .sort(([a], [b]) => byText(a, b))
    .map(([key, value]) => `${key}=${String(value)}`);
  return parameters.length === 0 ? grant.template : `${grant.template} {${parameters.join(', ')}}`;
}

/** The pair the API registry flags as self-approval; `role.read` does not report it. */
const SELF_APPROVAL_PERMISSIONS = ['hrCompany.approvals', 'workRequest.decideFinal'];

export const hasSelfApproval = (grants: readonly Pick<RoleGrant, 'permission' | 'effect'>[]) =>
  SELF_APPROVAL_PERMISSIONS.every((permission) =>
    grants.some((grant) => grant.effect === 'allow' && grant.permission === permission),
  );

/** The one package the account and role commands need besides a grant (`account.bindBoundary`). */
export const ADMINISTRATION_PACKAGE = { key: 'accountAdministration', version: 1 } as const;

const ADMINISTRATION_PERMISSIONS = [
  'account.assignRole',
  'account.bindBoundary',
  'account.provision',
  'account.reactivate',
  'account.revokeRole',
  'account.suspend',
  'account.unbindBoundary',
  'role.delete',
  'role.update',
];

export interface PackageBinding {
  /** `none`: no package permission is bound at all, so the whole package can be bound. */
  readonly state: 'none' | 'partial' | 'full';
  readonly missing: readonly string[];
  /** A binding the system did not seed exists, so an unbind has something to remove. */
  readonly removable: boolean;
}

export function packageBinding(
  boundaries: readonly Pick<AccountBoundary, 'permission' | 'key' | 'version' | 'seeded'>[],
): PackageBinding {
  const ofPackage = boundaries.filter((b) => ADMINISTRATION_PERMISSIONS.includes(b.permission));
  const complete = new Set(
    ofPackage
      .filter(
        (b) => b.key === ADMINISTRATION_PACKAGE.key && b.version === ADMINISTRATION_PACKAGE.version,
      )
      .map((b) => b.permission),
  );
  const missing = ADMINISTRATION_PERMISSIONS.filter((permission) => !complete.has(permission));
  return {
    state: ofPackage.length === 0 ? 'none' : missing.length === 0 ? 'full' : 'partial',
    missing,
    removable: ofPackage.some(
      (b) =>
        !b.seeded &&
        b.key === ADMINISTRATION_PACKAGE.key &&
        b.version === ADMINISTRATION_PACKAGE.version,
    ),
  };
}
