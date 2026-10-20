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
import { HrmWorkCalendarMakeup1792108800104 } from '../dist/work-calendar/migrations/hrm-work-calendar-makeup.migration.js';
import { HrmEmployeeProfile1792108800105 } from '../dist/employee/migrations/hrm-employee-profile.migration.js';
import { HrmWorkRequest1792108800106 } from '../dist/work-request/migrations/hrm-work-request.migration.js';
import { sqlState, withClient } from './setup-postgres.ts';
import { releaseThreeHash, releaseThreeSource } from './fixtures/release-three.ts';
import { releaseFourHash, releaseFourSource } from './fixtures/release-four.ts';
import { releaseFiveHash, releaseFiveSource } from './fixtures/release-five.ts';
import { releaseSixHash, releaseSixSource } from './fixtures/release-six.ts';
import { releaseSevenHash, releaseSevenSource } from './fixtures/release-seven.ts';
import { releaseNineHash, releaseNineSource } from './fixtures/release-nine.ts';
import { releaseEightHash, releaseEightSource } from './fixtures/release-eight.ts';
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

test('a release-2 database upgrades to release 3, 4, 5, 6, 7, 8, 9 and then 10 by sync; a repeated sync changes nothing', async () => {
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
      HrmWorkCalendarMakeup1792108800104,
      HrmEmployeeProfile1792108800105,
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
    const releaseSix = prepareProductRelease(releaseSixSource, core);
    assert.equal(releaseSix.hash, releaseSixHash);
    assert.equal((await reconciler.reconcile(releaseSix)).changed, true);

    const boundaryEntries = () =>
      sync.query<{ boundary: string; permission: string; lifecycle: string }[]>(
        `SELECT convert_from(d.boundary_key,'UTF8') || '@' || d.boundary_version AS boundary,
                convert_from(e.permission_key,'UTF8') AS permission, d.lifecycle
           FROM permission_boundary d JOIN permission_boundary_entry e USING(boundary_key,boundary_version)
          ORDER BY 1, 2`,
      );

    assert.deepEqual(await boundaryEntries(), []);
    // Release 6 → 7: the HR boundary definition only; no binding is seeded (ADR 0016 §7).
    const releaseSeven = prepareProductRelease(releaseSevenSource, core);
    assert.equal(releaseSeven.hash, releaseSevenHash);
    assert.equal((await reconciler.reconcile(releaseSeven)).changed, true);
    const hrBoundary = [
      { boundary: 'hrAdministration@1', permission: 'employee.linkAccount', lifecycle: 'active' },
      { boundary: 'hrAdministration@1', permission: 'team.assign', lifecycle: 'active' },
    ];
    assert.deepEqual(await boundaryEntries(), hrBoundary);
    assert.deepEqual(await sync.query('SELECT 1 FROM user_boundary'), []);

    const approvalGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') IN
                ('workRequest.readDecided','team.approvals','hrCompany.approvals')
          ORDER BY 1`,
      );

    assert.deepEqual(await approvalGrants(), []);
    // Release 7 → 8 (T6 part C): the decided history and the approvals menu capabilities.
    const releaseEight = prepareProductRelease(releaseEightSource, core);
    assert.equal(releaseEight.hash, releaseEightHash);
    const eight = await reconciler.reconcile(releaseEight);
    assert.equal(eight.changed, true);
    const grants = [
      { grant: 'hrCompany.approvals hr.coo company' },
      { grant: 'team.approvals hr.employee ledTeams' },
      { grant: 'workRequest.readDecided hr.coo allRequests' },
      { grant: 'workRequest.readDecided hr.employee ledRequests' },
    ];
    assert.deepEqual(await approvalGrants(), grants);

    const leadRejectedGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') = 'workRequest.readLeadRejected'
          ORDER BY 1`,
      );

    assert.deepEqual(await leadRejectedGrants(), []);
    // Release 8 → 9: a new read-only action for the COO (a lead's request rejected at the lead step).
    const releaseNine = prepareProductRelease(releaseNineSource, core);
    assert.equal(releaseNine.hash, releaseNineHash);
    const nine = await reconciler.reconcile(releaseNine);
    assert.equal(nine.changed, true);
    assert.deepEqual(await leadRejectedGrants(), [
      { grant: 'workRequest.readLeadRejected hr.coo leadRejectedLeadRequests' },
    ]);
    // No decision right and no other grant came with it.
    assert.deepEqual(await approvalGrants(), grants);

    const leaveGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') = 'employee.readLeaveBalance'
          ORDER BY 1`,
      );

    assert.deepEqual(await leaveGrants(), []);
    // Release 9 → 10 (T7): the leave balance read (own, a lead's members, HR) and nothing else.
    const upgraded = await reconciler.reconcile(release);
    assert.equal(upgraded.changed, true);
    assert.equal(upgraded.manifestHash, release.hash);
    assert.deepEqual(await leaveGrants(), [
      { grant: 'employee.readLeaveBalance hr.admin allEmployees' },
      { grant: 'employee.readLeaveBalance hr.employee ledEmployees' },
      { grant: 'employee.readLeaveBalance hr.employee selfEmployee' },
    ]);
    // No decision right, no COO-wide grant and no other grant came with it.
    assert.deepEqual(await approvalGrants(), grants);
    assert.equal((await leadRejectedGrants()).length, 1);
    const again = await reconciler.reconcile(release);
    assert.deepEqual(again, { ...upgraded, changed: false });
    assert.deepEqual(await boundaryEntries(), hrBoundary);
    assert.deepEqual(await approvalGrants(), grants);
    assert.equal((await leaveGrants()).length, 3);
    // An older build cannot downgrade the product it no longer describes.
    for (const older of [releaseNine, releaseEight, releaseSeven, releaseSix, releaseTwo])
      await assert.rejects(reconciler.reconcile(older), /Release rejected \(downgrade/);
  } finally {
    await sync.destroy();
  }
});

test('a T4 calendar keeps its history through the makeup migration (forward only)', async () => {
  await withClient(postgres.superuser, (client) => client.query('CREATE DATABASE wc_upgrade'));
  const admin = { ...postgres.superuser, database: 'wc_upgrade' };
  const t4 = [
    ...productMigrations,
    HrmAuthorization1792108800100,
    HrmEmployee1792108800101,
    HrmTeam1792108800102,
    HrmWorkCalendar1792108800103,
  ];
  const connections = await provisionProductDatabase(admin, passwords, t4);
  const history = `SELECT version::text AS version, to_char(day,'YYYY-MM-DD') AS day, kind, name
                     FROM work_calendar_change ORDER BY version`;
  const migration = await new DataSource(
    productDataSourceOptions(connections.migration),
  ).initialize();
  try {
    // Fixture rows only (not the legal calendar): a holiday, then the same weekday cleared.
    await migration.query(
      `INSERT INTO work_calendar_change(version,day,kind,name)
       VALUES (2, DATE '2026-11-02','paid_holiday','Ngày lễ giả'), (3, DATE '2026-11-02','standard',NULL)`,
    );
    const before = await migration.query<unknown[]>(history);
    await provisionProductDatabase(admin, passwords, [...t4, HrmWorkCalendarMakeup1792108800104]);
    assert.deepEqual(await migration.query(history), before);
    // Saturday 2026-11-07 now takes a makeup row; a Monday still cannot.
    await migration.query(
      `INSERT INTO work_calendar_change(version,day,kind) VALUES (4, DATE '2026-11-07','makeup_workday')`,
    );
    // Rejected by the new constraint by name (the old one was work_calendar_change_kind_check).
    await assert.rejects(
      migration.query(
        `INSERT INTO work_calendar_change(version,day,kind) VALUES (5, DATE '2026-11-09','makeup_workday')`,
      ),
      (error: unknown) => {
        const driver = (error as { driverError?: { code?: string; constraint?: string } })
          .driverError;
        return driver?.code === '23514' && driver.constraint === 'ck_work_calendar_change_kind';
      },
    );
    // Forward only: there is no down.
    await assert.rejects(
      new HrmWorkCalendarMakeup1792108800104().down(),
      /Use reviewed forward migration/,
    );
  } finally {
    await migration.destroy();
  }
});

test('the profile migration keeps rows that exist before it: new columns are NULL, CHECKs and grants apply after (forward only)', async () => {
  await withClient(postgres.superuser, (client) => client.query('CREATE DATABASE profile_upgrade'));
  const admin = { ...postgres.superuser, database: 'profile_upgrade' };
  const t5 = [
    ...productMigrations,
    HrmAuthorization1792108800100,
    HrmEmployee1792108800101,
    HrmTeam1792108800102,
    HrmWorkCalendar1792108800103,
    HrmWorkCalendarMakeup1792108800104,
  ];
  await provisionProductDatabase(admin, passwords, t5);
  // Fixture rows written as superuser without FK/trigger checks: only the table shape matters here.
  const id = randomUUID();
  await withClient(admin, async (client) => {
    await client.query('SET session_replication_role = replica');
    await client.query(
      `INSERT INTO employee(id,object_id,code,full_name,hired_on) VALUES($1,$2,'OLD1','Nhân viên cũ',DATE '2026-01-05')`,
      [id, randomUUID()],
    );
    await client.query(
      `INSERT INTO employee_identity(employee_id,object_id,tax_code) VALUES($1,$2,'0100000001')`,
      [id, randomUUID()],
    );
  });
  const connections = await provisionProductDatabase(admin, passwords, [
    ...t5,
    HrmEmployeeProfile1792108800105,
  ]);
  const migration = await new DataSource(
    productDataSourceOptions(connections.migration),
  ).initialize();
  const data = await new DataSource(productDataSourceOptions(connections.data)).initialize();
  try {
    assert.deepEqual(
      await migration.query(
        `SELECT e.job_position, e.classification, i.gender, i.phone, i.work_email, i.tax_code
           FROM employee e JOIN employee_identity i ON i.employee_id = e.id WHERE e.id = $1`,
        [id],
      ),
      [
        {
          job_position: null,
          classification: null,
          gender: null,
          phone: null,
          work_email: null,
          tax_code: '0100000001',
        },
      ],
    );
    // The data login writes exactly the new columns and still not the account link.
    await data.query(
      `UPDATE employee SET job_position = 'Kỹ sư', classification = 'fullTime' WHERE id = $1`,
      [id],
    );
    await data.query(
      `UPDATE employee_identity SET gender = 'male', phone = '0901234567', work_email = 'a@example.com' WHERE employee_id = $1`,
      [id],
    );
    assert.equal(await sqlState(data.query('UPDATE employee SET account_id = NULL')), '42501');
    assert.equal(
      await sqlState(
        data.query(`UPDATE employee_identity SET phone = '12345' WHERE employee_id = $1`, [id]),
      ),
      '23514',
    );
    await assert.rejects(
      new HrmEmployeeProfile1792108800105().down(),
      /Use reviewed forward migration/,
    );
  } finally {
    await data.destroy();
    await migration.destroy();
  }
});

test('the T5 request migration refuses a database with pre-T5 request rows (no reason to map) and applies forward on an empty table', async () => {
  await withClient(postgres.superuser, (client) => client.query('CREATE DATABASE request_upgrade'));
  const admin = { ...postgres.superuser, database: 'request_upgrade' };
  const t105 = [
    ...productMigrations,
    HrmAuthorization1792108800100,
    HrmEmployee1792108800101,
    HrmTeam1792108800102,
    HrmWorkCalendar1792108800103,
    HrmWorkCalendarMakeup1792108800104,
    HrmEmployeeProfile1792108800105,
  ];
  await provisionProductDatabase(admin, passwords, t105);
  // A T2-era request row (fixture, FK/trigger checks off): migration 106 cannot invent its reason.
  const request = randomUUID();
  await withClient(admin, async (client) => {
    await client.query('SET session_replication_role = replica');
    await client.query(
      `INSERT INTO work_request(id,object_id,employee_id,owner_account_id,team_id,kind,state)
       VALUES($1,$2,$3,$4,$5,'wfh','pending_lead')`,
      [request, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );
  });
  // NOT NULL `reason` on an existing row (23502), not some other provisioning failure.
  assert.equal(
    await sqlState(
      provisionProductDatabase(admin, passwords, [...t105, HrmWorkRequest1792108800106]),
    ),
    '23502',
  );

  const exists = (name: string) =>
    withClient(
      admin,
      async (client) =>
        (
          await client.query<{ found: boolean }>('SELECT to_regclass($1) IS NOT NULL AS found', [
            name,
          ])
        ).rows[0]?.found,
    );

  assert.equal(await exists('public.work_request_segment'), false);
  assert.equal(await exists('public.hr_idempotency'), false);
  // Once the row is mapped away (here: removed), the same forward migration applies.
  await withClient(admin, (client) =>
    client.query('DELETE FROM work_request WHERE id = $1', [request]),
  );
  const connections = await provisionProductDatabase(admin, passwords, [
    ...t105,
    HrmWorkRequest1792108800106,
  ]);
  const data = await new DataSource(productDataSourceOptions(connections.data)).initialize();
  try {
    assert.deepEqual(await data.query('SELECT * FROM work_request_segment'), []);
    assert.deepEqual(await data.query('SELECT * FROM hr_idempotency'), []);
    assert.equal(await sqlState(data.query('DELETE FROM hr_idempotency')), '42501');
    assert.equal(await sqlState(data.query(`UPDATE work_request SET reason = 'x'`)), '42501');
    await assert.rejects(
      new HrmWorkRequest1792108800106().down(),
      /Use reviewed forward migration/,
    );
  } finally {
    await data.destroy();
  }
});
