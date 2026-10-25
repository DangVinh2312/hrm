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
import { employeeDeclarations } from '../dist/modules/employee/employee.declarations.js';
import { permissionDeclarations } from '../dist/modules/permission/permission.declarations.js';
import { teamDeclarations } from '../dist/modules/team/team.declarations.js';
import { workRequestDeclarations } from '../dist/modules/work-request/work-request.declarations.js';
import { ProductTransactionRunner } from '../dist/database/product-transaction.runner.js';
import {
  productDataSourceOptions,
  productMigrations,
} from '../dist/database/helpers/product-database.helper.js';
import { provisionProductDatabase } from '../dist/database/services/product-database-provision.service.js';
import { HrmAuthorization1792108800100 } from '../dist/modules/permission/migrations/hrm-authorization.migration.js';
import { HrmEmployee1792108800101 } from '../dist/modules/employee/migrations/hrm-employee.migration.js';
import { HrmTeam1792108800102 } from '../dist/modules/team/migrations/hrm-team.migration.js';
import { HrmWorkCalendar1792108800103 } from '../dist/modules/work-calendar/migrations/hrm-work-calendar.migration.js';
import { HrmWorkCalendarMakeup1792108800104 } from '../dist/modules/work-calendar/migrations/hrm-work-calendar-makeup.migration.js';
import { HrmEmployeeProfile1792108800105 } from '../dist/modules/employee/migrations/hrm-employee-profile.migration.js';
import { HrmWorkRequest1792108800106 } from '../dist/modules/work-request/migrations/hrm-work-request.migration.js';
import { sqlState, withClient } from './setup-postgres.ts';
import { releaseThreeHash, releaseThreeSource } from './fixtures/release-three.ts';
import { releaseFourHash, releaseFourSource } from './fixtures/release-four.ts';
import { releaseFiveHash, releaseFiveSource } from './fixtures/release-five.ts';
import { releaseSixHash, releaseSixSource } from './fixtures/release-six.ts';
import { releaseSevenHash, releaseSevenSource } from './fixtures/release-seven.ts';
import { releaseNineHash, releaseNineSource } from './fixtures/release-nine.ts';
import { releaseTenHash, releaseTenSource } from './fixtures/release-ten.ts';
import { releaseElevenHash, releaseElevenSource } from './fixtures/release-eleven.ts';
import { releaseTwelveHash, releaseTwelveSource } from './fixtures/release-twelve.ts';
import { releaseThirteenHash, releaseThirteenSource } from './fixtures/release-thirteen.ts';
import { releaseFourteenHash, releaseFourteenSource } from './fixtures/release-fourteen.ts';
import { releaseFifteenHash, releaseFifteenSource } from './fixtures/release-fifteen.ts';
import { releaseSixteenHash, releaseSixteenSource } from './fixtures/release-sixteen.ts';
import { releaseEighteenHash, releaseEighteenSource } from './fixtures/release-eighteen.ts';
import { releaseSeventeenHash, releaseSeventeenSource } from './fixtures/release-seventeen.ts';
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
import { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';

/** The composition root of this test: one repository, passed down explicitly. */
const audit = new ProductAuditRepository();

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

test('a release-2 database upgrades to release 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 and then 19 by sync; a repeated sync changes nothing', async () => {
  await withClient(postgres.superuser, (client) =>
    client.query('CREATE DATABASE authorization_upgrade'),
  );
  const connections = await provisionProductDatabase(
    { ...postgres.superuser, database: 'authorization_upgrade' },
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
  const migrationConnection = await new DataSource(
    productDataSourceOptions(connections.migration),
  ).initialize();
  try {
    const reconciler = new ProductManifestReconciler(
      new ProductTransactionRunner({ sync }),
      audit,
      {
        core,
        actor: randomUUID() as IdentityId,
        capabilities: release.declarations.capabilities,
      },
    );

    // Release 2 rebuilt from today's source without the HR fragment; its pinned hash proves it.
    const moduleFragments = [
      permissionDeclarations,
      employeeDeclarations,
      teamDeclarations,
      workRequestDeclarations,
    ];

    const hr = (key: string) =>
      moduleFragments.some((fragment) => fragment.resources.some((r) => r.key === key));

    const modulePolicies = new Set(
      moduleFragments.flatMap((fragment) => fragment.policies.map((policy) => policy.key)),
    );
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
          policies: three.policies.filter((policy) => !modulePolicies.has(policy.key)),
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
    const administrationBoundary = [
      { boundary: 'hrAdministration@1', permission: 'employee.linkAccount', lifecycle: 'active' },
      { boundary: 'hrAdministration@1', permission: 'team.assign', lifecycle: 'active' },
    ];
    assert.deepEqual(await boundaryEntries(), administrationBoundary);
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
    const releaseTen = prepareProductRelease(releaseTenSource, core);
    assert.equal(releaseTen.hash, releaseTenHash);
    const ten = await reconciler.reconcile(releaseTen);
    assert.equal(ten.changed, true);
    assert.deepEqual(await leaveGrants(), [
      { grant: 'employee.readLeaveBalance hr.admin allEmployees' },
      { grant: 'employee.readLeaveBalance hr.employee ledEmployees' },
      { grant: 'employee.readLeaveBalance hr.employee selfEmployee' },
    ]);
    // No decision right, no COO-wide grant and no other grant came with it.
    assert.deepEqual(await approvalGrants(), grants);

    const attendanceGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') IN ('employee.readAttendance','hrCompany.managePeriod')
          ORDER BY 1`,
      );

    assert.deepEqual(await attendanceGrants(), []);
    // Release 10 → 11 (T8): the attendance sheet (own, HR) and HR's fresh close/reopen of a month.
    const releaseEleven = prepareProductRelease(releaseElevenSource, core);
    assert.equal(releaseEleven.hash, releaseElevenHash);
    const eleven = await reconciler.reconcile(releaseEleven);
    assert.equal(eleven.changed, true);
    assert.deepEqual(await attendanceGrants(), [
      { grant: 'employee.readAttendance hr.admin allEmployees' },
      { grant: 'employee.readAttendance hr.employee selfEmployee' },
      { grant: 'hrCompany.managePeriod hr.admin company' },
    ]);
    // No lead/COO-wide attendance grant, no decision right and no other grant came with it.
    assert.deepEqual(await approvalGrants(), grants);

    const adjustGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') = 'employee.adjustLeaveBalance'
          ORDER BY 1`,
      );

    assert.deepEqual(await adjustGrants(), []);
    // Release 11 → 12 (T8 part B): HR's fresh ledger adjustment of the leave balance, one grant.
    const releaseTwelve = prepareProductRelease(releaseTwelveSource, core);
    assert.equal(releaseTwelve.hash, releaseTwelveHash);
    const twelve = await reconciler.reconcile(releaseTwelve);
    assert.equal(twelve.changed, true);
    assert.deepEqual(await adjustGrants(), [
      { grant: 'employee.adjustLeaveBalance hr.admin allEmployees' },
    ]);
    // No lead, COO or self grant, no decision right and nothing else came with it.
    assert.deepEqual(await approvalGrants(), grants);

    const reportGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') LIKE 'employee.report%'
          ORDER BY 1`,
      );

    assert.deepEqual(await reportGrants(), []);
    // Release 12 → 13 (T9 part A): five report actions, each granted to the COO and HR only
    // (company scope): exactly ten new grants; never the employee role, a lead or the CEO.
    const releaseThirteen = prepareProductRelease(releaseThirteenSource, core);
    assert.equal(releaseThirteen.hash, releaseThirteenHash);
    const thirteen = await reconciler.reconcile(releaseThirteen);
    assert.equal(thirteen.changed, true);

    const grantsOf = (reports: readonly string[]) =>
      reports.flatMap((report) => [
        { grant: `employee.report${report} hr.admin allEmployees` },
        { grant: `employee.report${report} hr.coo allEmployees` },
      ]);

    assert.deepEqual(
      await reportGrants(),
      grantsOf(['Attendance', 'LateEarly', 'Leave', 'Seniority', 'Wfh']),
    );
    assert.deepEqual(await approvalGrants(), grants);
    // Release 13 → 14 (T9 part B): the birthday report, COO and HR only: exactly two more grants.
    const releaseFourteen = prepareProductRelease(releaseFourteenSource, core);
    assert.equal(releaseFourteen.hash, releaseFourteenHash);
    const fourteen = await reconciler.reconcile(releaseFourteen);
    assert.equal(fourteen.changed, true);
    assert.deepEqual(
      await reportGrants(),
      grantsOf(['Attendance', 'Birthday', 'LateEarly', 'Leave', 'Seniority', 'Wfh']),
    );
    assert.deepEqual(await approvalGrants(), grants);

    const allGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT rule_id::text AS grant FROM policy_rule WHERE managed_by='code' ORDER BY 1`,
      );

    const attendanceAdjustGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') IN
                ('employee.adjustAttendance','employee.readAttendanceAdjustment')
          ORDER BY 1`,
      );

    assert.deepEqual(await attendanceAdjustGrants(), []);
    // Release 14 → 15 (T8 `attendance.adjust`): HR's fresh adjustment and HR's read of the entries,
    // exactly two new grants; never the employee role, a lead, the COO or the CEO.
    const releaseFifteen = prepareProductRelease(releaseFifteenSource, core);
    assert.equal(releaseFifteen.hash, releaseFifteenHash);
    const fifteen = await reconciler.reconcile(releaseFifteen);
    assert.equal(fifteen.changed, true);
    assert.deepEqual(await attendanceAdjustGrants(), [
      { grant: 'employee.adjustAttendance hr.admin allEmployees' },
      { grant: 'employee.readAttendanceAdjustment hr.admin allEmployees' },
    ]);
    assert.deepEqual(
      await reportGrants(),
      grantsOf(['Attendance', 'Birthday', 'LateEarly', 'Leave', 'Seniority', 'Wfh']),
    );
    assert.deepEqual(await approvalGrants(), grants);
    assert.equal((await leaveGrants()).length, 3);
    assert.equal((await leadRejectedGrants()).length, 1);
    assert.equal((await attendanceGrants()).length, 3);
    assert.equal((await adjustGrants()).length, 1);

    const roleLabels = () =>
      sync.query<{ role: string; label: string }[]>(
        `SELECT convert_from(role_key,'UTF8') AS role, label FROM role_definition
          WHERE convert_from(role_key,'UTF8') LIKE 'hr.%' ORDER BY 1`,
      );

    const grantsAfter15 = await allGrants();
    assert.deepEqual(await roleLabels(), [
      { role: 'hr.admin', label: 'HR/Admin' },
      { role: 'hr.coo', label: 'COO (duyệt cuối)' },
      { role: 'hr.employee', label: 'Nhân viên' },
    ]);
    // Release 15 → 16 (user decision 2026-10-22): only the three HR role labels change (English);
    // the sync updates the label of a role that already exists and touches no grant.
    const releaseSixteen = prepareProductRelease(releaseSixteenSource, core);
    assert.equal(releaseSixteen.hash, releaseSixteenHash);
    const sixteen = await reconciler.reconcile(releaseSixteen);
    assert.equal(sixteen.changed, true);
    assert.deepEqual(await roleLabels(), [
      { role: 'hr.admin', label: 'Admin' },
      { role: 'hr.coo', label: 'COO' },
      { role: 'hr.employee', label: 'Employee' },
    ]);
    assert.deepEqual(await allGrants(), grantsAfter15);

    const releaseSeventeen = prepareProductRelease(releaseSeventeenSource, core);
    assert.equal(releaseSeventeen.hash, releaseSeventeenHash);

    // Release 16 → 17 (ADR 0041 wave 1): only the action account.reactivate is added to the
    // catalog; no role, grant or boundary binding changes (it is granted to no role by default).
    const reactivateCatalog = () =>
      sync.query<{ permission: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') AS permission FROM permission_catalog
          WHERE convert_from(permission_key,'UTF8') LIKE 'account.%' ORDER BY 1`,
      );

    assert.deepEqual(await reactivateCatalog(), [
      { permission: 'account.provision' },
      { permission: 'account.read' },
      { permission: 'account.suspend' },
    ]);
    assert.notEqual(releaseSeventeen.hash, releaseSixteen.hash);
    const seventeen = await reconciler.reconcile(releaseSeventeen);
    assert.equal(seventeen.changed, true);
    assert.equal(seventeen.manifestHash, releaseSeventeen.hash);
    assert.deepEqual(await reactivateCatalog(), [
      { permission: 'account.provision' },
      { permission: 'account.reactivate' },
      { permission: 'account.read' },
      { permission: 'account.suspend' },
    ]);
    assert.deepEqual(await allGrants(), grantsAfter15);

    // Release 17 → 18 (ADR 0041 wave 2, ADR 0045): the resource `setting` with its four actions
    // and seven default grants; nothing else changes (no role, boundary, policy or earlier grant).
    const settingCatalog = () =>
      sync.query<{ permission: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') AS permission FROM permission_catalog
          WHERE convert_from(permission_key,'UTF8') LIKE 'setting.%' ORDER BY 1`,
      );

    const settingGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') LIKE 'setting.%' AND managed_by='code' ORDER BY 1`,
      );

    const releaseEighteen = prepareProductRelease(releaseEighteenSource, core);
    assert.equal(releaseEighteen.hash, releaseEighteenHash);
    assert.deepEqual(await settingCatalog(), []);
    assert.deepEqual(await settingGrants(), []);
    assert.notEqual(releaseEighteen.hash, releaseSeventeen.hash);
    const upgraded = await reconciler.reconcile(releaseEighteen);
    assert.equal(upgraded.changed, true);
    assert.equal(upgraded.manifestHash, releaseEighteen.hash);
    assert.deepEqual(await settingCatalog(), [
      { permission: 'setting.read' },
      { permission: 'setting.readProfile' },
      { permission: 'setting.updateProfile' },
      { permission: 'setting.updateRule' },
    ]);
    assert.deepEqual(await settingGrants(), [
      { grant: 'setting.read hr.admin setting' },
      { grant: 'setting.read hr.coo setting' },
      { grant: 'setting.readProfile hr.admin setting' },
      { grant: 'setting.readProfile hr.coo setting' },
      { grant: 'setting.readProfile hr.employee setting' },
      { grant: 'setting.updateProfile hr.admin setting' },
      { grant: 'setting.updateRule hr.admin setting' },
    ]);
    // Every earlier grant is untouched: the new ones are exactly the extra rows.
    const after18 = await allGrants();
    assert.equal(after18.length, grantsAfter15.length + 7);
    for (const grant of grantsAfter15) assert.ok(after18.some((row) => row.grant === grant.grant));
    const again = await reconciler.reconcile(releaseEighteen);
    assert.deepEqual(again, { ...upgraded, changed: false });
    assert.deepEqual(await boundaryEntries(), administrationBoundary);
    assert.deepEqual(await approvalGrants(), grants);
    assert.equal((await reportGrants()).length, 12);

    // Release 18 → 19 (ADR 0041 wave 3b part 1, ADR 0046): the resource `role` with role.read and
    // one default grant, and account.readPermissions with none; nothing else changes. A runtime
    // role created before the upgrade (outside the release) is left exactly as it was.
    const roleCatalog = () =>
      sync.query<{ permission: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') AS permission FROM permission_catalog
          WHERE convert_from(permission_key,'UTF8') IN ('role.read','account.readPermissions') ORDER BY 1`,
      );

    const roleGrants = () =>
      sync.query<{ grant: string }[]>(
        `SELECT convert_from(permission_key,'UTF8') || ' ' || convert_from(role_key,'UTF8') || ' '
                || convert_from(template_key,'UTF8') AS grant
           FROM policy_rule
          WHERE convert_from(permission_key,'UTF8') IN ('role.read','account.readPermissions')
            AND managed_by='code' ORDER BY 1`,
      );

    const stateHash = async () =>
      (
        await sync.query<{ hash: string }[]>(
          `SELECT encode(materialized_hash,'hex') AS hash FROM authz_state WHERE singleton`,
        )
      )[0]?.hash;

    const runtimeRoles = () =>
      migrationConnection.query<{ role: string; label: string }[]>(
        `SELECT convert_from(role_key,'UTF8') AS role, label FROM role_definition
          WHERE managed_by='runtime' ORDER BY 1`,
      );

    await migrationConnection.query(
      `INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to('custom.before_nineteen','UTF8'),'runtime','Before 19')`,
    );
    assert.deepEqual(await roleCatalog(), []);
    assert.deepEqual(await roleGrants(), []);
    assert.notEqual(release.hash, releaseEighteen.hash);
    const hashBefore19 = await stateHash();
    const nineteen = await reconciler.reconcile(release);
    assert.equal(nineteen.changed, true);
    assert.equal(nineteen.manifestHash, release.hash);
    assert.deepEqual(await roleCatalog(), [
      { permission: 'account.readPermissions' },
      { permission: 'role.read' },
    ]);
    assert.deepEqual(await roleGrants(), [{ grant: 'role.read hr.admin role' }]);
    assert.notEqual(await stateHash(), hashBefore19);
    assert.deepEqual(await runtimeRoles(), [
      { role: 'custom.before_nineteen', label: 'Before 19' },
    ]);
    const after19 = await allGrants();
    assert.equal(after19.length, after18.length + 1);
    for (const grant of after18) assert.ok(after19.some((row) => row.grant === grant.grant));
    assert.deepEqual(await reconciler.reconcile(release), { ...nineteen, changed: false });
    // An older build cannot downgrade the product it no longer describes.
    for (const older of [
      releaseEighteen,
      releaseSeventeen,
      releaseSixteen,
      releaseFifteen,
      releaseFourteen,
      releaseThirteen,
      releaseTwelve,
      releaseEleven,
      releaseTen,
      releaseNine,
      releaseEight,
      releaseSeven,
      releaseSix,
      releaseTwo,
    ])
      await assert.rejects(reconciler.reconcile(older), /Release rejected \(downgrade/);
  } finally {
    await sync.destroy();
    await migrationConnection.destroy();
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
