/**
 * Monthly attendance sheet (design §9, D05): a pure function of the hire and leaving dates, the
 * employee's schedule of the month (ADR-19), the approved effects of the month and the sum of HR's audited
 * adjustments of the month (`attendance.adjust`). Nothing is stored as a second source and
 * nothing reads a clock; the same facts always give the same numbers.
 * Integers only (minutes, counts), business dates `YYYY-MM-DD`.
 */
import {
  type Frame,
  type ScheduleFacts,
  frameMinutes,
  frameOn,
} from '../../work-schedule/helpers/work-schedule.helper.js';
import type { RequestKind } from '../../work-request/work-request.types.js';

/** One segment of an approved request, as stored (the request row is the single source). */
export interface AttendanceEffect {
  readonly kind: RequestKind;
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface AttendanceFacts {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly hiredOn: string;
  /** Last working day, inclusive; `null` while employed. */
  readonly terminatedOn: string | null;
  readonly schedule: ScheduleFacts;
  readonly effects: readonly AttendanceEffect[];
  /**
   * Sum of the signed paid-minute adjustments dated in the month (the rows of
   * `attendance_adjustment`; the writer keeps `paidMinutes` >= 0 when it adds one). An integer.
   */
  readonly adjustmentMinutes: number;
}

/**
 * Totals of one month in minutes (D05). `scheduledMinutes` are the minutes of the employee's frame
 * of each working day inside the employment period; a paid holiday is paid time off of its own
 * (`paidHolidayMinutes`, the frame the person would have worked), not working time. `paidMinutes` = scheduled − unpaid + paid holidays +
 * adjustments: annual leave, WFH and late/early never reduce it. The adjustments are reported on
 * their own too, so a reader can tell the calendar's number from HR's correction.
 */
export interface AttendanceTotals {
  readonly scheduledMinutes: number;
  readonly paidHolidayMinutes: number;
  readonly unpaidMinutes: number;
  readonly annualLeaveMinutes: number;
  readonly paidMinutes: number;
  readonly wfhDays: number;
  readonly lateCount: number;
  readonly lateMinutes: number;
  readonly earlyCount: number;
  readonly earlyMinutes: number;
  /** Signed sum of HR's adjustments of the month; already included in `paidMinutes`. */
  readonly adjustmentMinutes: number;
}

/** Every date of `YYYY-MM`, in order; anything else is a programming error (the parsers check input). */
export function monthDates(month: string): string[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const year = Number(match?.[1]);
  const index = Number(match?.[2]);
  if (!match || year < 1900 || year > 2100 || index < 1 || index > 12)
    throw new RangeError('Invalid month');
  // Day 0 of the next month is the last day of this one (UTC, so no zone shifts it).
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export function attendanceTotals(facts: AttendanceFacts): AttendanceTotals {
  // Frames of the working days of the month inside employment; only they carry minutes.
  const work = new Map<string, Frame>();
  let scheduled = 0;
  let paidHoliday = 0;
  for (const date of monthDates(facts.month)) {
    if (date < facts.hiredOn || (facts.terminatedOn !== null && date > facts.terminatedOn))
      continue;
    const { kind, frame } = frameOn(date, facts.schedule);
    if (kind === 'workday' || kind === 'makeup_workday') {
      work.set(date, frame);
      scheduled += frameMinutes(frame);
    } else if (kind === 'paid_holiday') paidHoliday += frameMinutes(frame);
  }

  // Fixed order, so the result never depends on how the rows came out of the database. Annual
  // leave sorts before unpaid leave, so a minute shared by both is attributed to annual leave.
  const effects = facts.effects
    .filter((e) => work.has(e.date))
    .toSorted(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.kind.localeCompare(b.kind) ||
        a.startMinute - b.startMinute ||
        a.endMinute - b.endMinute,
    );
  const covered = new Map<string, Uint8Array>();
  let unpaid = 0;
  let annual = 0;
  const wfh = new Set<string>();
  const late = { count: 0, minutes: 0 };
  const early = { count: 0, minutes: 0 };
  const lateDays = new Set<string>();
  const earlyDays = new Set<string>();
  for (const e of effects) {
    switch (e.kind) {
      case 'unpaid-leave':
      case 'annual-leave': {
        // Each working minute of a day belongs to at most one leave interval.
        let day = covered.get(e.date);
        if (!day) covered.set(e.date, (day = new Uint8Array(1440)));
        let minutes = 0;
        for (const [from, to] of work.get(e.date) ?? [])
          for (let m = Math.max(from, e.startMinute); m < Math.min(to, e.endMinute); m++)
            if (!day[m]) {
              day[m] = 1;
              minutes++;
            }
        if (e.kind === 'unpaid-leave') unpaid += minutes;
        else annual += minutes;
        break;
      }
      case 'wfh':
        wfh.add(e.date);
        break;
      case 'late-arrival':
        if (!lateDays.has(e.date)) late.count++;
        lateDays.add(e.date);
        late.minutes += e.endMinute - e.startMinute;
        break;
      case 'early-departure':
        if (!earlyDays.has(e.date)) early.count++;
        earlyDays.add(e.date);
        early.minutes += e.endMinute - e.startMinute;
        break;
    }
  }
  return {
    scheduledMinutes: scheduled,
    paidHolidayMinutes: paidHoliday,
    unpaidMinutes: unpaid,
    annualLeaveMinutes: annual,
    paidMinutes: scheduled - unpaid + paidHoliday + facts.adjustmentMinutes,
    wfhDays: wfh.size,
    lateCount: late.count,
    lateMinutes: late.minutes,
    earlyCount: early.count,
    earlyMinutes: early.minutes,
    adjustmentMinutes: facts.adjustmentMinutes,
  };
}
