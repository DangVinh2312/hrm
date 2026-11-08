import type { Frame, ScheduleDayKind } from './helpers/work-schedule.helper.js';

/** Seven frames, Monday first; an empty frame is a day off (company) or "the company's hours" (employee). */
export type WeekFrames = readonly Frame[];

/** `PUT /api/hr/work-calendar/schedule/:effectiveFrom`: a version from a date after today. */
export interface CompanyScheduleInput {
  readonly effectiveFrom: string;
  readonly days: WeekFrames;
}

export interface CompanyScheduleVersionView {
  readonly effectiveFrom: string;
  readonly days: WeekFrames;
}

/** The version in force today and every later one; `today` is the DB business date. */
export interface CompanyScheduleView {
  readonly today: string;
  readonly maxMinutes: number;
  readonly versions: readonly CompanyScheduleVersionView[];
}

/** `POST /api/hr/employees/:id/schedule-frames`: own hours from `validFrom` (after today). */
export interface EmployeeFrameInput {
  readonly employeeId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly days: WeekFrames;
}

export interface EmployeeFrameKey {
  readonly employeeId: string;
  readonly frameId: string;
}

export interface EmployeeFrameView {
  readonly id: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly days: WeekFrames;
}

/** Frames that end today or later; `today` is the DB business date. */
export interface EmployeeFramesView {
  readonly today: string;
  readonly maxMinutes: number;
  readonly frames: readonly EmployeeFrameView[];
}

export interface EmployeeScheduleQuery {
  readonly employeeId: string;
  readonly from: string;
  readonly to: string;
}

/** The hours of each day of the range as requests and attendance see them now. */
export interface EmployeeScheduleView {
  readonly employeeId: string;
  readonly days: readonly {
    readonly date: string;
    readonly kind: ScheduleDayKind;
    readonly shifts: Frame;
  }[];
}
