import {
  type AttendanceEffect,
  type AttendanceTotals,
  attendanceTotals,
} from './attendance-calculation.helper.js';
import type { AttendancePeriodState } from '../attendance.types.js';

export const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

/** First day of the month of a `YYYY-MM-DD` / `YYYY-MM` string. */
export const firstOfMonth = (value: string) => `${value.slice(0, 7)}-01`;

/** The distinct months (first days, ascending) of business dates. */
export const monthsOf = (dates: readonly string[]) => [...new Set(dates.map(firstOfMonth))].sort();

/**
 * Everything the sheet of a month depends on, for the employees asked for (or, with `ids` =
 * `null`, every employee whose employment overlaps the month), from ONE statement: a single
 * snapshot, so the calendar version, the approved segments and the period state it reports are
 * consistent and recomputing with unchanged inputs returns the same numbers (F-08).
 */
export interface AttendanceFactsRow {
  readonly id: string;
  readonly hiredOn: string;
  readonly terminatedOn: string | null;
  readonly calendarVersion: string;
  readonly periodState: AttendancePeriodState | null;
  readonly holidays: string[];
  readonly makeupDays: string[];
  readonly effects: AttendanceEffect[];
  readonly adjustmentMinutes: number;
}

/** Half-open date range [`first`, `next`) (SQL expressions of the statement's parameters) that covers every month of a set-based read's `source`. */
export interface MonthsWindow {
  readonly first: string;
  readonly next: string;
}

/**
 * From this many employees (rows) a read uses the set-based {@link approvedEffectsBySql}; below it
 * the per-row {@link approvedEffectsSql}. Measured on 5000 employees with a year of history (ADR
 * 0018 bổ sung 2026-10-22): points at 100/200/500 rows, on a loaded machine and with JIT on, so
 * the differences at 500 rows and for a close are not separated from load/JIT noise, and a page of
 * 700 at offset 1500 did not win. 300 is a cautious choice between those points, not a proven
 * optimum; small pages keep the per-row statement, which is the pre-existing one.
 */
export const EFFECTS_SET_BASED_MIN_ROWS = 300;

/** One group of {@link approvedEffectsBySql}: the effects of an employee in a month. */
export interface EffectsGroup {
  readonly employeeId: string;
  readonly month: string;
  readonly effects: AttendanceEffect[];
}

/**
 * JSON array (SQL fragment) of the approved segments of ONE employee `employee` dated in
 * [`first`, `next`): the per-row form of the effects reader, probing the indexes of that employee
 * (used below {@link EFFECTS_SET_BASED_MIN_ROWS}). {@link approvedEffectsBySql} returns the same
 * arrays for many employees at once (equivalence spec `hrm-attendance-effects-equivalence`).
 */
export const approvedEffectsSql = (employee: string, first: string, next: string) =>
  `COALESCE((SELECT json_agg(json_build_object('kind', s.kind, 'date', ${date('s.work_date')},
                        'startMinute', s.start_minute, 'endMinute', s.end_minute)
                        ORDER BY s.work_date, s.kind, s.start_minute, s.end_minute)
                       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id
                      WHERE r.employee_id = ${employee} AND r.state = 'approved'
                        AND s.work_date >= ${first} AND s.work_date < ${next}), '[]'::json)`;

/**
 * Set-based reader of attendance effects (SQL, the body of a CTE with columns `id`, `first`,
 * `effects`): for the employees of `source` (a relation with a column `id`; the caller has already
 * narrowed it to the caller's scope and page) the JSON array of the `approved` requests' segments
 * of each month of `window`, ordered by date, kind, start, end. An effect of a request is the
 * `approved` request itself, so this is the single reader of attendance effects (the sheet of a
 * month, the close and the reports). One pass replaces a subquery per row; employee-months
 * without an effect have no group (readers use `[]`).
 *
 * The employees reach the scan as one array filter (`employee_id = ANY(array)`), never as a join
 * with `source`: the planner's row estimate for a CTE is a guess, and a join on it was measured
 * to pick a nested loop over a 5000-row inner (3 s) or a scan of all of `work_request` (a page of
 * 200 read 150 000 requests). A filter cannot be mis-joined, so the work stays bounded by the
 * employees in `source` and the months of `window` (the date range is the statement's own
 * parameters, not a subquery, so it is estimated from the column statistics). The groups of an
 * employee's other months of `window` are in-scope data the reader never looks up.
 */
