import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type { Expr } from '../../authorization/core/authorization.types.js';
import type {
  ProductReleaseSource,
  ProductRole,
} from '../../authorization/services/product-manifest.service.js';
import type { ProductStorageBindings } from '../../authorization/product-sql.compiler.js';
import { ProductValidator } from '../../authorization/product-capability.types.js';
import { reportActions } from '../report/report.declarations.js';
import {
  CompanyAction,
  EmployeeAction,
  EmployeeIdentityAction,
  HrBoundary,
  HrDomain,
  HrPolicy,
  HrRelation,
  HrResource,
  HrRole,
  HrTemplate,
  LeaveRateAction,
  TeamAction,
  WorkRequestAction,
  type HrActionOf,
  hrPermission,
} from './hr-authorization.types.js';

/**
 * HR authorization fragment (ADR 0016, design §4–§5): data only, composed into release 3 in
 * authorization/. Resource/action keys are core identifiers, so the design's `work-request.decide-lead`
 * is stored as `workRequest.decideLead` (design §5.3). Business guards (no self approval, stage
 * order, quotas) stay code-owned in the commands; grants only decide who may reach a record.
 */
export const hrRoles: readonly ProductRole[] = [
  { key: HrRole.Employee, label: 'Employee' },
  { key: HrRole.Coo, label: 'COO' },
  { key: HrRole.Admin, label: 'Admin' },
];

const self: Expr = { op: 'eq', field: 'identityId', value: { from: 'principal', name: 'id' } };

const state = (value: string): Expr => ({
  op: 'eq',
  field: 'state',
  value: { from: 'literal', value },
});

const related = (relation: HrRelation): Expr => ({
  op: 'exists',
  relation: `${relation}@1`,
  where: self,
});

const template = (key: HrTemplate, resource: HrResource, expression: Expr) => ({
  key,
  version: 1,
  resource,
  parameters: {},
  expression,
});

const policy = (key: HrPolicy, requiredScope: Expr, fresh = false) => ({
  key,
  version: 1,
  contextRequirements: fresh ? [{ validator: ProductValidator.Fresh, parameters: {} }] : [],
  requiredScope,
  obligations: [],
});

const action = (key: HrPolicy) => ({ policy: { key, version: 1 }, boundary: 'optional' as const });

/** Acts on another principal's facts (ADR 0016 §7, TD6): an IAM caller needs a bound boundary. */
const bounded = (key: HrPolicy) => ({ policy: { key, version: 1 }, boundary: 'required' as const });

/** Resource → identity relation read from a current-assignment view (no resource → resource). */
const relation = (key: HrRelation, sourceType: HrResource, binding: HrDomain) => ({
  key,
  version: 1,
  sourceType,
  target: { kind: 'identity' as const },
  binding: { kind: 'domain' as const, key: binding },
});

