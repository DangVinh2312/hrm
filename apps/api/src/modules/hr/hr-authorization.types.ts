import type { ReportAction } from '../report/report-authorization.types.js';

/**
 * Keys of the HR authorization fragment (ADR 0016). Every value is the exact string stored in the
 * manifest, the database and the audit log; renaming a value changes the release hash, so add a new
 * member instead. The core only sees `string`: these types live in the module that owns the
 * declarations (apps/api/AGENTS.md). Versioned references (`employee.lead@1`) are built by the
 * declarations from the unversioned key here.
 */

export const HrResource = {
  Employee: 'employee',
  Team: 'team',
  Company: 'hrCompany',
  EmployeeIdentity: 'employeeIdentity',
  LeaveRate: 'leaveRate',
  WorkRequest: 'workRequest',
} as const;

export type HrResource = (typeof HrResource)[keyof typeof HrResource];

export const EmployeeAction = {
  Read: 'read',
  SubmitRequest: 'submitRequest',
  Update: 'update',
  AdjustLeaveRate: 'adjustLeaveRate',
  ReadLeaveBalance: 'readLeaveBalance',
  ReadAttendance: 'readAttendance',
  AdjustLeaveBalance: 'adjustLeaveBalance',
  AdjustAttendance: 'adjustAttendance',
  ReadAttendanceAdjustment: 'readAttendanceAdjustment',
  LinkAccount: 'linkAccount',
} as const;

export type EmployeeAction = (typeof EmployeeAction)[keyof typeof EmployeeAction];

export const TeamAction = {
  Read: 'read',
  Update: 'update',
  Assign: 'assign',
  Approvals: 'approvals',
} as const;

export type TeamAction = (typeof TeamAction)[keyof typeof TeamAction];

export const CompanyAction = {
  Read: 'read',
  CreateEmployee: 'createEmployee',
  CreateTeam: 'createTeam',
  Approvals: 'approvals',
  ManagePeriod: 'managePeriod',
} as const;

export type CompanyAction = (typeof CompanyAction)[keyof typeof CompanyAction];

export const EmployeeIdentityAction = { Read: 'read', Update: 'update' } as const;

export type EmployeeIdentityAction =
  (typeof EmployeeIdentityAction)[keyof typeof EmployeeIdentityAction];

export const LeaveRateAction = { Read: 'read' } as const;

export type LeaveRateAction = (typeof LeaveRateAction)[keyof typeof LeaveRateAction];

export const WorkRequestAction = {
  Read: 'read',
  DecideLead: 'decideLead',
  DecideFinal: 'decideFinal',
  ReadDecided: 'readDecided',
  ReadLeadRejected: 'readLeadRejected',
  Cancel: 'cancel',
  CancelApproved: 'cancelApproved',
} as const;

export type WorkRequestAction = (typeof WorkRequestAction)[keyof typeof WorkRequestAction];

/** Actions of each resource, so `hrPermission`/`grant` reject an action of another resource. */
export interface HrActionOf {
  readonly [HrResource.Employee]: EmployeeAction | ReportAction;
  readonly [HrResource.Team]: TeamAction;
  readonly [HrResource.Company]: CompanyAction;
  readonly [HrResource.EmployeeIdentity]: EmployeeIdentityAction;
  readonly [HrResource.LeaveRate]: LeaveRateAction;
  readonly [HrResource.WorkRequest]: WorkRequestAction;
}

/** The permission key `resource.action` (e.g. `employee.read`), typed per resource. */
export const hrPermission = <R extends HrResource>(
  resource: R,
  action: HrActionOf[R],
): `${R}.${HrActionOf[R]}` => `${resource}.${action}`;

export const HrPolicy = {
  Read: 'hrRead',
  Submit: 'hrSubmit',
  Write: 'hrWrite',
  /** Needs a fresh reauthentication (`fresh@1`). */
  Fresh: 'hrFresh',
  LeadStage: 'leadStage',
  FinalStage: 'finalStage',
  PendingStage: 'pendingStage',
  /** `approved` state and a fresh reauthentication. */
  ApprovedFresh: 'approvedFresh',
} as const;

export type HrPolicy = (typeof HrPolicy)[keyof typeof HrPolicy];

export const HrRole = {
  Employee: 'hr.employee',
  Coo: 'hr.coo',
  Admin: 'hr.admin',
} as const;

export type HrRole = (typeof HrRole)[keyof typeof HrRole];

/** Scope template keys (`version: 1`), each bound to one resource. */
export const HrTemplate = {
  SelfEmployee: 'selfEmployee',
  LedEmployees: 'ledEmployees',
  AllEmployees: 'allEmployees',
  MemberTeams: 'memberTeams',
  LedTeams: 'ledTeams',
  AllTeams: 'allTeams',
  OwnRequests: 'ownRequests',
  LedRequests: 'ledRequests',
  DecidedRequests: 'decidedRequests',
  FinalQueue: 'finalQueue',
  LeadRejectedLeadRequests: 'leadRejectedLeadRequests',
  AllRequests: 'allRequests',
  Company: 'company',
  SelfIdentity: 'selfIdentity',
  AllIdentities: 'allIdentities',
  SelfLeaveRates: 'selfLeaveRates',
  AllLeaveRates: 'allLeaveRates',
} as const;

export type HrTemplate = (typeof HrTemplate)[keyof typeof HrTemplate];

/** Relation keys without the `@version` suffix (`related()` in the declarations adds `@1`). */
export const HrRelation = {
  EmployeeLead: 'employee.lead',
  TeamMember: 'team.member',
  TeamLead: 'team.lead',
  RequestOwner: 'workRequest.owner',
  RequestLead: 'workRequest.lead',
  RequestDecider: 'workRequest.decider',
  RequestLeadRejectedLeadOwned: 'workRequest.leadRejectedLeadOwned',
  EmployeeIdentityOwner: 'employeeIdentity.owner',
  LeaveRateOwner: 'leaveRate.owner',
} as const;

export type HrRelation = (typeof HrRelation)[keyof typeof HrRelation];

/** Domain bindings: current-assignment views read by the relations (storage bindings). */
export const HrDomain = {
  EmployeeLead: 'hrEmployeeLead',
  TeamMember: 'hrTeamMember',
  TeamLead: 'hrTeamLead',
  RequestOwner: 'hrRequestOwner',
  RequestLead: 'hrRequestLead',
  RequestDecider: 'hrRequestDecider',
  RequestLeadRejected: 'hrRequestLeadRejected',
  EmployeeOwner: 'hrEmployeeOwner',
  LeaveRateOwner: 'hrLeaveRateOwner',
} as const;

export type HrDomain = (typeof HrDomain)[keyof typeof HrDomain];

export const HrBoundary = { Administration: 'hrAdministration' } as const;

export type HrBoundary = (typeof HrBoundary)[keyof typeof HrBoundary];
