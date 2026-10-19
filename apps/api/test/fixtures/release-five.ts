// Release 5 (T3) rebuilt from release 6 (fixtures/release-six.ts): everything before release 6 (T4)
// added the workCalendar resource, its scope and grants. The pinned hash proves the rebuild equals
// the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseSixSource } from './release-six.ts';

/** Published hash of release 5 (structure.spec.ts before T4). */
export const releaseFiveHash = 'e10f00e09d956850c5f5f794b154f59788314571232f63c98f27eaa19f33ab04';

const t4Resources = new Set(['workCalendar']);

const declarations = releaseSixSource.declarations;

export const releaseFiveSource: ProductReleaseSource = {
  ...releaseSixSource,
  sequence: '5',
  predecessor: '4',
  declarations: {
    ...declarations,
    resources: declarations.resources.filter((resource) => !t4Resources.has(resource.key)),
    templates: declarations.templates.filter((template) => !t4Resources.has(template.resource)),
  },
  defaultGrants: releaseSixSource.defaultGrants.filter(
    (grant) => !t4Resources.has(grant.permission.split('.')[0] ?? ''),
  ),
};
