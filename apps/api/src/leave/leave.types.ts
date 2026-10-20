/** Minutes on a business date; a ledger net amount may be negative (a reversal, an adjustment). */
export interface DatedMinutes {
  readonly date: string;
  readonly minutes: number;
}

/** A pending annual-leave segment with the request that holds it. */
export interface PendingMinutes extends DatedMinutes {
  readonly requestId: string;
}

export interface LeaveBalanceQuery {
  readonly employeeId: string;
  /** Report date (business date); `null` = today in the business timezone, from the DB clock. */
  readonly asOn: string | null;
}

/**
 * Annual leave balance at a report date (D09), all in minutes of the report date's year:
 * entitled = accrued to the end of the report month (+ opening/adjustment entries up to it),
 * used = approved with a date up to the report date, approved ahead = later dates, pending =
 * waiting for a decision (never a ledger row), available = entitled − used − ahead − pending, ≥ 0.
 */
export interface LeaveBalanceView {
  readonly employeeId: string;
  readonly year: number;
  readonly asOn: string;
  /** Annual rate in force on the report date; `null` before the first rate (not reachable). */
  readonly annualMinutes: number | null;
  readonly entitledMinutes: number;
  readonly usedMinutes: number;
  readonly futureApprovedMinutes: number;
  readonly pendingMinutes: number;
  readonly availableMinutes: number;
}

export interface LeaveReconciliationQuery {
  /** `null` = the current year in the business timezone. */
  readonly year: number | null;
  readonly limit: number;
  readonly offset: number;
}

/**
 * A month in which approved + pending annual leave with a date up to the end of it exceeds what
 * was accrued to the end of it (spec §8). Information for HR only: nothing is cancelled or edited.
 */
export interface LeaveExcessView {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly month: number;
  readonly accruedMinutes: number;
  readonly approvedMinutes: number;
  readonly pendingMinutes: number;
  readonly excessMinutes: number;
  /** Pending requests with a segment up to that month, oldest first. */
  readonly requestIds: readonly string[];
}

export interface LeaveReconciliationView {
  readonly year: number;
  /** Employees in the caller's scope with pending annual leave in the year (a decimal string). */
  readonly total: string;
  readonly items: readonly LeaveExcessView[];
}

/** Input of the internal debit; the request row is already locked by the deciding transaction. */
export interface ApprovedLeaveEffect {
  readonly requestId: string;
}
