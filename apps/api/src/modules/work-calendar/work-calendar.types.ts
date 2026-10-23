/**
 * Work calendar contracts (T4). The standard week is code; HR declares paid holidays per date
 * (from a verified source, never seeded by guess) and Saturdays/Sundays worked as makeup days.
 * Every change makes a new calendar version.
 */

/**
 * One day's change. Monday–Friday: `holiday` sets (its name) or clears (`null`) a paid holiday.
 * Saturday/Sunday: `makeup` makes it a full workday (`true`) or a weekly rest again (`false`).
 */
export type CalendarDayInput = {
  readonly expectedVersion: string;
  /** Business date `YYYY-MM-DD`. */
  readonly date: string;
} & ({ readonly holiday: string | null } | { readonly makeup: boolean });

/**
 * A holiday range (ADR 0042): every Monday–Friday of `from..to` (inclusive, from ≤ to, at most 31
 * calendar days, the range may cross a year) becomes a paid holiday named `name`; Saturdays and
 * Sundays inside it are skipped.
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
  /** Saturdays/Sundays worked as full days, `YYYY-MM-DD` ordered (≤ 106 a year). */
  readonly makeupDays: readonly string[];
}
