// Release 18 (ADR 0041 wave 2, ADR 0045) rebuilt from today's source: release 19 (ADR 0041 wave 3b
// part 1, ADR 0046) added only the resource `role` (the role anchor: action `read`, one template,
// one default grant) and the action `account.readPermissions` (no grant). A resource binding is
// not part of the release hash (the bindings hash is pinned separately). The pinned hash proves
// the rebuild equals the published release 18.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../../dist/authorization/product.manifest.js';

/** Published hash of release 18 (structure.spec.ts before release 19). */
export const releaseEighteenHash =
  'd5ebcd88287b5be00cfca9834d0e38ead558b18058a50192c98d5a165399a2bb';

export const releaseEighteenSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '18',
  predecessor: '17',
  declarations: {
    ...productDeclarations,
    resources: productDeclarations.resources
      .filter((resource) => resource.key !== 'role')
      .map((resource) => ({
        ...resource,
        actions: Object.fromEntries(
          Object.entries(resource.actions).filter(
            ([action]) => `${resource.key}.${action}` !== 'account.readPermissions',
          ),
        ),
      })),
    templates: productDeclarations.templates.filter((template) => template.resource !== 'role'),
  },
  defaultGrants: productReleaseSource.defaultGrants.filter(
    (grant) => !grant.permission.startsWith('role.'),
  ),
};
