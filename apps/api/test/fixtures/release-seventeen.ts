// Release 17 (ADR 0041 wave 1) rebuilt from release 18 (fixtures/release-eighteen.ts): release 18
// (ADR 0041 wave 2, ADR 0045) added only the resource `setting` (four actions, one template, seven
// default grants). A resource binding is not part of the release hash (the bindings hash is
// pinned separately). The pinned hash proves the rebuild equals the published release 17.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseEighteenSource } from './release-eighteen.ts';

/** Published hash of release 17 (structure.spec.ts before release 18). */
export const releaseSeventeenHash =
  '0f4a7908b1929cb98d817ee79d8be46cb91bc264fc251da74c39d0a4b441dc60';

export const releaseSeventeenSource: ProductReleaseSource = {
  ...releaseEighteenSource,
  sequence: '17',
  predecessor: '16',
  declarations: {
    ...releaseEighteenSource.declarations,
    resources: releaseEighteenSource.declarations.resources.filter(
      (resource) => resource.key !== 'setting',
    ),
    templates: releaseEighteenSource.declarations.templates.filter(
      (template) => template.resource !== 'setting',
    ),
  },
  defaultGrants: releaseEighteenSource.defaultGrants.filter(
    (grant) => !grant.permission.startsWith('setting.'),
  ),
};
