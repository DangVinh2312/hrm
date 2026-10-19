// HR authorization: fact changes in the next transaction and release upgrades.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { IdentityId } from '../dist/authorization/core/authorization.types.js';
import {
  ProductManifestReconciler,
  prepareProductRelease,
} from '../dist/authorization/services/product-manifest.service.js';
import { productReleaseSource } from '../dist/authorization/product.manifest.js';
import { documentDefaultGrants } from '../dist/document/document.declarations.js';
import { hrDeclarations } from '../dist/hr/hr.declarations.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  productDataSourceOptions,
  productMigrations,
  provisionProductDatabase,
} from '../dist/database/helpers/product-database.helper.js';
import { HrmAuthorization1792108800100 } from '../dist/hr/migrations/hrm-authorization.migration.js';
import { HrmEmployee1792108800101 } from '../dist/employee/migrations/hrm-employee.migration.js';
import { HrmTeam1792108800102 } from '../dist/team/migrations/hrm-team.migration.js';
import { HrmWorkCalendar1792108800103 } from '../dist/work-calendar/migrations/hrm-work-calendar.migration.js';
import { withClient } from './setup-postgres.ts';
import { releaseThreeHash, releaseThreeSource } from './fixtures/release-three.ts';
import { releaseFourHash, releaseFourSource } from './fixtures/release-four.ts';
import { releaseFiveHash, releaseFiveSource } from './fixtures/release-five.ts';
import {
  core,
  release,
  postgres,
  runner,
  authorization,
  p,
  t,
  names,
  employeeKeys,
  visible,
  submitAs,
  revision,
  passwords,
  setupStack,
  teardownStack,
} from './hrm-authorization-stack.helper.ts';
import { decideLead } from './hrm-authorization-fixture-commands.helper.ts';

before(setupStack);
after(teardownStack);

test('facts change in the next transaction: team removal moves step 1 (C-24), lead revoke closes it', async () => {
  const moved = await submitAs('E1', 'T2');
  const queued = await submitAs('E2', 'T1');

  const detail = (person: string, id: string) =>
    authorization.detail(p(person).secret, 'workRequest', 'read', id);

  assert.ok(await detail('L2', moved));
  assert.equal(await detail('L1', moved), null);
  const before = await revision();
  await runner.run('admin', (tx) =>
    tx.manager.query(
      'UPDATE team_membership SET ends_at=statement_timestamp() WHERE employee_id=$1 AND team_id=$2 AND ends_at IS NULL',
      [p('E1').employee, t('T2')],
    ),
  );
  assert.equal(BigInt((await revision()) ?? '0'), BigInt(before ?? '0') + 1n);
  assert.equal(await detail('L2', moved), null);
  assert.equal(
    await authorization.execute(p('L2').secret, decideLead, {
      requestId: moved,
      expectedVersion: '1',
    }),
    undefined,
  );
  // Step 1 is now the lead of the employee's primary team.
  assert.ok(await detail('L1', moved));
  await runner.run('admin', (tx) =>
    tx.manager.query(
      'UPDATE team_lead_assignment SET ends_at=statement_timestamp() WHERE team_id=$1 AND ends_at IS NULL',
      [t('T1')],
    ),
  );
  for (const id of [moved, queued]) {
    assert.equal(await detail('L1', id), null);
    assert.equal(
      await authorization.execute(p('L1').secret, decideLead, {
        requestId: id,
        expectedVersion: '1',
      }),
      undefined,
    );
  }
  assert.deepEqual(names(await visible('L1', 'employee'), employeeKeys()), ['E4', 'L1']);
});

test('a release-2 database upgrades to release 3, 4, 5 and then 6 by sync; a repeated sync changes nothing', async () => {
  await withClient(postgres.superuser, (client) => client.query('CREATE DATABASE hr_upgrade'));
  const connections = await provisionProductDatabase(
    { ...postgres.superuser, database: 'hr_upgrade' },
    passwords,
    [
      ...productMigrations,
      HrmAuthorization1792108800100,
      HrmEmployee1792108800101,
      HrmTeam1792108800102,
      HrmWorkCalendar1792108800103,
    ],
  );
  const sync = await new DataSource(productDataSourceOptions(connections.sync)).initialize();
  try {
    const reconciler = new ProductManifestReconciler(new ProductTransactionRunner({ sync }), {
      core,
      actor: randomUUID() as IdentityId,
      capabilities: release.declarations.capabilities,
    });

    // Release 2 rebuilt from today's source without the HR fragment; its pinned hash proves it.
    const hr = (key: string) => hrDeclarations.resources.some((r) => r.key === key);

    const hrPolicies = new Set(hrDeclarations.policies.map((policy) => policy.key));
    // Release 3 without the ADR 0020 account delta (fixtures/release-three.ts), then minus HR.
    const three = releaseThreeSource.declarations;
    const releaseTwo = prepareProductRelease(
      {
        ...productReleaseSource,
        sequence: '2',
        predecessor: '1',
        declarations: {
          ...three,
          resources: three.resources.filter((r) => !hr(r.key)),
          policies: three.policies.filter((policy) => !hrPolicies.has(policy.key)),
          templates: three.templates.filter((template) => !hr(template.resource)),
          relations: [],
        },
        roles: [{ key: 'reviewer', label: 'Reviewer' }],
        defaultGrants: documentDefaultGrants,
      },
      core,
    );
    assert.equal(
      releaseTwo.hash,
      'e11f43e8199bf70fd4a2c8e552477b682222402510fd3d0cc35b98256f15afaa',
    );
    await reconciler.reconcile(releaseTwo);
    const releaseThree = prepareProductRelease(releaseThreeSource, core);
    assert.equal(releaseThree.hash, releaseThreeHash);
    assert.equal((await reconciler.reconcile(releaseThree)).changed, true);
    // Release 3 → 4 (ADR 0020) → 5 (T3) → 6 (T4) by sync as well.
    const releaseFour = prepareProductRelease(releaseFourSource, core);
    assert.equal(releaseFour.hash, releaseFourHash);
    assert.equal((await reconciler.reconcile(releaseFour)).changed, true);
    const releaseFive = prepareProductRelease(releaseFiveSource, core);
    assert.equal(releaseFive.hash, releaseFiveHash);
    assert.equal((await reconciler.reconcile(releaseFive)).changed, true);
    const upgraded = await reconciler.reconcile(release);
    assert.equal(upgraded.changed, true);
    assert.equal(upgraded.manifestHash, release.hash);
    const again = await reconciler.reconcile(release);
    assert.deepEqual(again, { ...upgraded, changed: false });
    // An older build cannot downgrade the product it no longer describes.
    await assert.rejects(reconciler.reconcile(releaseTwo), /Release rejected \(downgrade/);
  } finally {
    await sync.destroy();
  }
});
