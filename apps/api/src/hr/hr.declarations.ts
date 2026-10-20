import type { SystemDeclarations } from '../authorization/core/authorization.declarations.js';
import type { Expr } from '../authorization/core/authorization.types.js';
import type {
  ProductReleaseSource,
  ProductRole,
} from '../authorization/services/product-manifest.service.js';
import type { ProductStorageBindings } from '../authorization/product-sql.compiler.js';

/**
 * HR authorization fragment (ADR 0016, design §4–§5): data only, composed into release 3 in
 * authorization/. Resource/action keys are core identifiers, so the design's `work-request.decide-lead`
 * is stored as `workRequest.decideLead` (design §5.3). Business guards (no self approval, stage
 * order, quotas) stay code-owned in the commands; grants only decide who may reach a record.
 */
export const hrRoles: readonly ProductRole[] = [
  { key: 'hr.employee', label: 'Nhân viên' },
  { key: 'hr.coo', label: 'COO (duyệt cuối)' },
  { key: 'hr.admin', label: 'HR/Admin' },
];

const self: Expr = { op: 'eq', field: 'identityId', value: { from: 'principal', name: 'id' } };

const state = (value: string): Expr => ({
  op: 'eq',
  field: 'state',
  value: { from: 'literal', value },
});

const related = (relation: string): Expr => ({ op: 'exists', relation, where: self });

const template = (key: string, resource: string, expression: Expr) => ({
  key,
  version: 1,
  resource,
  parameters: {},
  expression,
});

const policy = (key: string, requiredScope: Expr, fresh = false) => ({
  key,
  version: 1,
  contextRequirements: fresh ? [{ validator: 'fresh@1', parameters: {} }] : [],
  requiredScope,
  obligations: [],
});

const action = (key: string) => ({ policy: { key, version: 1 }, boundary: 'optional' as const });

/** Acts on another principal's facts (ADR 0016 §7, TD6): an IAM caller needs a bound boundary. */
const bounded = (key: string) => ({ policy: { key, version: 1 }, boundary: 'required' as const });

