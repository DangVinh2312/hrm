import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';
import type {
  ProductDomainRelationBinding,
  ProductResourceBinding,
} from '../../authorization/product-sql.compiler.js';
import {
  boundedAction,
  defaultGrant,
  identityRelation,
  optionalAction,
  permissionKey,
  relatedScope,
  scopeTemplate,
} from '../permission/permission-declaration.helper.js';
import { PermissionPolicy, PermissionRole } from '../permission/permission-authorization.types.js';
import { reportActions } from '../report/report.declarations.js';
import {
  EmployeeAction,
  type EmployeeActionOf,
  EmployeeDomain,
  EmployeeIdentityAction,
  EmployeeRelation,
  EmployeeResource,
  EmployeeTemplate,
  LeaveRateAction,
} from './employee-authorization.types.js';

/**
 * Employee authorization fragment: the employee, its F2 identity and its F3
 * leave rates. Data only, composed into the release in authorization/product.manifest.ts.
 */
export const employeeDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries' | 'relations'
> = {
  resources: [
    {
      key: EmployeeResource.Employee,
      keyKind: 'uuid',
      fields: {
        code: { kind: 'string' },
        fullName: { kind: 'string' },
        accountId: { kind: 'uuid', nullable: true },
      },
      actions: {
        [EmployeeAction.Read]: optionalAction(PermissionPolicy.Read),
        // Creating a request is authorized on the submitter's own employee record (design §7.2).
        [EmployeeAction.SubmitRequest]: optionalAction(PermissionPolicy.Submit),
        // F1 and employment status (T3); never the account link.
        [EmployeeAction.Update]: optionalAction(PermissionPolicy.Write),
        // A new F3 rate row is created on its parent employee (design §7.2).
        [EmployeeAction.AdjustLeaveRate]: optionalAction(PermissionPolicy.Fresh),
        // Release 10 (T7): the annual leave balance of this employee (matrix §5.2 leave-balance.read:
        // self, a lead's members, HR). A computed read, so it is authorized on the employee row.
        [EmployeeAction.ReadLeaveBalance]: optionalAction(PermissionPolicy.Read),
        // Release 11 (T8): the monthly attendance sheet of this employee (matrix §5.2
        // attendance.read: self and HR; a lead reads only their own). A computed read, so it is
        // authorized on the employee row like the leave balance.
        [EmployeeAction.ReadAttendance]: optionalAction(PermissionPolicy.Read),
        // Release 12 (T7 item 2, D07/D14): HR appends a signed `adjustment` to the leave ledger
        // (matrix §5.2 leave-rate.adjust "ledger entry"). Fresh session; the entry needs a reference.
        [EmployeeAction.AdjustLeaveBalance]: optionalAction(PermissionPolicy.Fresh),
        // Release 15 (T8 `attendance.adjust`, matrix §5.2: HR, fresh, open month): HR appends a
        // signed paid-minutes entry for one day of this employee, and reads those entries (the
        // reasons are HR's). Authorized on the employee row like the sheet it changes.
        [EmployeeAction.AdjustAttendance]: optionalAction(PermissionPolicy.Fresh),
        [EmployeeAction.ReadAttendanceAdjustment]: optionalAction(PermissionPolicy.Read),
        // Moves the `self` scope of every HR grant to another account: facts change (§7.1).
        [EmployeeAction.LinkAccount]: boundedAction(PermissionPolicy.Fresh),
        // Release 13 (T9): one read action per report, aggregated over the employee rows in scope.
        ...reportActions,
      },
    },
    {
      // F2 (design §5.1): 1:1 with employee, keyed by the employee id.
      key: EmployeeResource.EmployeeIdentity,
      keyKind: 'uuid',
      fields: {},
      actions: {
        [EmployeeIdentityAction.Read]: optionalAction(PermissionPolicy.Read),
        [EmployeeIdentityAction.Update]: optionalAction(PermissionPolicy.Fresh),
      },
    },
    {
      // F3: one row per effective date; rows are only added (`employee.adjustLeaveRate`).
      key: EmployeeResource.LeaveRate,
      keyKind: 'uuid',
      fields: {},
      actions: { [LeaveRateAction.Read]: optionalAction(PermissionPolicy.Read) },
    },
  ],
  relations: [
    identityRelation(
      EmployeeRelation.EmployeeLead,
      EmployeeResource.Employee,
      EmployeeDomain.EmployeeLead,
    ),
    identityRelation(
      EmployeeRelation.EmployeeIdentityOwner,
      EmployeeResource.EmployeeIdentity,
      EmployeeDomain.EmployeeOwner,
    ),
    identityRelation(
      EmployeeRelation.LeaveRateOwner,
      EmployeeResource.LeaveRate,
      EmployeeDomain.LeaveRateOwner,
    ),
  ],
  policies: [],
  templates: [
    scopeTemplate(EmployeeTemplate.SelfEmployee, EmployeeResource.Employee, {
      op: 'eq',
      field: 'accountId',
      value: { from: 'principal', name: 'id' },
    }),
    scopeTemplate(
      EmployeeTemplate.LedEmployees,
      EmployeeResource.Employee,
      relatedScope(EmployeeRelation.EmployeeLead),
    ),
    scopeTemplate(EmployeeTemplate.AllEmployees, EmployeeResource.Employee, {
      op: 'constant',
      value: true,
    }),
    scopeTemplate(
      EmployeeTemplate.SelfIdentity,
      EmployeeResource.EmployeeIdentity,
      relatedScope(EmployeeRelation.EmployeeIdentityOwner),
    ),
    scopeTemplate(EmployeeTemplate.AllIdentities, EmployeeResource.EmployeeIdentity, {
      op: 'constant',
      value: true,
    }),
    scopeTemplate(
      EmployeeTemplate.SelfLeaveRates,
      EmployeeResource.LeaveRate,
      relatedScope(EmployeeRelation.LeaveRateOwner),
    ),
    scopeTemplate(EmployeeTemplate.AllLeaveRates, EmployeeResource.LeaveRate, {
      op: 'constant',
      value: true,
    }),
  ],
  boundaries: [],
};

