// Release 12 (T8 part B) rebuilt from today's source: everything before release 13 (T9 part A)
// added the five report actions `employee.report{Attendance,Leave,LateEarly,Wfh,Seniority}` and
// their ten grants. The pinned hash proves the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../../dist/authorization/product.manifest.js';

/** Published hash of release 12 (structure.spec.ts before release 13). */
export const releaseTwelveHash = '86cce38109869706f8c8e809f2a6b4e162882d002288a2cdc1eec3599369cfb3';

const releaseThirteenPermissions = new Set(
  ['Attendance', 'Leave', 'LateEarly', 'Wfh', 'Seniority'].map(
    (report) => `employee.report${report}`,
  ),
);

export const releaseTwelveSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '12',
  predecessor: '11',
  declarations: {
    ...productDeclarations,
    resources: productDeclarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => !releaseThirteenPermissions.has(`${resource.key}.${action}`),
        ),
      ),
    })),
  },
  defaultGrants: productReleaseSource.defaultGrants.filter(
    (grant) => !releaseThirteenPermissions.has(grant.permission),
  ),
};