export const hrDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries' | 'relations'
> = {
  resources: [
    {
      key: HrResource.Employee,
      keyKind: 'uuid',
      fields: {
        code: { kind: 'string' },
        fullName: { kind: 'string' },
        accountId: { kind: 'uuid', nullable: true },
      },
      actions: {
        [EmployeeAction.Read]: action(HrPolicy.Read),
        // Creating a request is authorized on the submitter's own employee record (design §7.2).
        [EmployeeAction.SubmitRequest]: action(HrPolicy.Submit),
        // F1 and employment status (T3); never the account link.
        [EmployeeAction.Update]: action(HrPolicy.Write),
        // A new F3 rate row is created on its parent employee (design §7.2).
        [EmployeeAction.AdjustLeaveRate]: action(HrPolicy.Fresh),
        // Release 10 (T7): the annual leave balance of this employee (matrix §5.2 leave-balance.read:
        // self, a lead's members, HR). A computed read, so it is authorized on the employee row.
        [EmployeeAction.ReadLeaveBalance]: action(HrPolicy.Read),
        // Release 11 (T8): the monthly attendance sheet of this employee (matrix §5.2
        // attendance.read: self and HR; a lead reads only their own). A computed read, so it is
        // authorized on the employee row like the leave balance.
        [EmployeeAction.ReadAttendance]: action(HrPolicy.Read),
        // Release 12 (T7 item 2, D07/D14): HR appends a signed `adjustment` to the leave ledger
        // (matrix §5.2 leave-rate.adjust "ledger entry"). Fresh session; the entry needs a reference.
        [EmployeeAction.AdjustLeaveBalance]: action(HrPolicy.Fresh),
        // Release 15 (T8 `attendance.adjust`, matrix §5.2: HR, fresh, open month): HR appends a
        // signed paid-minutes entry for one day of this employee, and reads those entries (the
        // reasons are HR's). Authorized on the employee row like the sheet it changes.
        [EmployeeAction.AdjustAttendance]: action(HrPolicy.Fresh),
        [EmployeeAction.ReadAttendanceAdjustment]: action(HrPolicy.Read),
        // Moves the `self` scope of every HR grant to another account: facts change (§7.1).
        [EmployeeAction.LinkAccount]: bounded(HrPolicy.Fresh),
        // Release 13 (T9): one read action per report, aggregated over the employee rows in scope.
        ...reportActions,
      },
    },
    {
      key: HrResource.Team,
      keyKind: 'uuid',
      fields: { name: { kind: 'string' } },
      actions: {
        [TeamAction.Read]: action(HrPolicy.Read),
        [TeamAction.Update]: action(HrPolicy.Write),
        // Membership and lead assignment decide lead scope: facts change (§7.1).
        [TeamAction.Assign]: bounded(HrPolicy.Fresh),
        // Release 8 (T6 part C): display capability, the caller is the current lead of this
        // team, for the `approvals` menu (design §10.2). It authorizes no decision or read.
        [TeamAction.Approvals]: action(HrPolicy.Read),
      },
    },
    {
      // Singleton parent of company-level creates (design §7.2, ADR 0016 §4).
      key: HrResource.Company,
      keyKind: 'uuid',
      fields: {},
      actions: {
        [CompanyAction.Read]: action(HrPolicy.Read),
        [CompanyAction.CreateEmployee]: action(HrPolicy.Fresh),
        [CompanyAction.CreateTeam]: action(HrPolicy.Write),
        // Release 8 (T6 part C): display capability, the caller holds the company's final
        // decisions, for the `approvals` menu (design §10.2). It authorizes no decision or read.
        [CompanyAction.Approvals]: action(HrPolicy.Read),
        // Release 11 (T8, D07): HR closes and reopens an attendance month. Fresh session; the
        // company singleton is the anchor so the calendar row is not locked before the period
        // (spec §7.3 order).
        [CompanyAction.ManagePeriod]: action(HrPolicy.Fresh),
      },
    },
    {
      // F2 (design §5.1): 1:1 with employee, keyed by the employee id.
      key: HrResource.EmployeeIdentity,
      keyKind: 'uuid',
      fields: {},
      actions: {
        [EmployeeIdentityAction.Read]: action(HrPolicy.Read),
        [EmployeeIdentityAction.Update]: action(HrPolicy.Fresh),
      },
    },
    {
      // F3: one row per effective date; rows are only added (`employee.adjustLeaveRate`).
      key: HrResource.LeaveRate,
      keyKind: 'uuid',
      fields: {},
      actions: { [LeaveRateAction.Read]: action(HrPolicy.Read) },
    },
    {
      key: HrResource.WorkRequest,
      keyKind: 'uuid',
      fields: { kind: { kind: 'string' }, state: { kind: 'string' }, version: { kind: 'integer' } },
      actions: {
        [WorkRequestAction.Read]: action(HrPolicy.Read),
        [WorkRequestAction.DecideLead]: action(HrPolicy.LeadStage),
        [WorkRequestAction.DecideFinal]: action(HrPolicy.FinalStage),
        // Release 8 (T6 part C): the decided history of the caller's approval scope (§5.2); the
        // query adds "decided" and "not the caller's own" before count and page.
        [WorkRequestAction.ReadDecided]: action(HrPolicy.Read),
        // Release 9: detail only, of a lead-owned request rejected at the lead step (COO, read
        // only: no queue, no decision). `WorkRequestService.detail` falls back to it.
        [WorkRequestAction.ReadLeadRejected]: action(HrPolicy.Read),
        // Owner cancels a pending request; HR cancels an approved one with fresh auth (design §6.2).
        [WorkRequestAction.Cancel]: action(HrPolicy.PendingStage),
        [WorkRequestAction.CancelApproved]: action(HrPolicy.ApprovedFresh),
      },
    },
  ],
  relations: [
    relation(HrRelation.EmployeeLead, HrResource.Employee, HrDomain.EmployeeLead),
    relation(HrRelation.TeamMember, HrResource.Team, HrDomain.TeamMember),
    relation(HrRelation.TeamLead, HrResource.Team, HrDomain.TeamLead),
    relation(HrRelation.RequestOwner, HrResource.WorkRequest, HrDomain.RequestOwner),
    relation(HrRelation.RequestLead, HrResource.WorkRequest, HrDomain.RequestLead),
    relation(HrRelation.RequestDecider, HrResource.WorkRequest, HrDomain.RequestDecider),
    // Release 9: the request was rejected at the lead step and its owner leads a team now.
    relation(
      HrRelation.RequestLeadRejectedLeadOwned,
      HrResource.WorkRequest,
      HrDomain.RequestLeadRejected,
    ),
    relation(HrRelation.EmployeeIdentityOwner, HrResource.EmployeeIdentity, HrDomain.EmployeeOwner),
    relation(HrRelation.LeaveRateOwner, HrResource.LeaveRate, HrDomain.LeaveRateOwner),
  ],
  policies: [
    policy(HrPolicy.Read, { op: 'constant', value: true }),
    policy(HrPolicy.Submit, { op: 'constant', value: true }),
    policy(HrPolicy.Write, { op: 'constant', value: true }),
    // TD5: facts change, F2/F3 writes and company creates need a fresh reauthentication.
    policy(HrPolicy.Fresh, { op: 'constant', value: true }, true),
    // Stage policies are code-owned: a grant on the wrong stage cannot open a decision.
    policy(HrPolicy.LeadStage, state('pending_lead')),
    policy(HrPolicy.FinalStage, state('pending_final')),
    policy(HrPolicy.PendingStage, {
      op: 'or',
      args: [state('pending_lead'), state('pending_final')],
    }),
    policy(HrPolicy.ApprovedFresh, state('approved'), true),
  ],
  templates: [
    template(HrTemplate.SelfEmployee, HrResource.Employee, {
      op: 'eq',
      field: 'accountId',
      value: { from: 'principal', name: 'id' },
    }),
    template(HrTemplate.LedEmployees, HrResource.Employee, related(HrRelation.EmployeeLead)),
    template(HrTemplate.AllEmployees, HrResource.Employee, { op: 'constant', value: true }),
    template(HrTemplate.MemberTeams, HrResource.Team, related(HrRelation.TeamMember)),
    template(HrTemplate.LedTeams, HrResource.Team, related(HrRelation.TeamLead)),
    template(HrTemplate.AllTeams, HrResource.Team, { op: 'constant', value: true }),
    template(HrTemplate.OwnRequests, HrResource.WorkRequest, related(HrRelation.RequestOwner)),
    template(HrTemplate.LedRequests, HrResource.WorkRequest, related(HrRelation.RequestLead)),
    template(
      HrTemplate.DecidedRequests,
      HrResource.WorkRequest,
      related(HrRelation.RequestDecider),
    ),
    template(HrTemplate.FinalQueue, HrResource.WorkRequest, state('pending_final')),
    // Release 9: the relation already restricts to rejected-at-lead, lead-owned requests.
    template(HrTemplate.LeadRejectedLeadRequests, HrResource.WorkRequest, {
      op: 'exists',
      relation: `${HrRelation.RequestLeadRejectedLeadOwned}@1`,
      where: { op: 'constant', value: true },
    }),
    template(HrTemplate.AllRequests, HrResource.WorkRequest, { op: 'constant', value: true }),
    template(HrTemplate.Company, HrResource.Company, { op: 'constant', value: true }),
    template(
      HrTemplate.SelfIdentity,
      HrResource.EmployeeIdentity,
      related(HrRelation.EmployeeIdentityOwner),
    ),
    template(HrTemplate.AllIdentities, HrResource.EmployeeIdentity, {
      op: 'constant',
      value: true,
    }),
    template(HrTemplate.SelfLeaveRates, HrResource.LeaveRate, related(HrRelation.LeaveRateOwner)),
    template(HrTemplate.AllLeaveRates, HrResource.LeaveRate, { op: 'constant', value: true }),
  ],
  // Release 7 (ADR 0016 §7): the limit an IAM caller of the two boundary-required actions is
  // bound to, per user and permission (no role inheritance, docs/permission-boundaries.md). It
  // grants nothing: the hr.admin grants, hrFresh, deny rules and code-owned guards still apply.
  // The scope is the company (matrix §5.2 `A`); no release seeds a binding (users are runtime).
  boundaries: [
    {
      key: HrBoundary.Administration,
      version: 1,
      entries: [
        hrPermission(HrResource.Team, TeamAction.Assign),
        hrPermission(HrResource.Employee, EmployeeAction.LinkAccount),
      ].map((permission) => ({
        permission,
        contextRequirements: [],
        requiredScope: { op: 'constant', value: true },
      })),
    },
  ],
};

