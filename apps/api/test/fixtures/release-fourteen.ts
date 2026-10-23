// Release 14 (T9 part B) rebuilt from release 15 (fixtures/release-fifteen.ts): everything before
// release 15 (T8 `attendance.adjust`) added the actions `employee.adjustAttendance` and
// `employee.readAttendanceAdjustment` and their two HR grants. The pinned hash proves the rebuild
// equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseFifteenSource } from './release-fifteen.ts';

/** Published hash of release 14 (structure.spec.ts before release 15). */
export const releaseFourteenHash =
  'd1ba7d284656dd0a454db95d7b68bc87c7eeef003245ae2a3a397bf29d9bc19d';

const releaseFifteenPermissions = new Set([
  'employee.adjustAttendance',
  'employee.readAttendanceAdjustment',
]);

const declarations = releaseFifteenSource.declarations;

export const releaseFourteenSource: ProductReleaseSource = {
  ...releaseFifteenSource,
  sequence: '14',
  predecessor: '13',
  declarations: {
    ...declarations,
    resources: declarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => !releaseFifteenPermissions.has(`${resource.key}.${action}`),
        ),
      ),
    })),
  },
  defaultGrants: releaseFifteenSource.defaultGrants.filter(
    (grant) => !releaseFifteenPermissions.has(grant.permission),
  ),
};