/** Resource → identity relation read from a current-assignment view (no resource → resource). */
const relation = (key: string, sourceType: string, binding: string) => ({
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
      key: 'employee',
      keyKind: 'uuid',
      fields: {
        code: { kind: 'string' },
        fullName: { kind: 'string' },
        accountId: { kind: 'uuid', nullable: true },
      },
      actions: {
        read: action('hrRead'),
        // Creating a request is authorized on the submitter's own employee record (design §7.2).
        submitRequest: action('hrSubmit'),
        // F1 and employment status (T3); never the account link.
        update: action('hrWrite'),
        // A new F3 rate row is created on its parent employee (design §7.2).
        adjustLeaveRate: action('hrFresh'),
        // Release 10 (T7): the annual leave balance of this employee (matrix §5.2 leave-balance.read:
        // self, a lead's members, HR). A computed read, so it is authorized on the employee row.
        readLeaveBalance: action('hrRead'),
        // Moves the `self` scope of every HR grant to another account: facts change (§7.1).
        linkAccount: bounded('hrFresh'),
      },
    },
    {
      key: 'team',
      keyKind: 'uuid',
      fields: { name: { kind: 'string' } },
      actions: {
        read: action('hrRead'),
        update: action('hrWrite'),
        // Membership and lead assignment decide lead scope: facts change (§7.1).
        assign: bounded('hrFresh'),
        // Release 8 (T6 part C): display capability, the caller is the current lead of this
        // team, for the `approvals` menu (design §10.2). It authorizes no decision or read.
        approvals: action('hrRead'),
      },
    },
    {
      // Singleton parent of company-level creates (design §7.2, ADR 0016 §4).
      key: 'hrCompany',
      keyKind: 'uuid',
      fields: {},
      actions: {
        read: action('hrRead'),
        createEmployee: action('hrFresh'),
        createTeam: action('hrWrite'),
        // Release 8 (T6 part C): display capability, the caller holds the company's final
        // decisions, for the `approvals` menu (design §10.2). It authorizes no decision or read.
        approvals: action('hrRead'),
      },
    },
    {
      // F2 (design §5.1): 1:1 with employee, keyed by the employee id.
      key: 'employeeIdentity',
      keyKind: 'uuid',
      fields: {},
      actions: { read: action('hrRead'), update: action('hrFresh') },
    },
    {
      // F3: one row per effective date; rows are only added (`employee.adjustLeaveRate`).
      key: 'leaveRate',
      keyKind: 'uuid',
      fields: {},
      actions: { read: action('hrRead') },
    },
    {
      key: 'workRequest',
      keyKind: 'uuid',
      fields: { kind: { kind: 'string' }, state: { kind: 'string' }, version: { kind: 'integer' } },
      actions: {
        read: action('hrRead'),
        decideLead: action('leadStage'),
        decideFinal: action('finalStage'),
        // Release 8 (T6 part C): the decided history of the caller's approval scope (§5.2); the
        // query adds "decided" and "not the caller's own" before count and page.
        readDecided: action('hrRead'),
        // Release 9: detail only, of a lead-owned request rejected at the lead step (COO, read
        // only: no queue, no decision). `WorkRequestService.detail` falls back to it.
        readLeadRejected: action('hrRead'),
        // Owner cancels a pending request; HR cancels an approved one with fresh auth (design §6.2).
        cancel: action('pendingStage'),
        cancelApproved: action('approvedFresh'),
      },
    },
  ],
  relations: [
    relation('employee.lead', 'employee', 'hrEmployeeLead'),
    relation('team.member', 'team', 'hrTeamMember'),
    relation('team.lead', 'team', 'hrTeamLead'),
    relation('workRequest.owner', 'workRequest', 'hrRequestOwner'),
    relation('workRequest.lead', 'workRequest', 'hrRequestLead'),
    relation('workRequest.decider', 'workRequest', 'hrRequestDecider'),
    // Release 9: the request was rejected at the lead step and its owner leads a team now.
    relation('workRequest.leadRejectedLeadOwned', 'workRequest', 'hrRequestLeadRejected'),
    relation('employeeIdentity.owner', 'employeeIdentity', 'hrEmployeeOwner'),
    relation('leaveRate.owner', 'leaveRate', 'hrLeaveRateOwner'),
  ],
  policies: [
    policy('hrRead', { op: 'constant', value: true }),
    policy('hrSubmit', { op: 'constant', value: true }),
    policy('hrWrite', { op: 'constant', value: true }),
    // TD5: facts change, F2/F3 writes and company creates need a fresh reauthentication.
    policy('hrFresh', { op: 'constant', value: true }, true),
    // Stage policies are code-owned: a grant on the wrong stage cannot open a decision.
    policy('leadStage', state('pending_lead')),
    policy('finalStage', state('pending_final')),
    policy('pendingStage', { op: 'or', args: [state('pending_lead'), state('pending_final')] }),
    policy('approvedFresh', state('approved'), true),
  ],
  templates: [
    template('selfEmployee', 'employee', {
      op: 'eq',
      field: 'accountId',
      value: { from: 'principal', name: 'id' },
    }),
    template('ledEmployees', 'employee', related('employee.lead@1')),
    template('allEmployees', 'employee', { op: 'constant', value: true }),
    template('memberTeams', 'team', related('team.member@1')),
    template('ledTeams', 'team', related('team.lead@1')),
    template('allTeams', 'team', { op: 'constant', value: true }),
    template('ownRequests', 'workRequest', related('workRequest.owner@1')),
    template('ledRequests', 'workRequest', related('workRequest.lead@1')),
    template('decidedRequests', 'workRequest', related('workRequest.decider@1')),
    template('finalQueue', 'workRequest', state('pending_final')),
    // Release 9: the relation already restricts to rejected-at-lead, lead-owned requests.
    template('leadRejectedLeadRequests', 'workRequest', {
      op: 'exists',
      relation: 'workRequest.leadRejectedLeadOwned@1',
      where: { op: 'constant', value: true },
    }),
    template('allRequests', 'workRequest', { op: 'constant', value: true }),
    template('company', 'hrCompany', { op: 'constant', value: true }),
    template('selfIdentity', 'employeeIdentity', related('employeeIdentity.owner@1')),
    template('allIdentities', 'employeeIdentity', { op: 'constant', value: true }),
    template('selfLeaveRates', 'leaveRate', related('leaveRate.owner@1')),
    template('allLeaveRates', 'leaveRate', { op: 'constant', value: true }),
  ],
  // Release 7 (ADR 0016 §7): the limit an IAM caller of the two boundary-required actions is
  // bound to, per user and permission (no role inheritance, docs/permission-boundaries.md). It
  // grants nothing: the hr.admin grants, hrFresh, deny rules and code-owned guards still apply.
  // The scope is the company (matrix §5.2 `A`); no release seeds a binding (users are runtime).
  boundaries: [
    {
      key: 'hrAdministration',
      version: 1,
      entries: ['team.assign', 'employee.linkAccount'].map((permission) => ({
        permission,
        contextRequirements: [],
        requiredScope: { op: 'constant', value: true },
      })),
    },
  ],
};

