import type { ValidatedDeclarations } from '../../authorization/core/authorization.declarations.js';
import { checkRoleGrants } from '../../authorization/helpers/role-grant.helper.js';

export const MAX_ROLE_CATALOG_PAIRS = 500;

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface RoleCatalogPair {
  readonly permission: string;
  readonly template: { readonly key: string; readonly version: number };
}

/**
 * The pairs `checkRoleGrants` accepts for a single grant: a declared permission with a template
 * of the same resource and no parameters, `document` excluded. Rules across grants are not
 * pairs: `hrCompany.approvals` is refused unless the role also holds `workRequest.decideFinal`.
 * A catalog above the bound is a release defect, so it is refused when the repository is built
 * rather than cut.
 */
export function roleCatalog(declarations: ValidatedDeclarations): readonly RoleCatalogPair[] {
  const pairs: RoleCatalogPair[] = [];
  for (const [resource, declared] of Object.entries(declarations.resources)) {
    if (resource === 'document') continue;
    for (const action of Object.keys(declared.actions))
      for (const template of Object.values(declarations.templates)) {
        const pair = {
          permission: `${resource}.${action}`,
          template: { key: template.key, version: template.version },
        };
        if (checkRoleGrants(declarations, [pair]).ok) pairs.push(pair);
      }
  }
  if (pairs.length > MAX_ROLE_CATALOG_PAIRS) throw new Error('Role catalog above its bound');
  return pairs.sort(
    (a, b) => order(a.permission, b.permission) || order(a.template.key, b.template.key),
  );
}
