// Release 16 (user decision 2026-10-22) rebuilt from release 17 (fixtures/release-seventeen.ts):
// release 17 (ADR 0041 wave 1) added only the action `account.reactivate` (no grant, no binding).
// The pinned hash proves the rebuild equals the published release 16.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseSeventeenSource } from './release-seventeen.ts';

/** Published hash of release 16 (structure.spec.ts before release 17). */
export const releaseSixteenHash =
  'c78446efce8a2c214f7fec7e7859ec196f8d4727807e558c5c368d43f95b9218';

export const releaseSixteenSource: ProductReleaseSource = {
  ...releaseSeventeenSource,
  sequence: '16',
  predecessor: '15',
  declarations: {
    ...releaseSeventeenSource.declarations,
    resources: releaseSeventeenSource.declarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(
          ([action]) => `${resource.key}.${action}` !== 'account.reactivate',
        ),
      ),
    })),
  },
};
