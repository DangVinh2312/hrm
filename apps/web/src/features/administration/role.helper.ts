import type { RoleGrant } from './administration.client';

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
