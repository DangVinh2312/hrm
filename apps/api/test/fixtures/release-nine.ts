// Release 9 (T6 part C) rebuilt from release 10 (fixtures/release-ten.ts): everything before
// release 10 (T7) added the action `employee.readLeaveBalance` and its three grants. The pinned
// hash proves the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseTenSource } from './release-ten.ts';

/** Published hash of release 9 (structure.spec.ts before release 10). */
export const releaseNineHash = 'e63ef951539eaa1661cfc19a9db82fdb3c07a6d8a1cfdeb95a320482fb08224f';

const releaseTenPermission = 'employee.readLeaveBalance';

const declarations = releaseTenSource.declarations;

export const releaseNineSource: ProductReleaseSource = {
  ...releaseTenSource,
  sequence: '9',
  predecessor: '8',
  declarations: {
    ...declarations,
    resources: declarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => `${resource.key}.${action}` !== releaseTenPermission,
        ),
      ),
    })),
  },
  defaultGrants: releaseTenSource.defaultGrants.filter(
    (grant) => grant.permission !== releaseTenPermission,
  ),
};