const grant = <R extends HrResource>(
  resource: R,
  action: HrActionOf[R],
  role: HrRole,
  key: HrTemplate,
) => ({
  permission: hrPermission(resource, action),
  role,
  template: { key, version: 1 },
  parameters: {},
});

/** Matrix §5.2: Team Lead has no role; its scope comes from the current assignment (§6.4). */
export const hrDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  grant(HrResource.Employee, EmployeeAction.Read, HrRole.Employee, HrTemplate.SelfEmployee),
  grant(HrResource.Employee, EmployeeAction.Read, HrRole.Employee, HrTemplate.LedEmployees),
  grant(HrResource.Employee, EmployeeAction.Read, HrRole.Coo, HrTemplate.AllEmployees),
  grant(HrResource.Employee, EmployeeAction.Read, HrRole.Admin, HrTemplate.AllEmployees),
  grant(
    HrResource.Employee,
    EmployeeAction.SubmitRequest,
    HrRole.Employee,
    HrTemplate.SelfEmployee,
  ),
  // Release 10: F6 leave balance. The COO and the CEO read only their own (no COO-wide grant).
  grant(
    HrResource.Employee,
    EmployeeAction.ReadLeaveBalance,
    HrRole.Employee,
    HrTemplate.SelfEmployee,
  ),
  grant(
    HrResource.Employee,
    EmployeeAction.ReadLeaveBalance,
    HrRole.Employee,
    HrTemplate.LedEmployees,
  ),
  grant(
    HrResource.Employee,
    EmployeeAction.ReadLeaveBalance,
    HrRole.Admin,
    HrTemplate.AllEmployees,
  ),
  // Release 11: attendance sheet. Lead and COO read only their own (no `ledEmployees`, no COO-wide grant).
  grant(
    HrResource.Employee,
    EmployeeAction.ReadAttendance,
    HrRole.Employee,
    HrTemplate.SelfEmployee,
  ),
  grant(HrResource.Employee, EmployeeAction.ReadAttendance, HrRole.Admin, HrTemplate.AllEmployees),
  grant(HrResource.Team, TeamAction.Read, HrRole.Employee, HrTemplate.MemberTeams),
  grant(HrResource.Team, TeamAction.Read, HrRole.Employee, HrTemplate.LedTeams),
  grant(HrResource.Team, TeamAction.Read, HrRole.Coo, HrTemplate.AllTeams),
  grant(HrResource.Team, TeamAction.Read, HrRole.Admin, HrTemplate.AllTeams),
  grant(HrResource.WorkRequest, WorkRequestAction.Read, HrRole.Employee, HrTemplate.OwnRequests),
  grant(HrResource.WorkRequest, WorkRequestAction.Read, HrRole.Employee, HrTemplate.LedRequests),
  grant(
    HrResource.WorkRequest,
    WorkRequestAction.Read,
    HrRole.Employee,
    HrTemplate.DecidedRequests,
  ),
  grant(HrResource.WorkRequest, WorkRequestAction.Read, HrRole.Coo, HrTemplate.DecidedRequests),
  grant(HrResource.WorkRequest, WorkRequestAction.Read, HrRole.Coo, HrTemplate.FinalQueue),
  grant(HrResource.WorkRequest, WorkRequestAction.Read, HrRole.Admin, HrTemplate.AllRequests),
  grant(
    HrResource.WorkRequest,
    WorkRequestAction.DecideLead,
    HrRole.Employee,
    HrTemplate.LedRequests,
  ),
  grant(HrResource.WorkRequest, WorkRequestAction.DecideFinal, HrRole.Coo, HrTemplate.AllRequests),
  // Release 8: history and menu follow the approval right — the request's current first-step
  // approver (lead) or the whole company (COO); Root is unrestricted. HR/Admin decides nothing.
  grant(
    HrResource.WorkRequest,
    WorkRequestAction.ReadDecided,
    HrRole.Employee,
    HrTemplate.LedRequests,
  ),
  grant(HrResource.WorkRequest, WorkRequestAction.ReadDecided, HrRole.Coo, HrTemplate.AllRequests),
  // Release 9: the COO reads (never decides) a lead's request rejected at the lead step. A new
  // action, because a sync seeds default grants only for permissions a release creates.
  grant(
    HrResource.WorkRequest,
    WorkRequestAction.ReadLeadRejected,
    HrRole.Coo,
    HrTemplate.LeadRejectedLeadRequests,
  ),
  grant(HrResource.Team, TeamAction.Approvals, HrRole.Employee, HrTemplate.LedTeams),
  grant(HrResource.Company, CompanyAction.Approvals, HrRole.Coo, HrTemplate.Company),
  grant(HrResource.WorkRequest, WorkRequestAction.Cancel, HrRole.Employee, HrTemplate.OwnRequests),
  grant(
    HrResource.WorkRequest,
    WorkRequestAction.CancelApproved,
    HrRole.Admin,
    HrTemplate.AllRequests,
  ),
  // T3: HR administration. linkAccount/assign also need a bound boundary for an IAM caller:
  // release 7 declares `hrAdministration@1`, and the caller still needs a per-user binding
  // (ADR 0016 §7).
  grant(HrResource.Company, CompanyAction.Read, HrRole.Admin, HrTemplate.Company),
  grant(HrResource.Company, CompanyAction.CreateEmployee, HrRole.Admin, HrTemplate.Company),
  grant(HrResource.Company, CompanyAction.CreateTeam, HrRole.Admin, HrTemplate.Company),
  grant(HrResource.Company, CompanyAction.ManagePeriod, HrRole.Admin, HrTemplate.Company),
  grant(HrResource.Employee, EmployeeAction.Update, HrRole.Admin, HrTemplate.AllEmployees),
  grant(HrResource.Employee, EmployeeAction.AdjustLeaveRate, HrRole.Admin, HrTemplate.AllEmployees),
  // Release 12: ledger adjustment of the leave balance (HR only; no lead, no COO, no self).
  grant(
    HrResource.Employee,
    EmployeeAction.AdjustLeaveBalance,
    HrRole.Admin,
    HrTemplate.AllEmployees,
  ),
  // Release 15: attendance adjustments (HR only; no lead, no COO, no employee, not even their own).
  grant(
    HrResource.Employee,
    EmployeeAction.AdjustAttendance,
    HrRole.Admin,
    HrTemplate.AllEmployees,
  ),
  grant(
    HrResource.Employee,
    EmployeeAction.ReadAttendanceAdjustment,
    HrRole.Admin,
    HrTemplate.AllEmployees,
  ),
  grant(HrResource.Employee, EmployeeAction.LinkAccount, HrRole.Admin, HrTemplate.AllEmployees),
  grant(HrResource.Team, TeamAction.Update, HrRole.Admin, HrTemplate.AllTeams),
  grant(HrResource.Team, TeamAction.Assign, HrRole.Admin, HrTemplate.AllTeams),
  // D08: an employee reads own F2/F3; Lead and COO do not.
  grant(
    HrResource.EmployeeIdentity,
    EmployeeIdentityAction.Read,
    HrRole.Employee,
    HrTemplate.SelfIdentity,
  ),
  grant(
    HrResource.EmployeeIdentity,
    EmployeeIdentityAction.Read,
    HrRole.Admin,
    HrTemplate.AllIdentities,
  ),
  grant(
    HrResource.EmployeeIdentity,
    EmployeeIdentityAction.Update,
    HrRole.Admin,
    HrTemplate.AllIdentities,
  ),
  grant(HrResource.LeaveRate, LeaveRateAction.Read, HrRole.Employee, HrTemplate.SelfLeaveRates),
  grant(HrResource.LeaveRate, LeaveRateAction.Read, HrRole.Admin, HrTemplate.AllLeaveRates),
];

