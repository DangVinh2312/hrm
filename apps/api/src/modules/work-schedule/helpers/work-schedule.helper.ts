/**
 * Working hours of one person on one business date (ADR-19): the company schedule version in
 * force picks the workdays and their shifts, an employee frame may change the hours of those
 * workdays, makeup days and paid holidays are declared for everyone. Pure functions over business
 * dates `YYYY-MM-DD` and minutes of the day: no clock, no host timezone, no float.
 */
import { WorkingTimeRejected, isoWeekday } from '../../work-calendar/working-time.helper.js';

/** `[start, end)` in minutes of the day. */
export type Shift = readonly [start: number, end: number];

/** 0–3 shifts in increasing order; an empty frame is a day off. */
export type Frame = readonly Shift[];

export interface ScheduleVersion {
  readonly effectiveFrom: string;
  /** Seven frames, Monday first (index = ISO weekday − 1). */
  readonly days: readonly Frame[];
}

export interface EmployeeFrames {
  readonly validFrom: string;
  /** Inclusive; `null` has no end. */
  readonly validTo: string | null;
  /** By ISO weekday; a weekday not listed follows the company schedule. */
  readonly days: ReadonlyMap<number, Frame>;
}

export interface MakeupDay {
  /** ISO weekday whose hours the makeup day takes. */
  readonly asWeekday: number;
  readonly frameSource: 'company' | 'employee';
}

export interface ScheduleFacts {
  /** Sorted by `effectiveFrom`; the first one starts on or before every date asked. */
  readonly versions: readonly ScheduleVersion[];
  /** Frames of the one employee asked about, never overlapping; empty for the company alone. */
  readonly overrides: readonly EmployeeFrames[];
  readonly paidHolidays: ReadonlySet<string>;
  readonly makeupDays: ReadonlyMap<string, MakeupDay>;
}

export type ScheduleDayKind = 'workday' | 'off' | 'paid_holiday' | 'makeup_workday';

export interface DaySchedule {
  readonly kind: ScheduleDayKind;
  /** Empty exactly when `kind` is `off`. */
  readonly frame: Frame;
}

export const MAX_SHIFTS = 3;

export const SHIFT_STEP_MINUTES = 5;

const off: DaySchedule = { kind: 'off', frame: [] };

function companyOn(date: string, versions: readonly ScheduleVersion[]): ScheduleVersion {
  let found: ScheduleVersion | undefined;
  for (const version of versions) if (version.effectiveFrom <= date) found = version;
  // Facts that miss the version of a date would silently make it a day off.
  if (!found) throw new RangeError('No schedule version covers the date');
  return found;
}

const frameOf = (version: ScheduleVersion, weekday: number): Frame =>
  version.days[weekday - 1] ?? [];

/** The company frame of ISO `weekday` in the version in force on `date`; empty is a day off. */
export const companyFrameOn = (
  date: string,
  weekday: number,
  versions: readonly ScheduleVersion[],
): Frame => frameOf(companyOn(date, versions), weekday);

/** The schedule of `date` for the employee whose frames are in `facts` (ADR-19 `frameOn`). */
export function frameOn(date: string, facts: ScheduleFacts): DaySchedule {
  const weekday = isoWeekday(date);
  const company = companyOn(date, facts.versions);
  const own = facts.overrides.find(
    (o) => o.validFrom <= date && (o.validTo === null || date <= o.validTo),
  );
  const makeup = facts.makeupDays.get(date);
  if (makeup) {
    const base = frameOf(company, makeup.asWeekday);
    const frame =
      makeup.frameSource === 'employee' && base.length > 0
        ? (own?.days.get(makeup.asWeekday) ?? base)
        : base;
    return frame.length > 0 ? { kind: 'makeup_workday', frame } : off;
  }
  const base = frameOf(company, weekday);
  if (base.length === 0) return off;
  const frame = own?.days.get(weekday) ?? base;
  return { kind: facts.paidHolidays.has(date) ? 'paid_holiday' : 'workday', frame };
}

export const frameMinutes = (frame: Frame): number =>
  frame.reduce((total, [start, end]) => total + end - start, 0);

/** Minutes of `[from, to)` inside the frame. */
export const overlapMinutes = (frame: Frame, from: number, to: number): number =>
  frame.reduce(
    (total, [start, end]) => total + Math.max(0, Math.min(to, end) - Math.max(from, start)),
    0,
  );

/**
 * A storable frame: at most {@link MAX_SHIFTS} shifts on the 5-minute grid inside one day, each
 * non-empty, increasing with a gap between two shifts (touching ones would be one shift), totalling at
 * most `maxMinutes` (setting `hr.workdayMaxMinutes`, only checked when a frame is written).
 */
export function isValidFrame(frame: Frame, maxMinutes: number): boolean {
  if (frame.length > MAX_SHIFTS) return false;
  let previousEnd = -1;
  for (const [start, end] of frame) {
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start % SHIFT_STEP_MINUTES !== 0 ||
      end % SHIFT_STEP_MINUTES !== 0 ||
      start <= previousEnd ||
      start >= end ||
      end > 1440
    )
      return false;
    previousEnd = end;
  }
  return frameMinutes(frame) <= maxMinutes;
}

/** A leave edge is a shift edge or a whole hour inside a shift. */
const isLeaveEdge = (frame: Frame, minute: number) =>
  frame.some(
    ([start, end]) =>
      minute === start || minute === end || (minute % 60 === 0 && start < minute && minute < end),
  );

/**
 * Minutes of leave `[start, end)` on a day: its working minutes, refused when either edge is not a
 * leave edge or nothing is worked. Leave on a makeup day stays refused with its own reason.
 */
export function leaveMinutes(day: DaySchedule, start: number, end: number): number {
  if (day.kind === 'makeup_workday') throw new WorkingTimeRejected('makeup_day');
  if (day.kind !== 'workday') throw new WorkingTimeRejected('non_working_day');
  if (!(start < end) || !isLeaveEdge(day.frame, start) || !isLeaveEdge(day.frame, end))
    throw new WorkingTimeRejected('invalid_slot');
  const minutes = overlapMinutes(day.frame, start, end);
  if (minutes === 0) throw new WorkingTimeRejected('invalid_slot');
  return minutes;
}

/**
 * The booked part of a late arrival at `expected`: from the start of the shift the person arrives
 * in. Arriving at a shift's end is late for that whole shift, except for the last shift, where it
 * would be no work at all. `undefined` when `expected` is in no shift.
 */
export function lateSegment(frame: Frame, expected: number): Shift | undefined {
  const last = frame[frame.length - 1];
  if (!last || expected >= last[1]) return undefined;
  const shift = frame.find(([start, end]) => start < expected && expected <= end);
  return shift && [shift[0], expected];
}

/** The booked part of an early departure at `expected`: up to the end of its shift. */
export function earlySegment(frame: Frame, expected: number): Shift | undefined {
  const shift = frame.find(([start, end]) => start < expected && expected < end);
  return shift && [expected, shift[1]];
}

/** A WFH day covers the whole frame: from the first shift's start to the last shift's end. */
export function wfhSegment(
  frame: Frame,
): { readonly start: number; readonly end: number; readonly minutes: number } | undefined {
  const first = frame[0];
  const last = frame[frame.length - 1];
  if (!first || !last) return undefined;
  return { start: first[0], end: last[1], minutes: frameMinutes(frame) };
}
