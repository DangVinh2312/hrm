import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
} from '../../authorization/services/product-authority.service.js';
import { assertPeriodsOpen } from '../attendance/attendance-facts.repository.js';
import { WORK_CALENDAR_ID, hrScoped } from '../hr/hr-database.helper.js';
import type { CalendarDayInput, CalendarYearView } from './work-calendar.types.js';

/**
 * workCalendar.manage: one change = one new version, optimistic on `expectedVersion`. The
 * authorized row is already locked (FOR NO KEY UPDATE) by `execute`, so concurrent changes
 * serialize and the later one sees a stale version.
 * A day of a closed attendance month is refused (D07, 409 `error.periodClosed`); the month is
 * locked FOR SHARE until commit so a close cannot slip in between. `execute` already holds the
 * calendar row, so here the period comes after it (spec §7.3 lists period first): no cycle,
 * because a close takes only the company row and then the period, never the calendar.
 */
export const setCalendarDay: ProductCommand<CalendarDayInput, { readonly version: string }> = {
  resource: 'workCalendar',
  action: 'manage',
  mode: 'write',
  target: () => WORK_CALENDAR_ID,
  run: async (ctx, input) => {
    // The validator pairs `holiday` with weekdays and `makeup` with weekends; the schema CHECK
    // refuses any other pairing.
    const [kind, name]: readonly [string, string | null] =
      'makeup' in input
        ? [input.makeup ? 'makeup_workday' : 'standard', null]
        : input.holiday === null
          ? ['standard', null]
          : ['paid_holiday', input.holiday];
    await assertPeriodsOpen(ctx.tx.manager, [input.date]);
    const [current] = await ctx.tx.manager.query<
      { version: string; kind: string; name: string | null }[]
    >(
      `SELECT c.version::text AS version, COALESCE(d.kind, 'standard') AS kind, d.name
         FROM work_calendar c
         LEFT JOIN LATERAL (SELECT x.kind, x.name FROM work_calendar_change x
                WHERE x.day = CAST($2 AS date) AND x.version <= c.version
                ORDER BY x.version DESC LIMIT 1) d ON true
        WHERE c.id = $1`,
      [ctx.target.key, input.date],
    );
    if (!current || current.version !== input.expectedVersion)
      throw new ProductCommandRejected('stale_version');
    if (current.kind === kind && current.name === name)
      throw new ProductCommandRejected('unchanged');
    const [row] = await ctx.tx.manager.query<{ version: string }[]>(
      `WITH bumped AS (UPDATE work_calendar SET version = version + 1 WHERE id = $1 RETURNING version)
       INSERT INTO work_calendar_change(version,day,kind,name)
         SELECT version, CAST($2 AS date), $3, $4 FROM bumped RETURNING version::text AS version`,
      [ctx.target.key, input.date, kind, name],
    );
    if (!row) throw new Error('Calendar version bump returned no row');
    await ctx.audit('hr.work-calendar.update', {
      resource: 'workCalendar',
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return { version: row.version };
  },
};

/** workCalendar.read: holidays and makeup days of one year in effect at the current version. */
export const calendarYear: ProductQuery<{ readonly year: number }, CalendarYearView | undefined> = {
  resource: 'workCalendar',
  action: 'read',
  target: () => WORK_CALENDAR_ID,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, WORK_CALENDAR_ID, input.year);
    const [row] = await tx.manager.query<
      Pick<CalendarYearView, 'version' | 'holidays' | 'makeupDays'>[]
    >(
      `SELECT r.version::text AS version, y.holidays, y.makeup AS "makeupDays"
           FROM work_calendar r CROSS JOIN LATERAL (
             SELECT COALESCE(json_agg(json_build_object('date', to_char(d.day,'YYYY-MM-DD'), 'name', d.name) ORDER BY d.day)
                      FILTER (WHERE d.kind = 'paid_holiday'), '[]'::json) AS holidays,
                    COALESCE(json_agg(to_char(d.day,'YYYY-MM-DD') ORDER BY d.day)
                      FILTER (WHERE d.kind = 'makeup_workday'), '[]'::json) AS makeup
               FROM (SELECT DISTINCT ON (x.day) x.day, x.kind, x.name FROM work_calendar_change x
                      WHERE x.day >= make_date(CAST(${bound.at(2)} AS int),1,1)
                        AND x.day < make_date(CAST(${bound.at(2)} AS int) + 1,1,1)
                        AND x.version <= r.version
                      ORDER BY x.day, x.version DESC) d) y
          WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return (
      row && {
        version: row.version,
        year: input.year,
        holidays: row.holidays,
        makeupDays: row.makeupDays,
      }
    );
  },
};

export const workCalendarCommands = [setCalendarDay] as const;

export const workCalendarQueries = [calendarYear] as const;

/** Calendar operations bound to the registered command/query. */
export class WorkCalendarService {
  constructor(private readonly authorization: ProductAuthorization) {}

  /** `undefined`: the caller's plan does not reach the calendar (no HR role) — HTTP 404. */
  year(secret: string, year: number): Promise<CalendarYearView | undefined> {
    return this.authorization.query(secret, calendarYear, { year });
  }

  async setDay(secret: string, input: CalendarDayInput): Promise<{ readonly version: string }> {
    const changed = await this.authorization.execute(secret, setCalendarDay, input);
    // The anchor always exists, so "not visible" means no grant (403), as for company creates.
    if (!changed) throw new ProductAccessDenied();
    return changed;
  }
}
