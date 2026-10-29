/**
 * Keys of the shared authorization fragment: the three roles, the policies
 * used by more than one module, the company anchor resource and the administration boundary.
 * Every value is the exact string stored in the manifest, the database and the audit log;
 * renaming a value changes the release hash, so add a new member instead. The core only sees
 * `string`: these types live in the module that owns the declarations (apps/api/AGENTS.md).
 */

export const PermissionRole = {
  Employee: 'hr.employee',
  Coo: 'hr.coo',
  Admin: 'hr.admin',
} as const;

export type PermissionRole = (typeof PermissionRole)[keyof typeof PermissionRole];

export const PermissionPolicy = {
  Read: 'hrRead',
  Submit: 'hrSubmit',
  Write: 'hrWrite',
  /** Needs a fresh reauthentication (`fresh@1`). */
  Fresh: 'hrFresh',
} as const;

export type PermissionPolicy = (typeof PermissionPolicy)[keyof typeof PermissionPolicy];

export const PermissionBoundary = { Administration: 'hrAdministration' } as const;

export type PermissionBoundary = (typeof PermissionBoundary)[keyof typeof PermissionBoundary];

/** Singleton parent of company-level creates and approvals menus, shared by several modules. */
export const CompanyResource = { Company: 'hrCompany' } as const;

export type CompanyResource = (typeof CompanyResource)[keyof typeof CompanyResource];

export const CompanyAction = {
  Read: 'read',
  CreateEmployee: 'createEmployee',
  CreateTeam: 'createTeam',
  Approvals: 'approvals',
  ManagePeriod: 'managePeriod',
} as const;

export type CompanyAction = (typeof CompanyAction)[keyof typeof CompanyAction];

export const CompanyTemplate = { Company: 'company' } as const;

export type CompanyTemplate = (typeof CompanyTemplate)[keyof typeof CompanyTemplate];
