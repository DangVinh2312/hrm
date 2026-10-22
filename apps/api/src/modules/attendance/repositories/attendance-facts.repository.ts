import type { EntityManager } from 'typeorm';
import { WORK_CALENDAR_ID } from '../../hr/helpers/hr-database.helper.js';
import { ApiRejection } from '../../../infrastructure/helpers/api-error.helper.js';
import {
  type AttendanceFactsRow,
  type EffectsGroup,
  type MonthsWindow,
  EFFECTS_SET_BASED_MIN_ROWS,
  adjustmentMinutesSql,
  approvedEffectsBySql,
  approvedEffectsSql,
  calendarDaysSql,
  date,
  effectsGroupsSql,
  effectsIndex,
  monthsOf,
} from '../helpers/attendance-facts.helper.js';
import type { AttendancePeriodState } from '../attendance.types.js';

/** What the stored JSON of one facts statement holds (see {@link AttendanceFactsRow}). */
interface FactsStored {
  /** `effects` is inside a row when read per row, else in `effects` by employee. */
  readonly rows: readonly (Omit<AttendanceFactsRow, 'effects'> & {
    readonly effects?: AttendanceFactsRow['effects'];
  })[];
  readonly effects: readonly EffectsGroup[];
}

export class AttendanceFactsRepository {
  async loadAttendanceFacts(
    manager: EntityManager,
    month: string,
    ids: readonly string[] | null,
  ): Promise<AttendanceFactsRow[]> {
    const window: MonthsWindow = {
      first: `CAST($1 || '-01' AS date)`,
      next: `CAST(CAST($1 || '-01' AS date) + interval '1 month' AS date)`,
    };
    const setBased = ids === null || ids.length >= EFFECTS_SET_BASED_MIN_ROWS;
    const [result] = await manager.query<{ result: FactsStored }[]>(
      `WITH m AS (SELECT CAST($1 || '-01' AS date) AS first, CAST(CAST($1 || '-01' AS date) + interval '1 month' AS date) AS next),
          cal AS (SELECT c.version FROM work_calendar c WHERE c.id = CAST($3 AS uuid)),
          days AS (SELECT DISTINCT ON (x.day) x.day, x.kind FROM work_calendar_change x, m, cal
                    WHERE x.day >= m.first AND x.day < m.next AND x.version <= cal.version
                    ORDER BY x.day, x.version DESC),
          sel AS (SELECT e.id, e.hired_on, e.terminated_on, m.first, m.next FROM employee e, m
                   WHERE CASE WHEN CAST($2 AS uuid[]) IS NULL
                              THEN e.hired_on < m.next AND (e.terminated_on IS NULL OR e.terminated_on >= m.first)
                              ELSE e.id = ANY(CAST($2 AS uuid[])) END)
          ${setBased ? `, fx AS (${approvedEffectsBySql('sel', window)})` : ''}
     SELECT json_build_object(
              'rows', COALESCE((SELECT json_agg(json_build_object(
                        'id', sel.id::text, 'hiredOn', ${date('sel.hired_on')}, 'terminatedOn', ${date('sel.terminated_on')},
                        'calendarVersion', (SELECT version::text FROM cal),
                        'periodState', (SELECT p.state FROM attendance_period p, m WHERE p.month = m.first),
                        'holidays', ${calendarDaysSql('paid_holiday', '(SELECT first FROM m)', '(SELECT next FROM m)')},
                        'makeupDays', ${calendarDaysSql('makeup_workday', '(SELECT first FROM m)', '(SELECT next FROM m)')},
                        ${setBased ? '' : `'effects', ${approvedEffectsSql('sel.id', 'sel.first', 'sel.next')},`}
                        'adjustmentMinutes', ${adjustmentMinutesSql('sel.id', 'sel.first', 'sel.next')}) ORDER BY sel.id)
                      FROM sel), '[]'::json),
              'effects', ${setBased ? effectsGroupsSql('fx') : `'[]'::json`}) AS result`,
      [month, ids === null ? null : [...ids], WORK_CALENDAR_ID],
    );
    if (!result) throw new Error('Attendance facts returned no row');
    const effectsOf = effectsIndex(result.result.effects);
    return result.result.rows.map((row) => ({
      id: row.id,
      hiredOn: row.hiredOn,
      terminatedOn: row.terminatedOn,
      calendarVersion: row.calendarVersion,
      periodState: row.periodState,
      holidays: row.holidays,
      makeupDays: row.makeupDays,
      effects: row.effects ?? effectsOf(row.id, month),
      adjustmentMinutes: row.adjustmentMinutes,
    }));
  }

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
  async assertPeriodsOpen(manager: EntityManager, dates: readonly string[]): Promise<void> {
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
}
