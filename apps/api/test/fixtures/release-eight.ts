// Release 8 (T6 part C) rebuilt from release 9 (fixtures/release-nine.ts): everything before release 9 added the
// relation `workRequest.leadRejectedLeadOwned`, the template `leadRejectedLeadRequests`, the
// action `workRequest.readLeadRejected` and its COO grant. The pinned hash proves the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseNineSource } from './release-nine.ts';

/** Published hash of release 8 (structure.spec.ts before release 9). */
export const releaseEightHash = '328af1cbbda4c21f45bede32f67665633b7857487ee0d31aeadc6e66b4a7fa74';

const releaseNineRelations = new Set(['workRequest.leadRejectedLeadOwned']);
const releaseNineTemplates = new Set(['leadRejectedLeadRequests']);

const declarations = releaseNineSource.declarations;

export const releaseEightSource: ProductReleaseSource = {
  ...releaseNineSource,
  sequence: '8',
  predecessor: '7',
  declarations: {
    ...declarations,
    resources: declarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => `${resource.key}.${action}` !== 'workRequest.readLeadRejected',
        ),
      ),
    })),
    relations: declarations.relations.filter((relation) => !releaseNineRelations.has(relation.key)),
    templates: declarations.templates.filter((template) => !releaseNineTemplates.has(template.key)),
  },
  defaultGrants: releaseNineSource.defaultGrants.filter(
    (grant) => !releaseNineTemplates.has(grant.template.key),
  ),
};
