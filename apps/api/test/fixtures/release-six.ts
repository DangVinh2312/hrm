// Release 6 (T4) rebuilt from release 7 (fixtures/release-seven.ts): everything before release 7
// added the HR boundary `hrAdministration` (ADR 0016 §7). The pinned hash proves the rebuild
// equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseSevenSource } from './release-seven.ts';

/** Published hash of release 6 (structure.spec.ts before release 7). */
export const releaseSixHash = '135ab5a8f308b06798d6d554ea504b559a96e727d8eab88c799cd15e5fe44a69';

const releaseSevenBoundaries = new Set(['hrAdministration']);

const declarations = releaseSevenSource.declarations;

export const releaseSixSource: ProductReleaseSource = {
  ...releaseSevenSource,
  sequence: '6',
  predecessor: '5',
  declarations: {
    ...declarations,
    boundaries: declarations.boundaries.filter(
      (boundary) => !releaseSevenBoundaries.has(boundary.key),
    ),
  },
};