export const approvedEffectsBySql = (source: string, window: MonthsWindow) =>
  `SELECT r.employee_id AS id, CAST(date_trunc('month', CAST(s.work_date AS timestamp)) AS date) AS first,
          json_agg(json_build_object('kind', s.kind, 'date', ${date('s.work_date')},
                        'startMinute', s.start_minute, 'endMinute', s.end_minute)
                        ORDER BY s.work_date, s.kind, s.start_minute, s.end_minute) AS effects
     FROM work_request r
     JOIN work_request_segment s ON s.request_id = r.id
    WHERE r.employee_id = ANY(CAST((SELECT array_agg(k.id) FROM ${source} k) AS uuid[])) AND r.state = 'approved'
      AND s.work_date >= ${window.first} AND s.work_date < ${window.next}
    GROUP BY r.employee_id, CAST(date_trunc('month', CAST(s.work_date AS timestamp)) AS date)`;

/** JSON array (SQL fragment) of the groups of a CTE built with {@link approvedEffectsBySql}. */
export const effectsGroupsSql = (groups: string) =>
  `COALESCE((SELECT json_agg(json_build_object('employeeId', g.id::text, 'month', to_char(g.first, 'YYYY-MM'),
                        'effects', g.effects)) FROM ${groups} g), '[]'::json)`;

/** Index of {@link EffectsGroup}s by employee and month; a missing key is no effect. */
export function effectsIndex(
  groups: readonly EffectsGroup[],
): (employeeId: string, month: string) => AttendanceEffect[] {
  const byKey = new Map(groups.map((g) => [`${g.employeeId}|${g.month}`, g.effects]));
  return (employeeId, month) => byKey.get(`${employeeId}|${month}`) ?? [];
}

/**
 * Signed sum (SQL fragment, an `int`) of the `attendance.adjust` rows of employee `employee` dated
 * in [`first`, `next`): the one reader of adjustments for the sheet, the snapshot of a close, the
 * reports and the adjustments list, so none of them can disagree. An index probe per row on
 * `(employee_id, work_date)`: measured at 5000 rows it is about 40 ms of the statement, so it is
 * not worth a second set-based plan. An int overflow would fail the statement, not wrap.
 */
export const adjustmentMinutesSql = (employee: string, first: string, next: string) =>
  `COALESCE((SELECT SUM(a.minutes) FROM attendance_adjustment a
              WHERE a.employee_id = ${employee} AND a.work_date >= ${first} AND a.work_date < ${next}), 0)::int`;

/**
 * JSON array (SQL fragment) of the calendar days of `kind` in [`first`, `next`), read from a CTE
 * `days(day, kind)` of the statement (the latest change of each day up to the calendar version).
 */
export const calendarDaysSql = (
  kind: 'paid_holiday' | 'makeup_workday',
  first: string,
  next: string,
) =>
  `COALESCE((SELECT json_agg(${date('d.day')} ORDER BY d.day) FROM days d
              WHERE d.kind = '${kind}' AND d.day >= ${first} AND d.day < ${next}), '[]'::json)`;

export const totalsOf = (month: string, row: AttendanceFactsRow): AttendanceTotals =>
  attendanceTotals({
    month,
    hiredOn: row.hiredOn,
    terminatedOn: row.terminatedOn,
    calendar: { paidHolidays: new Set(row.holidays), makeupDays: new Set(row.makeupDays) },
    effects: row.effects,
    adjustmentMinutes: row.adjustmentMinutes,
  });
