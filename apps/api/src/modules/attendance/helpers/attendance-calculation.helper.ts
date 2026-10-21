/**
 * Monthly attendance sheet (design §9, D05): a pure function of the hire and leaving dates, the
 * calendar of one version and the approved effects of the month. Nothing is stored as a second
 * source and nothing reads a clock; the same facts always give the same numbers.
 * Integers only (minutes, counts), business dates `YYYY-MM-DD`.
 */
import { type WorkCalendarSnapshot, dayKind } from '../../work-calendar/working-time.helper.js';
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
  readonly calendar: WorkCalendarSnapshot;
  readonly effects: readonly AttendanceEffect[];
}

/**
 * Totals of one month in minutes (D05). `scheduledMinutes` are the working minutes of the
 * calendar inside the employment period; a paid holiday is paid time off of its own
 * (`paidHolidayMinutes`), not working time. `paidMinutes` = scheduled − unpaid + paid holidays:
 * annual leave, WFH and late/early never reduce it.
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
}

const DAY_MINUTES = 480;

/** Shifts 09:00–13:00 and 14:00–18:00; the lunch hour is not working time. */
const shifts = [
  [540, 780],
  [840, 1080],
] as const;

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
  // Days of the month inside employment, by kind: only workdays carry minutes.
  const kinds = new Map<string, 'work' | 'holiday'>();
  for (const date of monthDates(facts.month)) {
    if (date < facts.hiredOn || (facts.terminatedOn !== null && date > facts.terminatedOn))
      continue;
    const kind = dayKind(date, facts.calendar);
    if (kind === 'workday' || kind === 'makeup_workday') kinds.set(date, 'work');
    else if (kind === 'paid_holiday') kinds.set(date, 'holiday');
  }
  const work = [...kinds.values()].filter((k) => k === 'work').length;
  const holidays = kinds.size - work;

  // Fixed order, so the result never depends on how the rows came out of the database. Annual
  // leave sorts before unpaid leave, so a minute shared by both is attributed to annual leave.
  const effects = facts.effects
    .filter((e) => kinds.get(e.date) === 'work')
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
        for (const [from, to] of shifts)
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
  const scheduled = work * DAY_MINUTES;
  const paidHoliday = holidays * DAY_MINUTES;
  return {
    scheduledMinutes: scheduled,
    paidHolidayMinutes: paidHoliday,
    unpaidMinutes: unpaid,
    annualLeaveMinutes: annual,
    paidMinutes: scheduled - unpaid + paidHoliday,
    wfhDays: wfh.size,
    lateCount: late.count,
    lateMinutes: late.minutes,
    earlyCount: early.count,
    earlyMinutes: early.minutes,
  };
}