/** Scope relations read current membership/assignment views (security_invoker, migration HR). */
export const hrBindings: ProductStorageBindings = {
  resources: [
    {
      resource: HrResource.Employee,
      table: 'employee',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: { code: 'code', fullName: 'full_name', accountId: 'account_id' },
      projection: ['code', 'fullName'],
    },
    {
      resource: HrResource.Team,
      table: 'team',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: { name: 'name' },
      projection: ['name'],
    },
    {
      resource: HrResource.WorkRequest,
      table: 'work_request',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: { kind: 'kind', state: 'state', version: 'version' },
      projection: ['kind', 'state', 'version'],
    },
    {
      resource: HrResource.Company,
      table: 'hr_company',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: {},
      projection: [],
    },
    {
      resource: HrResource.EmployeeIdentity,
      table: 'employee_identity',
      objectIdColumn: 'object_id',
      keyColumn: 'employee_id',
      columns: {},
      projection: [],
    },
    {
      resource: HrResource.LeaveRate,
      table: 'leave_rate',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: {},
      projection: [],
    },
  ],
  domains: {
    [HrDomain.EmployeeLead]: {
      table: 'hr_employee_lead',
      sourceColumn: 'employee_id',
      targetColumn: 'lead_account_id',
    },
    [HrDomain.TeamMember]: {
      table: 'hr_team_member',
      sourceColumn: 'team_id',
      targetColumn: 'account_id',
    },
    [HrDomain.TeamLead]: {
      table: 'hr_team_lead',
      sourceColumn: 'team_id',
      targetColumn: 'lead_account_id',
    },
    [HrDomain.RequestOwner]: {
      table: 'hr_request_owner',
      sourceColumn: 'request_id',
      targetColumn: 'account_id',
    },
    [HrDomain.RequestLead]: {
      table: 'hr_request_lead',
      sourceColumn: 'request_id',
      targetColumn: 'lead_account_id',
    },
    [HrDomain.RequestDecider]: {
      table: 'hr_request_decider',
      sourceColumn: 'request_id',
      targetColumn: 'actor_account_id',
    },
    [HrDomain.RequestLeadRejected]: {
      table: 'hr_request_lead_rejected',
      sourceColumn: 'request_id',
      targetColumn: 'owner_account_id',
    },
    [HrDomain.EmployeeOwner]: {
      table: 'hr_employee_owner',
      sourceColumn: 'employee_id',
      targetColumn: 'account_id',
    },
    [HrDomain.LeaveRateOwner]: {
      table: 'hr_leave_rate_owner',
      sourceColumn: 'rate_id',
      targetColumn: 'account_id',
    },
  },
};
