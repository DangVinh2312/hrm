// Release 17 (ADR 0041 wave 1) rebuilt from today's source: release 18 (ADR 0041 wave 2, ADR 0045)
// added only the resource `setting` (four actions, one template, seven default grants). A resource
// binding is not part of the release hash (the bindings hash is pinned separately). The pinned hash
// proves the rebuild equals the published release 17.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../../dist/authorization/product.manifest.js';

/** Published hash of release 17 (structure.spec.ts before release 18). */
export const releaseSeventeenHash =
  '0f4a7908b1929cb98d817ee79d8be46cb91bc264fc251da74c39d0a4b441dc60';

export const releaseSeventeenSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '17',
  predecessor: '16',
  declarations: {
    ...productDeclarations,
    resources: productDeclarations.resources.filter((resource) => resource.key !== 'setting'),
    templates: productDeclarations.templates.filter((template) => template.resource !== 'setting'),
  },
  defaultGrants: productReleaseSource.defaultGrants.filter(
    (grant) => !grant.permission.startsWith('setting.'),
  ),
};
