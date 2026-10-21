import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAuthorizationCore } from '../dist/authorization/core/authorization.factory.js';
import type { SystemDeclarations } from '../dist/authorization/core/authorization.declarations.js';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import { ReleaseRejectedError } from '../dist/authorization/helpers/release-content.helper.js';
import { ProductBindingRegistry } from '../dist/authorization/product-sql.compiler.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import type { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import { createDayjsTimestampCodec } from '../dist/authorization/values/codecs/dayjs-timestamp.codec.js';
import { createStandardValueCodecs } from '../dist/authorization/values/codecs/standard-values.codec.js';
import { core, declarations } from './core/fixtures.ts';

test('product release v4: roles are key and label, system.* is reserved, no system grant fields', async () => {
  const { productReleaseSource } = await import('../dist/authorization/product.manifest.js');
  const prepared = prepareProductRelease(productReleaseSource, core);
  // Release 3 adds the HR business roles (ADR 0016); none maps to Root.
  assert.deepEqual(
    prepared.roles.map((role) => role.key),
    ['reviewer', 'hr.employee', 'hr.coo', 'hr.admin'],
  );
  for (const field of ['systemGrants', 'removeSystemGrants'])
    assert.equal(Object.hasOwn(prepared, field), false, field);
  for (const key of ['system.root', 'system.audit'])
    assert.throws(
      () =>
        prepareProductRelease(
          { ...productReleaseSource, roles: [{ key, label: 'Reserved' }] },
          core,
        ),
      (error) =>
        error instanceof ReleaseRejectedError &&
        error.reason === 'invalid_release' &&
        /reserved/.test(error.message),
      key,
    );
});

test('product releases reject duplicate role keys and blank labels', async () => {
  const { productReleaseSource } = await import('../dist/authorization/product.manifest.js');
  const role = { key: 'reviewer', label: 'Reviewer' };
  for (const roles of [[role, role], [{ ...role, label: '   ' }]]) {
    assert.throws(
      () => prepareProductRelease({ ...productReleaseSource, roles }, core),
      (error) => error instanceof ReleaseRejectedError && error.reason === 'invalid_release',
    );
  }
});

test('product manifest hash is unchanged by the codec refactor (data only, no adapter in hash)', async () => {
  const { createProductAuthorizationCore, createProductRelease } =
    await import('../dist/authorization/product.manifest.js');
  // Release 3 (ADR 0016, T2) over release 2 (ADR 0012): roles key + label, HR fragment added.
  // Release 4 (ADR 0020): account.provision/account.read, auditedRead, account email fields.
  // Release 5 (T3): HR profile/team resources, actions, policies, scopes and grants.
  // Release 6 (T4): workCalendar resource, its scope and grants.
  // Release 7 (ADR 0016 §7): HR boundary hrAdministration@1 for team.assign/employee.linkAccount.
  // Release 8 (T6 part C): workRequest.readDecided, team/hrCompany.approvals and their grants.
  // Release 9 (T6 part C): workRequest.readLeadRejected, the COO's read of a lead's request
  // rejected at the lead step.
  // Release 10 (T7): employee.readLeaveBalance (own, a lead's members, HR) and its grants.
  // Release 11 (T8): employee.readAttendance, hrCompany.managePeriod and their grants.
  const expected = '73cd7739b82a546fe591d915c231755db99a4e51ca786f687bc821e5d26993a2';
  const first = createProductRelease(createProductAuthorizationCore());
  const second = createProductRelease(createProductAuthorizationCore());
  assert.equal(first.hash, expected);
  assert.equal(second.hash, expected);
  assert.equal(
    createHash('sha256').update(first.declarations.canonical).digest('hex'),
    '143f8240f89c0f5d7236b24a37a5d8015d1b876546b10f5e34970a49283e6184',
  );
  // Releases 10, 9, 8, 7, 6, 5, 4 and 3 rebuilt without the later deltas are still the published releases.
  const { releaseTenHash, releaseTenSource } = await import('./fixtures/release-ten.ts');
  assert.equal(prepareProductRelease(releaseTenSource, core).hash, releaseTenHash);
  const { releaseNineHash, releaseNineSource } = await import('./fixtures/release-nine.ts');
  assert.equal(prepareProductRelease(releaseNineSource, core).hash, releaseNineHash);
  const { releaseEightHash, releaseEightSource } = await import('./fixtures/release-eight.ts');
  assert.equal(prepareProductRelease(releaseEightSource, core).hash, releaseEightHash);
  const { releaseSevenHash, releaseSevenSource } = await import('./fixtures/release-seven.ts');
  assert.equal(prepareProductRelease(releaseSevenSource, core).hash, releaseSevenHash);
  const { releaseSixHash, releaseSixSource } = await import('./fixtures/release-six.ts');
  assert.equal(prepareProductRelease(releaseSixSource, core).hash, releaseSixHash);
  const { releaseFiveHash, releaseFiveSource } = await import('./fixtures/release-five.ts');
  assert.equal(prepareProductRelease(releaseFiveSource, core).hash, releaseFiveHash);
  const { releaseFourHash, releaseFourSource } = await import('./fixtures/release-four.ts');
  assert.equal(prepareProductRelease(releaseFourSource, core).hash, releaseFourHash);
  const { releaseThreeHash, releaseThreeSource } = await import('./fixtures/release-three.ts');
  assert.equal(prepareProductRelease(releaseThreeSource, core).hash, releaseThreeHash);
});

