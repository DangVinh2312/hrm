/**
 * Work calendar contracts (T4). The standard week is code; HR declares paid holidays per date
 * (from a verified source, never seeded by guess). Every change makes a new calendar version.
 */

/** Sets (`holiday` = its name) or clears (`null`, back to a standard workday) one weekday. */
export interface CalendarDayInput {
  readonly expectedVersion: string;
  /** Business date `YYYY-MM-DD`, Monday–Friday. */
  readonly date: string;
  readonly holiday: string | null;
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
}
