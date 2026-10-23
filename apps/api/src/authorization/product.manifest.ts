import { type AuthorizationCore, createAuthorizationCore } from './core/authorization.factory.js';
import type { SystemDeclarations } from './core/authorization.declarations.js';
import {
  type ProductReleaseManifest,
  type ProductReleaseSource,
  prepareProductRelease,
} from './services/product-manifest.service.js';
import type { ProductStorageBindings } from './product-sql.compiler.js';
import { ProductObligation, ProductValidator } from './product-capability.types.js';

import { createDayjsTimestampCodec } from './values/codecs/dayjs-timestamp.codec.js';
import { createStandardValueCodecs } from './values/codecs/standard-values.codec.js';
import { accountBinding, accountDeclarations } from '../administration/account.declarations.js';
import {
  documentBinding,
  documentDeclarations,
  documentDefaultGrants,
} from '../document/document.declarations.js';
import {
  employeeBinding,
  employeeDeclarations,
  employeeDefaultGrants,
  employeeDomains,
  employeeIdentityBinding,
  leaveRateBinding,
} from '../modules/employee/employee.declarations.js';
import { EmployeeDomain } from '../modules/employee/employee-authorization.types.js';
import {
  companyBinding,
  permissionDeclarations,
  permissionDefaultGrants,
  permissionRoles,
} from '../modules/permission/permission.declarations.js';
import {
  teamBinding,
  teamDeclarations,
  teamDefaultGrants,
  teamDomains,
} from '../modules/team/team.declarations.js';
import { TeamDomain } from '../modules/team/team-authorization.types.js';
import {
  workRequestBinding,
  workRequestDeclarations,
  workRequestDefaultGrants,
  workRequestDomains,
} from '../modules/work-request/work-request.declarations.js';
import { WorkRequestDomain } from '../modules/work-request/work-request-authorization.types.js';
import { DocumentRole } from '../document/document-authorization.types.js';
import { reportDefaultGrants } from '../modules/report/report.declarations.js';
import {
  workCalendarBinding,
  workCalendarDeclarations,
  workCalendarDefaultGrants,
} from '../modules/work-calendar/work-calendar.declarations.js';

/**
 * Value codec selection for this product: the API runtime and the offline CLI (tools/product.ts)
 * both call this, so boot validation, sync and request evaluation share one set of semantics.
 */
export function createProductAuthorizationCore(): AuthorizationCore {
  return createAuthorizationCore({
    values: createStandardValueCodecs({ timestamp: createDayjsTimestampCodec() }),
  });
}

// Fragment order is part of the declarations; keep it stable.
const fragments = [
  documentDeclarations,
  accountDeclarations,
  permissionDeclarations,
  employeeDeclarations,
  teamDeclarations,
  workRequestDeclarations,
  workCalendarDeclarations,
];
// Only the modules that own relations declare them (ADR 0035).
const relationFragments = [employeeDeclarations, teamDeclarations, workRequestDeclarations];
export const productDeclarations: SystemDeclarations = {
  capabilities: {
    validators: [ProductValidator.Fresh],
    obligationHandlers: [ProductObligation.Audit],
  },
  resources: fragments.flatMap((f) => f.resources),
  policies: fragments.flatMap((f) => f.policies),
  templates: fragments.flatMap((f) => f.templates),
  boundaries: fragments.flatMap((f) => f.boundaries),
  relations: relationFragments.flatMap((f) => f.relations),
};