test('releases and declarations are only accepted by the core that prepared them', async () => {
  const { createProductAuthorizationCore, createProductRelease, productBindings } =
    await import('../dist/authorization/product.manifest.js');
  const other = createProductAuthorizationCore();
  const release = createProductRelease(core);
  const runner = {} as ProductTransactionRunner; // never reached: provenance is checked first
  const options = {
    actor: '00000000-0000-4000-8000-000000000001' as IdentityId,
    capabilities: release.declarations.capabilities,
  };
  await assert.rejects(
    new ProductManifestReconciler(runner, { ...options, core: other }).reconcile(release),
    (error) => error instanceof ReleaseRejectedError && error.reason === 'invalid_release',
  );
  assert.throws(
    () => new ProductBindingRegistry(other, release.declarations, productBindings),
    /this authorization core/,
  );
  assert.ok(new ProductBindingRegistry(core, release.declarations, productBindings));
});

test('a failing value codec rejects a release with the normal release error', () => {
  const failing = createAuthorizationCore({
    values: {
      ...createStandardValueCodecs({ timestamp: createDayjsTimestampCodec() }),
      string: {
        normalize: () => {
          throw new Error('codec failure');
        },

        compare: () => 0,
      },
    },
  });
  assert.throws(
    () =>
      prepareProductRelease(
        {
          sequence: '1',
          predecessor: '0',
          declarations: declarations(),
          roles: [],
          defaultGrants: [],
          seeds: [],
          removeSeeds: [],
          boundaryBindings: [],
          removeBoundaryBindings: [],
        },
        failing,
      ),
    (error) => error instanceof ReleaseRejectedError && error.reason === 'invalid_release',
  );
});

type CommandShape = { readonly resource: string; readonly action: string; readonly mode: string };

/**
 * Actions a Root session must have reauthenticated for (ADR 0022 §1) whose policy lacks `fresh@1`:
 * every action acting on another principal (`boundary: 'required'`) and every `admin` command.
 * Root runs only the action policy's requirements, so the step-up has to sit on the policy.
 */
function missingFresh(source: SystemDeclarations, commands: readonly CommandShape[]) {
  const fresh = (resource: string, action: string) => {
    const declared = source.resources.find((r) => r.key === resource)?.actions[action];
    const policy = source.policies.find(
      (p) => p.key === declared?.policy.key && p.version === declared.policy.version,
    );
    return policy?.contextRequirements.some((r) => r.validator === 'fresh@1') === true;
  };

  const sensitive = [
    ...source.resources.flatMap((r) =>
      Object.entries(r.actions)
        .filter(([, a]) => a.boundary === 'required')
        .map(([action]) => `${r.key}.${action}`),
    ),
    ...commands.filter((c) => c.mode === 'admin').map((c) => `${c.resource}.${c.action}`),
  ];
  return {
    sensitive: [...new Set(sensitive)].sort(),
    missing: [...new Set(sensitive)]
      .filter((key) => {
        const [resource = '', action = ''] = key.split('.');
        return !fresh(resource, action);
      })
      .sort(),
    fresh,
  };
}

test('every boundary-required action and every admin command has a fresh@1 policy (ADR 0022)', async () => {
  const { productReleaseSource } = await import('../dist/authorization/product.manifest.js');
  const { productCommands } = await import('../dist/infrastructure/product-runtime.service.js');
  const source = productReleaseSource.declarations;
  const { sensitive, missing, fresh } = missingFresh(source, productCommands);
  // Not vacuous: the manifest has required-boundary actions and the composition admin commands.
  assert.ok(sensitive.length > 0);
  assert.ok(productCommands.some((c) => c.mode === 'admin'));
  assert.deepEqual(missing, []);

  // Negative: a copy where one required-boundary action is rebound to a policy without fresh@1.
  const weak = source.policies.find((p) => p.contextRequirements.length === 0);
  assert.ok(weak);
  const [target = ''] = sensitive;
  const [resourceKey, actionKey = ''] = target.split('.');
  const rebound: SystemDeclarations = {
    ...source,
    resources: source.resources.map((r) =>
      r.key === resourceKey
        ? {
            ...r,
            actions: {
              ...r.actions,
              [actionKey]: {
                policy: { key: weak.key, version: weak.version },
                boundary: 'required' as const,
              },
            },
          }
        : r,
    ),
  };
  assert.deepEqual(missingFresh(rebound, productCommands).missing, [target]);
  // Negative: a write command whose policy has no fresh@1 is caught once registered as admin.
  const plain = productCommands.find((c) => c.mode === 'write' && !fresh(c.resource, c.action));
  assert.ok(plain);
  assert.deepEqual(
    missingFresh(source, [...productCommands, { ...plain, mode: 'admin' }]).missing,
    [`${plain.resource}.${plain.action}`],
  );
  // The shared manifest was not touched by the negative cases.
  assert.deepEqual(missingFresh(source, productCommands).missing, []);
});
