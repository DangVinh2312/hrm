import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type {
  ProductReleaseSource,
  ProductRole,
} from '../../authorization/services/product-manifest.service.js';
import type { ProductResourceBinding } from '../../authorization/product-sql.compiler.js';
import { EmployeeAction, EmployeeResource } from '../employee/employee-authorization.types.js';
import { TeamAction, TeamResource } from '../team/team-authorization.types.js';
import {
  defaultGrant,
  optionalAction,
  permissionKey,
  permissionPolicy,
  scopeTemplate,
} from './permission-declaration.helper.js';
import {
  CompanyAction,
  CompanyResource,
  CompanyTemplate,
  PermissionBoundary,
  PermissionPolicy,
  PermissionRole,
} from './permission-authorization.types.js';

/**
 * Shared authorization fragment: roles, the four policies used
 * by several modules, the company anchor and the administration boundary. Data only, composed
 * into the release in authorization/product.manifest.ts. Business guards (no self approval,
 * stage order, quotas) stay code-owned in the commands; grants only decide who may reach a record.
 */
export const permissionRoles: readonly ProductRole[] = [
  { key: PermissionRole.Employee, label: 'Employee' },
  { key: PermissionRole.Coo, label: 'COO' },
  { key: PermissionRole.Admin, label: 'Admin' },
];

export const permissionDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      // Singleton parent of company-level creates (design §7.2).
      key: CompanyResource.Company,
      keyKind: 'uuid',
      fields: {},
      actions: {
        [CompanyAction.Read]: optionalAction(PermissionPolicy.Read),
        [CompanyAction.CreateEmployee]: optionalAction(PermissionPolicy.Fresh),
        [CompanyAction.CreateTeam]: optionalAction(PermissionPolicy.Write),
        // Release 8 (T6 part C): display capability, the caller holds the company's final
        // decisions, for the `approvals` menu (design §10.2). It authorizes no decision or read.
        [CompanyAction.Approvals]: optionalAction(PermissionPolicy.Read),
        // Release 11 (T8, D07): HR closes and reopens an attendance month. Fresh session; the
        // company singleton is the anchor so the calendar row is not locked before the period
        // (spec §7.3 order).
        [CompanyAction.ManagePeriod]: optionalAction(PermissionPolicy.Fresh),
      },
    },
  ],
  policies: [
    permissionPolicy(PermissionPolicy.Read, { op: 'constant', value: true }),
    permissionPolicy(PermissionPolicy.Submit, { op: 'constant', value: true }),
    permissionPolicy(PermissionPolicy.Write, { op: 'constant', value: true }),
    // TD5: facts change, F2/F3 writes and company creates need a fresh reauthentication.
    permissionPolicy(PermissionPolicy.Fresh, { op: 'constant', value: true }, true),
  ],
  templates: [
    scopeTemplate(CompanyTemplate.Company, CompanyResource.Company, {
      op: 'constant',
      value: true,
    }),
  ],
  // Release 7: the limit an IAM caller of the two boundary-required actions is
  // bound to, per user and permission (no role inheritance, docs/permission-boundaries.md). It
  // grants nothing: the hr.admin grants, hrFresh, deny rules and code-owned guards still apply.
  // The scope is the company (matrix §5.2 `A`); no release seeds a binding (users are runtime).
  boundaries: [
    {
      key: PermissionBoundary.Administration,
      version: 1,
      entries: [
        permissionKey(TeamResource.Team, TeamAction.Assign),
        permissionKey(EmployeeResource.Employee, EmployeeAction.LinkAccount),
      ].map((permission) => ({
        permission,
        contextRequirements: [],
        requiredScope: { op: 'constant', value: true },
      })),
    },
  ],
};

const companyGrant = (action: CompanyAction, role: PermissionRole) =>
  defaultGrant(permissionKey(CompanyResource.Company, action), role, CompanyTemplate.Company);

export const permissionDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  companyGrant(CompanyAction.Approvals, PermissionRole.Coo),
  // T3: HR administration. The company-level creates and the period close are HR/Admin only.
  companyGrant(CompanyAction.Read, PermissionRole.Admin),
  companyGrant(CompanyAction.CreateEmployee, PermissionRole.Admin),
  companyGrant(CompanyAction.CreateTeam, PermissionRole.Admin),
  companyGrant(CompanyAction.ManagePeriod, PermissionRole.Admin),
];

export const companyBinding: ProductResourceBinding = {
  resource: CompanyResource.Company,
  table: 'hr_company',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: {},
  projection: [],
};
