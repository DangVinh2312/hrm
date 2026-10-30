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

export interface BoundaryPackage {
  readonly key: string;
  readonly version: number;
  readonly permissions: readonly string[];
}

/** The package the account and role commands need besides a grant (`account.bindBoundary`). */
export const ADMINISTRATION_PACKAGE = {
  key: 'accountAdministration',
  version: 1,
  permissions: [
    'account.assignRole',
    'account.bindBoundary',
    'account.provision',
    'account.reactivate',
    'account.revokeRole',
    'account.suspend',
    'account.unbindBoundary',
    'role.delete',
    'role.update',
  ],
} as const satisfies BoundaryPackage;

/** The package of the three identity operations (ADR-15); a separate binding per permission. */
export const IDENTITY_PACKAGE = {
  key: 'identityAdministration',
  version: 1,
  permissions: ['account.changeEmail', 'account.resetGoogleBinding', 'account.resetMfa'],
} as const satisfies BoundaryPackage;

export interface PackageBinding {
  /** `none`: no package permission is bound at all, so the whole package can be bound. */
  readonly state: 'none' | 'partial' | 'full';
  readonly missing: readonly string[];
  /** A binding the system did not seed exists, so an unbind has something to remove. */
  readonly removable: boolean;
}

export function packageBinding(
  boundaries: readonly Pick<AccountBoundary, 'permission' | 'key' | 'version' | 'seeded'>[],
  pkg: BoundaryPackage = ADMINISTRATION_PACKAGE,
): PackageBinding {
  const ofPackage = boundaries.filter((b) => pkg.permissions.includes(b.permission));

  const isThis = (b: Pick<AccountBoundary, 'key' | 'version'>) =>
    b.key === pkg.key && b.version === pkg.version;

  const complete = new Set(ofPackage.filter(isThis).map((b) => b.permission));
  const missing = pkg.permissions.filter((permission) => !complete.has(permission));
  return {
    state: ofPackage.length === 0 ? 'none' : missing.length === 0 ? 'full' : 'partial',
    missing,
    removable: ofPackage.some((b) => !b.seeded && isThis(b)),
  };
}
