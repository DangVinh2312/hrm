import type { ReportAction } from '../report/report-authorization.types.js';

/**
 * Keys of the employee authorization fragment: employee, its F2 identity and
 * its F3 leave rates. Values are the exact stored strings (never rename); add a member instead.
 */

export const EmployeeResource = {
  Employee: 'employee',
  EmployeeIdentity: 'employeeIdentity',
  LeaveRate: 'leaveRate',
} as const;

export type EmployeeResource = (typeof EmployeeResource)[keyof typeof EmployeeResource];

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

export const EmployeeIdentityAction = { Read: 'read', Update: 'update' } as const;

export type EmployeeIdentityAction =
  (typeof EmployeeIdentityAction)[keyof typeof EmployeeIdentityAction];

export const LeaveRateAction = { Read: 'read' } as const;

export type LeaveRateAction = (typeof LeaveRateAction)[keyof typeof LeaveRateAction];

/** Actions of each resource, so a grant rejects an action of another resource. */
export interface EmployeeActionOf {
  readonly [EmployeeResource.Employee]: EmployeeAction | ReportAction;
  readonly [EmployeeResource.EmployeeIdentity]: EmployeeIdentityAction;
  readonly [EmployeeResource.LeaveRate]: LeaveRateAction;
}

/** Scope template keys (`version: 1`), each bound to one resource. */
export const EmployeeTemplate = {
  SelfEmployee: 'selfEmployee',
  LedEmployees: 'ledEmployees',
  AllEmployees: 'allEmployees',
  SelfIdentity: 'selfIdentity',
  AllIdentities: 'allIdentities',
  SelfLeaveRates: 'selfLeaveRates',
  AllLeaveRates: 'allLeaveRates',
} as const;

export type EmployeeTemplate = (typeof EmployeeTemplate)[keyof typeof EmployeeTemplate];

/** Relation keys without the `@version` suffix (`related()` adds `@1`). */
export const EmployeeRelation = {
  EmployeeLead: 'employee.lead',
  EmployeeIdentityOwner: 'employeeIdentity.owner',
  LeaveRateOwner: 'leaveRate.owner',
} as const;

export type EmployeeRelation = (typeof EmployeeRelation)[keyof typeof EmployeeRelation];

/** Domain bindings: current-assignment views read by the relations (storage bindings). */
export const EmployeeDomain = {
  EmployeeLead: 'hrEmployeeLead',
  EmployeeOwner: 'hrEmployeeOwner',
  LeaveRateOwner: 'hrLeaveRateOwner',
} as const;

export type EmployeeDomain = (typeof EmployeeDomain)[keyof typeof EmployeeDomain];