/** Release content is data only; codecs are provenance and never enter the manifest hash. */
export const productReleaseSource: ProductReleaseSource = {
  // Release 2 (ADR 0012): Root left IAM; no system role, system grant or rank boundary remains.
  // Release 3 (ADR 0016): HR roles, employee/team/workRequest resources and their scopes.
  // Release 4 (ADR 0020): account.provision/account.read and the auditedRead policy; no grant.
  // Release 5 (T3): hrCompany, employeeIdentity (F2), leaveRate (F3), employee/team writes.
  // Release 6 (T4): workCalendar read (every HR role) and manage (HR/Admin, fresh).
  // Release 7 (ADR 0016 §7): boundary hrAdministration@1 for team.assign/employee.linkAccount.
  // Release 8 (T6 part C): workRequest.readDecided (decided history), team/hrCompany.approvals
  // (approvals menu by approval right) and their grants.
  // Release 9 (T6 part C): workRequest.readLeadRejected, the COO's read of a lead's request
  // rejected at the lead step (template leadRejectedLeadRequests, view hr_request_lead_rejected,
  // migration 108).
  // Release 10 (T7): employee.readLeaveBalance (own, a lead's members, HR) and its grants. The
  // ledger tables come with migration 109; no new resource, so no new binding.
  // Release 11 (T8): employee.readAttendance (own, HR) and hrCompany.managePeriod (HR, fresh), three
  // grants. Tables come with migration 110; no new resource, so no new binding.
  // Release 12 (T8 part B): employee.adjustLeaveBalance (HR, fresh) and one grant. Cancellation
  // (`workRequest.cancel`, `cancelApproved`) has been declared since release 3. Migration 111
  // only widens the idempotency operations; no new resource, so no new binding.
  // Release 13 (T9 part A): employee.reportAttendance/Leave/LateEarly/Wfh/Seniority (COO and HR,
  // company scope) and ten grants. Reports read existing tables: no migration, no new binding.
  // Release 14 (T9 part B): employee.reportBirthday (COO and HR, company scope) and two grants.
  // No migration, no new binding; XLSX export reuses each report's own action.
  // Release 15 (T8 `attendance.adjust`): employee.adjustAttendance (HR, fresh) and
  // employee.readAttendanceAdjustment (HR), two grants. Migration 112 adds the append-only
  // table and widens the idempotency operations; no new resource, so no new binding.
  // Release 16 (user decision 2026-10-22): the three HR role labels become English (Employee, COO,
  // Admin). Labels are part of the release hash; no action, grant, policy or declaration changed.
  sequence: '16',
  predecessor: '15',
  declarations: productDeclarations,
  roles: [{ key: DocumentRole.Reviewer, label: 'Reviewer' }, ...permissionRoles],
  defaultGrants: [
    ...documentDefaultGrants,
    ...permissionDefaultGrants,
    ...employeeDefaultGrants,
    ...teamDefaultGrants,
    ...workRequestDefaultGrants,
    ...workCalendarDefaultGrants,
    ...reportDefaultGrants,
  ],
  seeds: [],
  removeSeeds: [],
  boundaryBindings: [],
  removeBoundaryBindings: [],
};

export function createProductRelease(core: AuthorizationCore): ProductReleaseManifest {
  return prepareProductRelease(productReleaseSource, core);
}

/**
 * Binding order is part of the pinned bindings hash (test/structure.spec.ts): the resources and
 * domains are listed one by one in the order of release 3.
 */
export const productBindings: ProductStorageBindings = {
  resources: [
    documentBinding,
    accountBinding,
    employeeBinding,
    teamBinding,
    workRequestBinding,
    companyBinding,
    employeeIdentityBinding,
    leaveRateBinding,
    workCalendarBinding,
  ],
  domains: {
    [EmployeeDomain.EmployeeLead]: employeeDomains[EmployeeDomain.EmployeeLead],
    [TeamDomain.TeamMember]: teamDomains[TeamDomain.TeamMember],
    [TeamDomain.TeamLead]: teamDomains[TeamDomain.TeamLead],
    [WorkRequestDomain.RequestOwner]: workRequestDomains[WorkRequestDomain.RequestOwner],
    [WorkRequestDomain.RequestLead]: workRequestDomains[WorkRequestDomain.RequestLead],
    [WorkRequestDomain.RequestDecider]: workRequestDomains[WorkRequestDomain.RequestDecider],
    [WorkRequestDomain.RequestLeadRejected]:
      workRequestDomains[WorkRequestDomain.RequestLeadRejected],
    [EmployeeDomain.EmployeeOwner]: employeeDomains[EmployeeDomain.EmployeeOwner],
    [EmployeeDomain.LeaveRateOwner]: employeeDomains[EmployeeDomain.LeaveRateOwner],
  },
};
