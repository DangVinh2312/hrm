// Release 11 (T8) rebuilt from today's source: everything before release 12 (T8 part B) added the
// action `employee.adjustLeaveBalance` and its grant. The pinned hash proves the rebuild equals
// the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../../dist/authorization/product.manifest.js';

/** Published hash of release 11 (structure.spec.ts before release 12). */
export const releaseElevenHash = '73cd7739b82a546fe591d915c231755db99a4e51ca786f687bc821e5d26993a2';

const releaseTwelvePermission = 'employee.adjustLeaveBalance';

export const releaseElevenSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '11',
  predecessor: '10',
  declarations: {
    ...productDeclarations,
    resources: productDeclarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => `${resource.key}.${action}` !== releaseTwelvePermission,
        ),
      ),
    })),
  },
  defaultGrants: productReleaseSource.defaultGrants.filter(
    (grant) => grant.permission !== releaseTwelvePermission,
  ),
};
