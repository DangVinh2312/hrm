/**
 * Standard working time (requirement §2, design §3, ADR 0018): Monday–Friday, shifts 09:00–13:00
 * and 14:00–18:00, lunch 13:00–14:00 not counted. Pure functions over a business date
 * `YYYY-MM-DD` and minutes of the day (0..1440, integers): no clock, no host timezone, no float.
 */

/** Effective calendar of one version: the dates HR declared as paid holidays. */
export interface WorkCalendarSnapshot {
  readonly paidHolidays: ReadonlySet<string>;
}

export type CalendarDayKind = 'workday' | 'weekend' | 'paid_holiday';

export interface WorkingTimeInput {
  readonly date: string;
  /** Interval [from, to) in minutes of the day. */
  readonly from: number;
  readonly to: number;
  readonly calendar: WorkCalendarSnapshot;
}

export interface LeaveSlotInput {
  readonly date: string;
  readonly start: number;
  readonly end: number;
  readonly calendar: WorkCalendarSnapshot;
}

export type WorkingTimeRejection =
  'invalid_date' | 'invalid_interval' | 'invalid_slot' | 'non_working_day';

export class WorkingTimeRejected extends Error {
  constructor(readonly reason: WorkingTimeRejection) {
    super(`Working time rejected: ${reason}`);
  }
}

const shifts = [
  [540, 780],
  [840, 1080],
] as const;

/** Design §3: 09–11, 11–13, 14–16, 16–18 (120); 09–13, 14–18 (240); 09–18 (480). */
const slots: ReadonlyMap<string, number> = new Map([
  ['540-660', 120],
  ['660-780', 120],
  ['840-960', 120],
  ['960-1080', 120],
  ['540-780', 240],
  ['840-1080', 240],
  ['540-1080', 480],
]);

/** Day of week 0 (Sunday)..6 of a valid business date, computed in UTC so no zone shifts it. */
function weekday(date: string): number {
  // The pattern fixes the grammar (ASCII digits, fixed width); the UTC round trip refuses
  // days that do not exist (2026-02-30) instead of rolling them over.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new WorkingTimeRejected('invalid_date');
  const [year, month, dayOfMonth] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    year < 1900 ||
    year > 2100 ||
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== dayOfMonth
  )
    throw new WorkingTimeRejected('invalid_date');
  return value.getUTCDay();
}

/** Weekend wins: a holiday on Saturday/Sunday changes nothing (the API refuses to store one). */
export function dayKind(date: string, calendar: WorkCalendarSnapshot): CalendarDayKind {
  const day = weekday(date);
  if (day === 0 || day === 6) return 'weekend';
  return calendar.paidHolidays.has(date) ? 'paid_holiday' : 'workday';
}

/** Working minutes of [from, to) on `date`: overlap with the two shifts on a workday, else 0. */
export function workingMinutes(input: WorkingTimeInput): number {
  const { from, to } = input;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 1440 || from >= to)
    throw new WorkingTimeRejected('invalid_interval');
  if (dayKind(input.date, input.calendar) !== 'workday') return 0;
  let total = 0;
  for (const [start, end] of shifts)
    total += Math.max(0, Math.min(to, end) - Math.max(from, start));
  return total;
}

/** Minutes of a leave slot (120/240/480); any other interval is refused even with equal length. */
export function leaveSlotMinutes(input: LeaveSlotInput): number {
  const kind = dayKind(input.date, input.calendar);
  const minutes = slots.get(`${input.start}-${input.end}`);
  if (minutes === undefined) throw new WorkingTimeRejected('invalid_slot');
  if (kind !== 'workday') throw new WorkingTimeRejected('non_working_day');
  return minutes;
}