const grant = <R extends EmployeeResource>(
  resource: R,
  action: EmployeeActionOf[R],
  role: PermissionRole,
  template: EmployeeTemplate,
) => defaultGrant(permissionKey(resource, action), role, template);

const employee = EmployeeResource.Employee;

/** Matrix §5.2: Team Lead has no role; its scope comes from the current assignment (§6.4). */
export const employeeDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  grant(employee, EmployeeAction.Read, PermissionRole.Employee, EmployeeTemplate.SelfEmployee),
  grant(employee, EmployeeAction.Read, PermissionRole.Employee, EmployeeTemplate.LedEmployees),
  grant(employee, EmployeeAction.Read, PermissionRole.Coo, EmployeeTemplate.AllEmployees),
  grant(employee, EmployeeAction.Read, PermissionRole.Admin, EmployeeTemplate.AllEmployees),
  grant(
    employee,
    EmployeeAction.SubmitRequest,
    PermissionRole.Employee,
    EmployeeTemplate.SelfEmployee,
  ),
  // Release 10: F6 leave balance. The COO and the CEO read only their own (no COO-wide grant).
  grant(
    employee,
    EmployeeAction.ReadLeaveBalance,
    PermissionRole.Employee,
    EmployeeTemplate.SelfEmployee,
  ),
  grant(
    employee,
    EmployeeAction.ReadLeaveBalance,
    PermissionRole.Employee,
    EmployeeTemplate.LedEmployees,
  ),
  grant(
    employee,
    EmployeeAction.ReadLeaveBalance,
    PermissionRole.Admin,
    EmployeeTemplate.AllEmployees,
  ),
  // Release 11: attendance sheet. Lead and COO read only their own (no `ledEmployees`, no COO-wide grant).
  grant(
    employee,
    EmployeeAction.ReadAttendance,
    PermissionRole.Employee,
    EmployeeTemplate.SelfEmployee,
  ),
  grant(
    employee,
    EmployeeAction.ReadAttendance,
    PermissionRole.Admin,
    EmployeeTemplate.AllEmployees,
  ),
  // T3: HR administration. linkAccount also needs a bound boundary for an IAM caller:
  // release 7 declares `hrAdministration@1`, and the caller still needs a per-user binding.
  grant(employee, EmployeeAction.Update, PermissionRole.Admin, EmployeeTemplate.AllEmployees),
  grant(
    employee,
    EmployeeAction.AdjustLeaveRate,
    PermissionRole.Admin,
    EmployeeTemplate.AllEmployees,
  ),
  // Release 12: ledger adjustment of the leave balance (HR only; no lead, no COO, no self).
  grant(
    employee,
    EmployeeAction.AdjustLeaveBalance,
    PermissionRole.Admin,
    EmployeeTemplate.AllEmployees,
  ),
  // Release 15: attendance adjustments (HR only; no lead, no COO, no employee, not even their own).
  grant(
    employee,
    EmployeeAction.AdjustAttendance,
    PermissionRole.Admin,
    EmployeeTemplate.AllEmployees,
  ),
  grant(
    employee,
    EmployeeAction.ReadAttendanceAdjustment,
    PermissionRole.Admin,
    EmployeeTemplate.AllEmployees,
  ),
  grant(employee, EmployeeAction.LinkAccount, PermissionRole.Admin, EmployeeTemplate.AllEmployees),
  // D08: an employee reads own F2/F3; Lead and COO do not.
  grant(
    EmployeeResource.EmployeeIdentity,
    EmployeeIdentityAction.Read,
    PermissionRole.Employee,
    EmployeeTemplate.SelfIdentity,
  ),
  grant(
    EmployeeResource.EmployeeIdentity,
    EmployeeIdentityAction.Read,
    PermissionRole.Admin,
    EmployeeTemplate.AllIdentities,
  ),
  grant(
    EmployeeResource.EmployeeIdentity,
    EmployeeIdentityAction.Update,
    PermissionRole.Admin,
    EmployeeTemplate.AllIdentities,
  ),
  grant(
    EmployeeResource.LeaveRate,
    LeaveRateAction.Read,
    PermissionRole.Employee,
    EmployeeTemplate.SelfLeaveRates,
  ),
  grant(
    EmployeeResource.LeaveRate,
    LeaveRateAction.Read,
    PermissionRole.Admin,
    EmployeeTemplate.AllLeaveRates,
  ),
];

