import { WorkCalendarResource, WorkCalendarAction } from './work-calendar-authorization.types.js';
import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
} from '../../authorization/services/product-authority.service.js';
import type { AttendanceFactsRepository } from '../attendance/repositories/attendance-facts.repository.js';
import { WORK_CALENDAR_ID, scopedParameters } from '../permission/permission-database.helper.js';
import type {
  CalendarDayInput,
  CalendarHolidaysInput,
  CalendarYearView,
} from './work-calendar.types.js';
import { weekdaysBetween } from './working-time.helper.js';

/**
 * workCalendar.manage: one change = one new version, optimistic on `expectedVersion`. The
 * authorized row is already locked (FOR NO KEY UPDATE) by `execute`, so concurrent changes
 * serialize and the later one sees a stale version.
 * A day of a closed attendance month is refused (D07, 409 `error.periodClosed`); the month is
 * locked FOR SHARE until commit so a close cannot slip in between. `execute` already holds the
 * calendar row, so here the period comes after it (spec §7.3 lists period first): no cycle,
 * because a close takes only the company row and then the period, never the calendar.
 */
export const createSetCalendarDay = (
  attendanceFacts: AttendanceFactsRepository,
): ProductCommand<CalendarDayInput, { readonly version: string }> => ({
  resource: WorkCalendarResource.WorkCalendar,
  action: WorkCalendarAction.Manage,
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
    await attendanceFacts.assertPeriodsOpen(ctx.tx.manager, [input.date]);
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
      resource: WorkCalendarResource.WorkCalendar,
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return { version: row.version };
  },
});

/**
 * workCalendar.manage, a holiday range: one transaction, one audit, one version per
 * changed weekday (consecutive, in date order) so every earlier version stays exact. Same lock
 * order as {@link createSetCalendarDay}: the calendar row (held by `execute`), then the attendance
 * months of the range FOR SHARE (at most two for 31 days). Days that already are this holiday are
 * left alone; nothing to change at all is `unchanged`, a closed month refuses the whole range.
 */
export const createSetCalendarHolidays = (
  attendanceFacts: AttendanceFactsRepository,
): ProductCommand<CalendarHolidaysInput, { readonly version: string }> => ({
  resource: WorkCalendarResource.WorkCalendar,
  action: WorkCalendarAction.Manage,
  mode: 'write',
  target: () => WORK_CALENDAR_ID,
  run: async (ctx, input) => {
    const weekdays = weekdaysBetween(input.from, input.to);
    if (weekdays.length === 0) throw new ProductCommandRejected('unchanged');
    await attendanceFacts.assertPeriodsOpen(ctx.tx.manager, weekdays);
    const current = await ctx.tx.manager.query<
      { version: string; day: string; kind: string; name: string | null }[]
    >(
      `SELECT c.version::text AS version, to_char(t.day, 'YYYY-MM-DD') AS day,
              COALESCE(d.kind, 'standard') AS kind, d.name
         FROM work_calendar c
         CROSS JOIN unnest(CAST($2 AS date[])) AS t(day)
         LEFT JOIN LATERAL (SELECT x.kind, x.name FROM work_calendar_change x
                WHERE x.day = t.day AND x.version <= c.version
                ORDER BY x.version DESC LIMIT 1) d ON true
        WHERE c.id = $1
        ORDER BY t.day`,
      [ctx.target.key, weekdays],
    );
    if (current[0]?.version !== input.expectedVersion)
      throw new ProductCommandRejected('stale_version');
    const changing = current
      .filter((row) => row.kind !== 'paid_holiday' || row.name !== input.name)
      .map((row) => row.day);
    if (changing.length === 0) throw new ProductCommandRejected('unchanged');
    const [row] = await ctx.tx.manager.query<{ version: string }[]>(
      `WITH bumped AS (UPDATE work_calendar SET version = version + $3 WHERE id = $1 RETURNING version),
            written AS (
              INSERT INTO work_calendar_change(version,day,kind,name)
                SELECT bumped.version - $3 + t.ord, CAST(t.day AS date), 'paid_holiday', $4
                  FROM bumped, unnest(CAST($2 AS text[])) WITH ORDINALITY AS t(day, ord)
                RETURNING 1)
       SELECT bumped.version::text AS version FROM bumped`,
      [ctx.target.key, changing, changing.length, input.name],
    );
    if (!row) throw new Error('Calendar version bump returned no row');
    await ctx.audit('hr.work-calendar.update', {
      resource: WorkCalendarResource.WorkCalendar,
      key: ctx.target.key,
      objectId: ctx.target.objectId,
    });
    return { version: row.version };
  },
});

/** workCalendar.read: holidays and makeup days of one year in effect at the current version. */
export const calendarYear: ProductQuery<{ readonly year: number }, CalendarYearView | undefined> = {
  resource: WorkCalendarResource.WorkCalendar,
  action: WorkCalendarAction.Read,
  target: () => WORK_CALENDAR_ID,
  run: async ({ tx, scope }, input) => {
    const bound = scopedParameters(scope, WORK_CALENDAR_ID, input.year);
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

export type SetCalendarDayCommand = ReturnType<typeof createSetCalendarDay>;

export type SetCalendarHolidaysCommand = ReturnType<typeof createSetCalendarHolidays>;

export const workCalendarCommands = (
  setCalendarDay: SetCalendarDayCommand,
  setCalendarHolidays: SetCalendarHolidaysCommand,
) => [setCalendarDay, setCalendarHolidays] as const;

export const workCalendarQueries = [calendarYear] as const;

/** Calendar operations bound to the registered command/query. */
export class WorkCalendarService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly setCalendarDay: SetCalendarDayCommand,
    private readonly setCalendarHolidays: SetCalendarHolidaysCommand,
  ) {}

  /** `undefined`: the caller's plan does not reach the calendar (no HR role) — HTTP 404. */
  year(secret: string, year: number): Promise<CalendarYearView | undefined> {
    return this.authorization.query(secret, calendarYear, { year });
  }

  async setDay(secret: string, input: CalendarDayInput): Promise<{ readonly version: string }> {
    const changed = await this.authorization.execute(secret, this.setCalendarDay, input);
    // The anchor always exists, so "not visible" means no grant (403), as for company creates.
    if (!changed) throw new ProductAccessDenied();
    return changed;
  }

  async setHolidays(
    secret: string,
    input: CalendarHolidaysInput,
  ): Promise<{ readonly version: string }> {
    const changed = await this.authorization.execute(secret, this.setCalendarHolidays, input);
    if (!changed) throw new ProductAccessDenied();
    return changed;
  }
}
