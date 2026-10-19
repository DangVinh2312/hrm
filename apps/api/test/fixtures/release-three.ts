// Release 3 (ADR 0016) rebuilt from release 4 (fixtures/release-four.ts): the account fragment as it
// was before release 4 (ADR 0020) added account.provision/account.read, the auditedRead policy and
// the email fields. Pinned hashes in the tests prove the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { releaseFourSource } from './release-four.ts';

/** Published hash of release 3 (structure.spec.ts before ADR 0020). */
export const releaseThreeHash = '325e9208780fbbc9309850d1f4fe7c0ac65e4dc826faa02b703998a68881d565';

const declarations = releaseFourSource.declarations;

export const releaseThreeSource: ProductReleaseSource = {
  ...releaseFourSource,
  sequence: '3',
  predecessor: '2',
  declarations: {
    ...declarations,
    resources: declarations.resources.map((resource) =>
      resource.key === 'account'
        ? {
            key: 'account',
            keyKind: 'uuid',
            fields: { state: { kind: 'string' } },
            actions: {
              suspend: { policy: { key: 'freshAuthentication', version: 1 }, boundary: 'required' },
            },
          }
        : resource,
    ),
    policies: declarations.policies.filter((policy) => policy.key !== 'auditedRead'),
  },
};
