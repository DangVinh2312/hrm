// Release 13 (T9 part A) rebuilt from release 14 (fixtures/release-fourteen.ts): everything before release 14 (T9 part B)
// added the action `employee.reportBirthday` and its two grants (COO and HR). The pinned hash
// proves the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseFourteenSource } from './release-fourteen.ts';

/** Published hash of release 13 (structure.spec.ts before release 14). */
export const releaseThirteenHash =
  '4db84f6b82fd7e2e70e5ab1868d4700a222c5f74fe563840b9263ac82589f8b7';

const releaseFourteenPermission = 'employee.reportBirthday';

const declarations = releaseFourteenSource.declarations;

export const releaseThirteenSource: ProductReleaseSource = {
  ...releaseFourteenSource,
  sequence: '13',
  predecessor: '12',
  declarations: {
    ...declarations,
    resources: declarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => `${resource.key}.${action}` !== releaseFourteenPermission,
        ),
      ),
    })),
  },
  defaultGrants: releaseFourteenSource.defaultGrants.filter(
    (grant) => grant.permission !== releaseFourteenPermission,
  ),
};
