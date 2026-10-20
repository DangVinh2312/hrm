/**
 * Employee contracts (T3, design §5.1, ADR 0018). Inputs are already validated by the controller;
 * dates are business dates `YYYY-MM-DD`, versions int8 decimal strings, leave in integer minutes.
 * No input carries a role, revision, owner or account fact except the explicit account link.
 */

export type EmploymentStatus = 'probation' | 'official';

/** Status on the business date today (Asia/Ho_Chi_Minh), derived from periods and dates. */
export type EmploymentState = EmploymentStatus | 'notStarted' | 'terminated';

export type IdentityDocumentKind = 'cccd' | 'cmnd' | 'passport';

export type EmployeeGender = 'male' | 'female' | 'other';

/** F1 working relationship (ADR 0028); not a legal contract type. */
export type EmployeeClassification = 'fullTime' | 'contractor';

/**
 * F2 values; `null` clears a field. Never logged, audited or put into a URL. `phone` is canonical
 * national digits (`0` + 9..10 digits), `workEmail` canonical lowercase; neither is a login
 * identity (ADR 0028).
 */
export interface EmployeeIdentityInput {
  readonly dateOfBirth: string | null;
  readonly documentKind: IdentityDocumentKind | null;
  readonly documentNumber: string | null;
  readonly taxCode: string | null;
  readonly gender: EmployeeGender | null;
  readonly phone: string | null;
  readonly workEmail: string | null;
}

/** F1 profile fields shared by create and update; `null` = not recorded. */
export interface EmployeeProfileInput {
  readonly position: string | null;
  readonly classification: EmployeeClassification | null;
}

export interface EmployeeCreateInput extends EmployeeProfileInput {
  readonly code: string;
  readonly fullName: string;
  readonly hiredOn: string;
  readonly status: EmploymentStatus;
  /** F3 from `hiredOn`: ≥ 5760 (12 days, requirement §4.3). */
  readonly annualLeaveMinutes: number;
  readonly identity: EmployeeIdentityInput;
}

export interface EmployeeUpdateInput extends EmployeeProfileInput {
  readonly employeeId: string;
  readonly expectedVersion: string;
  readonly code: string;
  readonly fullName: string;
}

/** Probation → official from `effectiveOn` (the first official day). */
export interface EmployeeOfficialInput {
  readonly employeeId: string;
  readonly effectiveOn: string;
}

/** `terminatedOn` is the last working day (inclusive). */
export interface EmployeeTerminationInput {
  readonly employeeId: string;
  readonly terminatedOn: string;
}

export interface EmployeeIdentityUpdateInput {
  readonly employeeId: string;
  readonly expectedVersion: string;
  readonly identity: EmployeeIdentityInput;
}

export interface LeaveRateInput {
  readonly employeeId: string;
  readonly effectiveFrom: string;
  readonly annualMinutes: number;
}

/** Links the profile to an existing IAM account, or unlinks it with `null` (facts change). */
export interface AccountLinkInput {
  readonly employeeId: string;
  readonly expectedVersion: string;
  readonly accountId: string | null;
}

export interface EmployeeListQuery {
  readonly limit: number;
  readonly offset: number;
  /** Matches code or full name literally; 1..100 characters. */
  readonly search?: string;
}

export interface TeamRef {
  readonly id: string;
  readonly name: string;
}

export interface EmployeeSummary {
  readonly id: string;
  readonly code: string;
  readonly fullName: string;
  readonly state: EmploymentState;
  readonly primaryTeam: TeamRef | null;
}

export interface EmployeeListView {
  readonly items: readonly EmployeeSummary[];
  /** Matching rows in the same statement as `items`; bigint as string. */
  readonly total: string;
}

export interface EmploymentPeriodView {
  readonly status: EmploymentStatus;
  readonly startsOn: string;
  /** Exclusive end; `null` while open. */
  readonly endsOn: string | null;
}

export interface EmployeeMembershipView extends TeamRef {
  readonly primary: boolean;
  /** UTC instant the membership started. */
  readonly since: string;
}

/** F1 of one employee (design §5.1): no F2/F3 field. */
export interface EmployeeView extends EmployeeProfileInput {
  readonly id: string;
  readonly code: string;
  readonly fullName: string;
  readonly hiredOn: string;
  readonly terminatedOn: string | null;
  readonly state: EmploymentState;
  readonly version: string;
  readonly accountId: string | null;
  readonly periods: readonly EmploymentPeriodView[];
  readonly teams: readonly EmployeeMembershipView[];
}

export interface EmployeeIdentityView extends EmployeeIdentityInput {
  readonly employeeId: string;
  readonly version: string;
}

export interface LeaveRateView {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly annualMinutes: number;
}

/** Menu keys the server grants for display (design §10.2); only implemented pages are listed. */
export type HrMenu = 'requests' | 'approvals' | 'employees' | 'teams' | 'calendar' | 'leave';

/** `GET /api/hr/me` (design §10.2): no role key, revision or F2 value. */
export interface HrMeView {
  readonly userId: string;
  readonly employee: {
    readonly id: string;
    readonly code: string;
    readonly fullName: string;
  } | null;
  readonly menus: readonly HrMenu[];
  /**
   * The caller's plan reaches the company anchor (hrCompany.read): a display hint for HR
   * administration buttons only; every operation is still authorized by the API.
   */
  readonly companyScope: boolean;
}
