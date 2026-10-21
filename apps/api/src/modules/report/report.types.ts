import type { AttendanceTotals } from '../attendance/helpers/attendance-calculation.helper.js';
import type { LeaveBalanceView } from '../leave/leave.types.js';

/** Page budget of every report (design §11): default 20, max 100, offset ≤ 10000. */
export interface ReportPage {
  readonly limit: number;
  readonly offset: number;
}

/** Inclusive months `YYYY-MM`, from ≤ to, at most 12 months (design §11: ≤ 366 days) [P]. */
export interface ReportMonths {
  readonly from: string;
  readonly to: string;
}

/** Cutoff business date `YYYY-MM-DD`, always explicit (never "today" implicitly). */
export interface ReportCutoff {
  readonly asOn: string;
}

export interface MonthlyQuery<K extends string> extends ReportMonths, ReportPage {
  readonly kind: K;
}

export interface CutoffQuery<K extends string> extends ReportCutoff, ReportPage {
  readonly kind: K;
}

/**
 * The validated input of a report (T9 part A). Birthday is not a member yet: its 29/02 display and
 * the year shown to the COO are open decisions (design §12.0, acceptance R-02).
 */
export type ReportQuery =
  | MonthlyQuery<'attendance'>
  | MonthlyQuery<'late-early'>
  | MonthlyQuery<'wfh'>
  | CutoffQuery<'leave'>
  | CutoffQuery<'seniority'>;

export type ReportKind = ReportQuery['kind'];

export type ReportQueryOf<K extends ReportKind> = Extract<ReportQuery, { readonly kind: K }>;

export interface ReportEmployee {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
}

/** `closed` months are served from the stored snapshot (D07), `open` ones from live data. */
export type ReportPeriodState = 'open' | 'closed';

/** One employee in one month: the attendance sheet (D05), minutes and counts. */
export interface AttendanceReportRow extends ReportEmployee, AttendanceTotals {
  readonly month: string;
  readonly periodState: ReportPeriodState;
}

/** Approved late arrivals and early departures of one employee in one month (recorded only, D05). */
export interface LateEarlyReportRow extends ReportEmployee {
  readonly month: string;
  readonly periodState: ReportPeriodState;
  readonly lateCount: number;
  readonly lateMinutes: number;
  readonly earlyCount: number;
  readonly earlyMinutes: number;
}

/** Approved WFH days dated in `month` (the WFH day's month, never the approval's, D04). */
export interface WfhReportRow extends ReportEmployee {
  readonly month: string;
  readonly periodState: ReportPeriodState;
  readonly wfhDays: number;
  /** More than the 4 days a month the approver must acknowledge (D04). */
  readonly overLimit: boolean;
}

/** The D09 balance of one employee at the cutoff date, same numbers as the balance endpoint. */
export interface LeaveReportRow extends ReportEmployee, Omit<LeaveBalanceView, 'employeeId'> {}

/** Length of service from the employment history at the cutoff (hire day and cutoff both count) [P]. */
export interface SeniorityReportRow extends ReportEmployee {
  readonly hiredOn: string;
  readonly asOn: string;
  readonly years: number;
  readonly months: number;
  readonly days: number;
  readonly totalDays: number;
}

/** A page of one report: `total` counts the rows the caller's scope allows (decimal string). */
export interface ReportPageResult<K extends ReportKind, R> {
  readonly kind: K;
  readonly total: string;
  readonly rows: readonly R[];
}

export type AttendanceReport = ReportPageResult<'attendance', AttendanceReportRow>;

export type LateEarlyReport = ReportPageResult<'late-early', LateEarlyReportRow>;

export type WfhReport = ReportPageResult<'wfh', WfhReportRow>;

export type LeaveReport = ReportPageResult<'leave', LeaveReportRow>;

export type SeniorityReport = ReportPageResult<'seniority', SeniorityReportRow>;

export type ReportResult =
  AttendanceReport | LateEarlyReport | WfhReport | LeaveReport | SeniorityReport;