/** Scope relations read current membership/assignment views (security_invoker, migration HR). */
export const employeeBinding: ProductResourceBinding = {
  resource: EmployeeResource.Employee,
  table: 'employee',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: { code: 'code', fullName: 'full_name', accountId: 'account_id' },
  projection: ['code', 'fullName'],
};

export const employeeIdentityBinding: ProductResourceBinding = {
  resource: EmployeeResource.EmployeeIdentity,
  table: 'employee_identity',
  objectIdColumn: 'object_id',
  keyColumn: 'employee_id',
  columns: {},
  projection: [],
};

export const leaveRateBinding: ProductResourceBinding = {
  resource: EmployeeResource.LeaveRate,
  table: 'leave_rate',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: {},
  projection: [],
};

export const employeeDomains: Readonly<Record<EmployeeDomain, ProductDomainRelationBinding>> = {
  [EmployeeDomain.EmployeeLead]: {
    table: 'hr_employee_lead',
    sourceColumn: 'employee_id',
    targetColumn: 'lead_account_id',
  },
  [EmployeeDomain.EmployeeOwner]: {
    table: 'hr_employee_owner',
    sourceColumn: 'employee_id',
    targetColumn: 'account_id',
  },
  [EmployeeDomain.LeaveRateOwner]: {
    table: 'hr_leave_rate_owner',
    sourceColumn: 'rate_id',
    targetColumn: 'account_id',
  },
};
