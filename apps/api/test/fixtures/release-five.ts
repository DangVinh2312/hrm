// Release 5 (T3) rebuilt from today's source: everything before release 6 (T4) added the
// workCalendar resource, its scope and grants. The pinned hash proves the rebuild equals the
// published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../../dist/authorization/product.manifest.js';

/** Published hash of release 5 (structure.spec.ts before T4). */
export const releaseFiveHash = 'e10f00e09d956850c5f5f794b154f59788314571232f63c98f27eaa19f33ab04';

const t4Resources = new Set(['workCalendar']);

export const releaseFiveSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '5',
  predecessor: '4',
  declarations: {
    ...productDeclarations,
    resources: productDeclarations.resources.filter((resource) => !t4Resources.has(resource.key)),
    templates: productDeclarations.templates.filter(
      (template) => !t4Resources.has(template.resource),
    ),
  },
  defaultGrants: productReleaseSource.defaultGrants.filter(
    (grant) => !t4Resources.has(grant.permission.split('.')[0] ?? ''),
  ),
};
