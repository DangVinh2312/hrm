// Release 10 (T7) rebuilt from release 11 (fixtures/release-eleven.ts): everything before release
// 11 (T8) added the action `employee.readAttendance`, the action `hrCompany.managePeriod` and
// their three grants. The pinned hash proves the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseElevenSource } from './release-eleven.ts';

/** Published hash of release 10 (structure.spec.ts before release 11). */
export const releaseTenHash = 'fae0762e14daa8b4222f4d84233645203d4710cadc6712626abbca4c613a98ba';

const releaseElevenPermissions = new Set(['employee.readAttendance', 'hrCompany.managePeriod']);

const declarations = releaseElevenSource.declarations;

export const releaseTenSource: ProductReleaseSource = {
  ...releaseElevenSource,
  sequence: '10',
  predecessor: '9',
  declarations: {
    ...declarations,
    resources: declarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => !releaseElevenPermissions.has(`${resource.key}.${action}`),
        ),
      ),
    })),
  },
  defaultGrants: releaseElevenSource.defaultGrants.filter(
    (grant) => !releaseElevenPermissions.has(grant.permission),
  ),
};