const grant = (permission: string, role: string, key: string) => ({
  permission,
  role,
  template: { key, version: 1 },
  parameters: {},
});

/** Matrix §5.2: Team Lead has no role; its scope comes from the current assignment (§6.4). */
export const hrDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  grant('employee.read', 'hr.employee', 'selfEmployee'),
  grant('employee.read', 'hr.employee', 'ledEmployees'),
  grant('employee.read', 'hr.coo', 'allEmployees'),
  grant('employee.read', 'hr.admin', 'allEmployees'),
  grant('employee.submitRequest', 'hr.employee', 'selfEmployee'),
  // Release 10: F6 leave balance. The COO and the CEO read only their own (no COO-wide grant).
  grant('employee.readLeaveBalance', 'hr.employee', 'selfEmployee'),
  grant('employee.readLeaveBalance', 'hr.employee', 'ledEmployees'),
  grant('employee.readLeaveBalance', 'hr.admin', 'allEmployees'),
  grant('team.read', 'hr.employee', 'memberTeams'),
  grant('team.read', 'hr.employee', 'ledTeams'),
  grant('team.read', 'hr.coo', 'allTeams'),
  grant('team.read', 'hr.admin', 'allTeams'),
  grant('workRequest.read', 'hr.employee', 'ownRequests'),
  grant('workRequest.read', 'hr.employee', 'ledRequests'),
  grant('workRequest.read', 'hr.employee', 'decidedRequests'),
  grant('workRequest.read', 'hr.coo', 'decidedRequests'),
  grant('workRequest.read', 'hr.coo', 'finalQueue'),
  grant('workRequest.read', 'hr.admin', 'allRequests'),
  grant('workRequest.decideLead', 'hr.employee', 'ledRequests'),
  grant('workRequest.decideFinal', 'hr.coo', 'allRequests'),
  // Release 8: history and menu follow the approval right — the request's current first-step
  // approver (lead) or the whole company (COO); Root is unrestricted. HR/Admin decides nothing.
  grant('workRequest.readDecided', 'hr.employee', 'ledRequests'),
  grant('workRequest.readDecided', 'hr.coo', 'allRequests'),
  // Release 9: the COO reads (never decides) a lead's request rejected at the lead step. A new
  // action, because a sync seeds default grants only for permissions a release creates.
  grant('workRequest.readLeadRejected', 'hr.coo', 'leadRejectedLeadRequests'),
  grant('team.approvals', 'hr.employee', 'ledTeams'),
  grant('hrCompany.approvals', 'hr.coo', 'company'),
  grant('workRequest.cancel', 'hr.employee', 'ownRequests'),
  grant('workRequest.cancelApproved', 'hr.admin', 'allRequests'),
  // T3: HR administration. linkAccount/assign also need a bound boundary for an IAM caller:
  // release 7 declares `hrAdministration@1`, and the caller still needs a per-user binding
  // (ADR 0016 §7).
  grant('hrCompany.read', 'hr.admin', 'company'),
  grant('hrCompany.createEmployee', 'hr.admin', 'company'),
  grant('hrCompany.createTeam', 'hr.admin', 'company'),
  grant('employee.update', 'hr.admin', 'allEmployees'),
  grant('employee.adjustLeaveRate', 'hr.admin', 'allEmployees'),
  grant('employee.linkAccount', 'hr.admin', 'allEmployees'),
  grant('team.update', 'hr.admin', 'allTeams'),
  grant('team.assign', 'hr.admin', 'allTeams'),
  // D08: an employee reads own F2/F3; Lead and COO do not.
  grant('employeeIdentity.read', 'hr.employee', 'selfIdentity'),
  grant('employeeIdentity.read', 'hr.admin', 'allIdentities'),
  grant('employeeIdentity.update', 'hr.admin', 'allIdentities'),
  grant('leaveRate.read', 'hr.employee', 'selfLeaveRates'),
  grant('leaveRate.read', 'hr.admin', 'allLeaveRates'),
];

