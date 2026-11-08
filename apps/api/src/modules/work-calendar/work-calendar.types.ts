/**
 * Work calendar contracts (T4, ADR-19). The company schedule decides the workdays; HR declares
 * paid holidays per date (from a verified source, never seeded by guess) and makeup days on days
 * the schedule has off. Every change makes a new calendar version.
 */

/** Hours of a makeup day: those of `asWeekday`, from the company schedule or each employee's frame. */
export interface MakeupHours {
  readonly asWeekday: number;
  readonly frameSource: 'company' | 'employee';
}

/**
 * One day's change: `holiday` sets (its name) or clears (`null`) a paid holiday, on any day;
 * `makeup` makes a day the company schedule has off a workday with the hours of a weekday the
 * schedule works (an object) or a day off again (`null`).
 */
export type CalendarDayInput = {
  readonly expectedVersion: string;
  /** Business date `YYYY-MM-DD`. */
  readonly date: string;
} & ({ readonly holiday: string | null } | { readonly makeup: MakeupHours | null });

/**
 * A holiday range: every day of `from..to` (inclusive, from ≤ to, at most 31 calendar days, the
 * range may cross a year) the company schedule works becomes a paid holiday named `name`; days
 * off inside it are skipped.
 */
export interface CalendarHolidaysInput {
  readonly expectedVersion: string;
  readonly from: string;
  readonly to: string;
  readonly name: string;
}

export interface CalendarHoliday {
  readonly date: string;
  readonly name: string;
}

/** The calendar of one year at the current version. */
export interface CalendarYearView {
  /** int8 as decimal string; `1` is the standard week without any holiday. */
  readonly version: string;
  readonly year: number;
  /** Ordered by date, at most one per day (≤ 261 weekdays a year). */
  readonly holidays: readonly CalendarHoliday[];
  /** Days off worked as makeup days, ordered by date (≤ 366 a year). */
  readonly makeupDays: readonly (MakeupHours & { readonly date: string })[];
}
