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
  roleBinding,
  roleDeclarations,
  roleDefaultGrants,
} from '../modules/role/role.declarations.js';
import {
  settingBinding,
  settingDeclarations,
  settingDefaultGrants,
} from '../modules/setting/setting.declarations.js';
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
  settingDeclarations,
  roleDeclarations,
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
  // Genesis release (ADR 0048): the former releases 2-19 are squashed into this one. It carries
  // the Document fixture, account.* commands (provision/read/reactivate/readPermissions), the HR
  // roles/resources (employee, team, workRequest, hrCompany, workCalendar), the hrAdministration
  // boundary, `setting` and `role` anchors and every default grant. Content is unchanged by the
  // squash; only sequence/predecessor were renumbered (not part of the release hash).
  sequence: '1',
  predecessor: '0',
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
    ...settingDefaultGrants,
    ...roleDefaultGrants,
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
 * domains are listed one by one in the order of the genesis release.
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
    settingBinding,
    roleBinding,
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