/** Scope relations read current membership/assignment views (security_invoker, migration HR). */
export const hrBindings: ProductStorageBindings = {
  resources: [
    {
      resource: 'employee',
      table: 'employee',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: { code: 'code', fullName: 'full_name', accountId: 'account_id' },
      projection: ['code', 'fullName'],
    },
    {
      resource: 'team',
      table: 'team',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: { name: 'name' },
      projection: ['name'],
    },
    {
      resource: 'workRequest',
      table: 'work_request',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: { kind: 'kind', state: 'state', version: 'version' },
      projection: ['kind', 'state', 'version'],
    },
    {
      resource: 'hrCompany',
      table: 'hr_company',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: {},
      projection: [],
    },
    {
      resource: 'employeeIdentity',
      table: 'employee_identity',
      objectIdColumn: 'object_id',
      keyColumn: 'employee_id',
      columns: {},
      projection: [],
    },
    {
      resource: 'leaveRate',
      table: 'leave_rate',
      objectIdColumn: 'object_id',
      keyColumn: 'id',
      columns: {},
      projection: [],
    },
  ],
  domains: {
    hrEmployeeLead: {
      table: 'hr_employee_lead',
      sourceColumn: 'employee_id',
      targetColumn: 'lead_account_id',
    },
    hrTeamMember: { table: 'hr_team_member', sourceColumn: 'team_id', targetColumn: 'account_id' },
    hrTeamLead: { table: 'hr_team_lead', sourceColumn: 'team_id', targetColumn: 'lead_account_id' },
    hrRequestOwner: {
      table: 'hr_request_owner',
      sourceColumn: 'request_id',
      targetColumn: 'account_id',
    },
    hrRequestLead: {
      table: 'hr_request_lead',
      sourceColumn: 'request_id',
      targetColumn: 'lead_account_id',
    },
    hrRequestDecider: {
      table: 'hr_request_decider',
      sourceColumn: 'request_id',
      targetColumn: 'actor_account_id',
    },
    hrRequestLeadRejected: {
      table: 'hr_request_lead_rejected',
      sourceColumn: 'request_id',
      targetColumn: 'owner_account_id',
    },
    hrEmployeeOwner: {
      table: 'hr_employee_owner',
      sourceColumn: 'employee_id',
      targetColumn: 'account_id',
    },
    hrLeaveRateOwner: {
      table: 'hr_leave_rate_owner',
      sourceColumn: 'rate_id',
      targetColumn: 'account_id',
    },
  },
};
