import type { EntityManager } from 'typeorm';
import { WORK_CALENDAR_ID } from '../../hr/helpers/hr-database.helper.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import {
  type AttendanceEffect,
  type AttendanceTotals,
  attendanceTotals,
} from '../helpers/attendance-calculation.helper.js';
import type { AttendancePeriodState } from '../attendance.types.js';

/** D04: the fifth WFH day of a month and every later one needs the approver's acknowledgement. */
export const WFH_MONTH_LIMIT = 4;

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
}

export async function loadAttendanceFacts(
  manager: EntityManager,
  month: string,
  ids: readonly string[] | null,
): Promise<AttendanceFactsRow[]> {
  return manager.query<AttendanceFactsRow[]>(
    `WITH m AS (SELECT CAST($1 || '-01' AS date) AS first, CAST(CAST($1 || '-01' AS date) + interval '1 month' AS date) AS next),
          cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST($3 AS uuid)),
          days AS (SELECT DISTINCT ON (x.day) x.day, x.kind FROM work_calendar_change x, m, cal
                    WHERE x.day >= m.first AND x.day < m.next AND x.version <= cal.version
                    ORDER BY x.day, x.version DESC)
     SELECT e.id::text AS id, ${date('e.hired_on')} AS "hiredOn", ${date('e.terminated_on')} AS "terminatedOn",
            (SELECT version::text FROM cal) AS "calendarVersion",
            (SELECT p.state FROM attendance_period p, m WHERE p.month = m.first) AS "periodState",
            COALESCE((SELECT json_agg(${date('d.day')} ORDER BY d.day) FROM days d WHERE d.kind = 'paid_holiday'), '[]'::json) AS holidays,
            COALESCE((SELECT json_agg(${date('d.day')} ORDER BY d.day) FROM days d WHERE d.kind = 'makeup_workday'), '[]'::json) AS "makeupDays",
            COALESCE((SELECT json_agg(json_build_object('kind', s.kind, 'date', ${date('s.work_date')},
                        'startMinute', s.start_minute, 'endMinute', s.end_minute)
                        ORDER BY s.work_date, s.kind, s.start_minute, s.end_minute)
                       FROM work_request r JOIN work_request_segment s ON s.request_id = r.id, m
                      WHERE r.employee_id = e.id AND r.state = 'approved'
                        AND s.work_date >= m.first AND s.work_date < m.next), '[]'::json) AS effects
       FROM employee e, m
      WHERE CASE WHEN CAST($2 AS uuid[]) IS NULL
                 THEN e.hired_on < m.next AND (e.terminated_on IS NULL OR e.terminated_on >= m.first)
                 ELSE e.id = ANY(CAST($2 AS uuid[])) END
      ORDER BY e.id`,
    [month, ids === null ? null : [...ids], WORK_CALENDAR_ID],
  );
}

export const totalsOf = (month: string, row: AttendanceFactsRow): AttendanceTotals =>
  attendanceTotals({
    month,
    hiredOn: row.hiredOn,
    terminatedOn: row.terminatedOn,
    calendar: { paidHolidays: new Set(row.holidays), makeupDays: new Set(row.makeupDays) },
    effects: row.effects,
  });

/**
 * Spec §7.3 step 7: lock the attendance period of every month of `dates` FOR SHARE, ascending, and
 * refuse (409 `error.periodClosed`) when one is closed (D07). The row is upserted first
 * (`INSERT … ON CONFLICT DO NOTHING`) because a month nobody closed yet has no row, and a lock
 * on a missing row would let a close commit between this check and the caller's own commit. A
 * close takes the row FOR UPDATE, so it waits for every writer holding it and no writer starts
 * after it until it commits. Called by submit (after the employee lock), by the approval effects
 * (after the request and bucket locks) and by calendar changes (after the calendar row): the
 * period row is never held while waiting for a lock taken earlier in that order by anyone but
 * its own close, and a close takes no lock after it.
 * The loop is over the months of one request or day, never more than three.
 */
export async function assertPeriodsOpen(
  manager: EntityManager,
  dates: readonly string[],
): Promise<void> {
  for (const month of monthsOf(dates)) {
    await manager.query(
      `INSERT INTO attendance_period(month) VALUES (CAST($1 AS date)) ON CONFLICT DO NOTHING`,
      [month],
    );
    const [row] = await manager.query<{ state: AttendancePeriodState }[]>(
      `SELECT state FROM attendance_period WHERE month = CAST($1 AS date) FOR SHARE`,
      [month],
    );
    if (row?.state !== 'open') throw new ApiRejection('error.periodClosed');
  }
}
