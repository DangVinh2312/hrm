// Release 7 (ADR 0016 §7) rebuilt from release 8 (fixtures/release-eight.ts): everything before
// release 8 (T6 part C) added the decided history `workRequest.readDecided` and the approvals menu
// capabilities `team.approvals`/`hrCompany.approvals` with their grants. The pinned hash proves
// the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseEightSource } from './release-eight.ts';

/** Published hash of release 7 (structure.spec.ts before release 8). */
export const releaseSevenHash = 'f5fd178b4d5b1db4931a6b602f752e6f9b0023d6e52a1fe60976694db088138e';

const releaseEightActions: Readonly<Record<string, readonly string[]>> = {
  workRequest: ['readDecided'],
  team: ['approvals'],
  hrCompany: ['approvals'],
};

const added = (permission: string) => {
  const [resource = '', action = ''] = permission.split('.');
  return releaseEightActions[resource]?.includes(action) === true;
};

const declarations = releaseEightSource.declarations;

export const releaseSevenSource: ProductReleaseSource = {
  ...releaseEightSource,
  sequence: '7',
  predecessor: '6',
  declarations: {
    ...declarations,
    resources: declarations.resources.map((resource) => ({
      ...resource,
      actions: Object.fromEntries(
        Object.entries(resource.actions).filter(([action]) => !added(`${resource.key}.${action}`)),
      ),
    })),
  },
  defaultGrants: releaseEightSource.defaultGrants.filter((grant) => !added(grant.permission)),
};
