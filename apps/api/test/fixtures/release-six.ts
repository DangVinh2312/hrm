// Release 6 (T4) rebuilt from today's source: everything before release 7 added the HR boundary
// `hrAdministration` (ADR 0016 §7). The pinned hash proves the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../../dist/authorization/product.manifest.js';

/** Published hash of release 6 (structure.spec.ts before release 7). */
export const releaseSixHash = '135ab5a8f308b06798d6d554ea504b559a96e727d8eab88c799cd15e5fe44a69';

const releaseSevenBoundaries = new Set(['hrAdministration']);

export const releaseSixSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '6',
  predecessor: '5',
  declarations: {
    ...productDeclarations,
    boundaries: productDeclarations.boundaries.filter(
      (boundary) => !releaseSevenBoundaries.has(boundary.key),
    ),
  },
};
