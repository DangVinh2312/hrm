/**
 * Business dates `YYYY-MM-DD` (design §3): the weekday of a date and the dates of a range. Pure
 * functions: no clock, no host timezone.
 */

export type WorkingTimeRejection =
  'invalid_date' | 'invalid_slot' | 'non_working_day' | 'makeup_day';

export class WorkingTimeRejected extends Error {
  constructor(readonly reason: WorkingTimeRejection) {
    super(`Working time rejected: ${reason}`);
  }
}

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

/** ISO weekday 1 (Monday)..7 (Sunday) of a business date; refuses invalid dates. */
export const isoWeekday = (date: string): number => weekday(date) || 7;

/** Longest holiday range of one request, in calendar days (both ends included). */
export const MAX_HOLIDAY_RANGE_DAYS = 31;

/**
 * Every date of `from..to` in order (inclusive). Empty when `from > to`, or when the range is
 * longer than `maxDays` (the caller refuses both). Inputs are valid business dates (`inputDate`).
 */
export function datesBetween(from: string, to: string, maxDays = MAX_HOLIDAY_RANGE_DAYS): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!(end >= start) || (end - start) / 86_400_000 >= maxDays) return dates;
  for (let time = start; time <= end; time += 86_400_000)
    dates.push(new Date(time).toISOString().slice(0, 10));
  return dates;
}
