import {
  ProductAccessDenied,
  ProductCommandRejected,
  type ProductAuthorization,
  type ProductCommand,
  type ProductQuery,
} from '../authorization/services/product-authority.service.js';
import { WORK_CALENDAR_ID, hrScoped } from '../hr/hr-database.helper.js';
import type { CalendarDayInput, CalendarYearView } from './work-calendar.types.js';

/**
 * workCalendar.manage: one change = one new version, optimistic on `expectedVersion`. The
 * authorized row is already locked (FOR NO KEY UPDATE) by `execute`, so concurrent changes
 * serialize and the later one sees a stale version.
 * shortcut: no closed-period guard yet (D07, design §9): `attendance_period` arrives with T8,
 * which must lock the months of `date` FOR SHARE here and refuse a closed one with 409.
 */
export const setCalendarDay: ProductCommand<CalendarDayInput, { readonly version: string }> = {
  resource: 'workCalendar',
  action: 'manage',
  mode: 'write',
  target: () => WORK_CALENDAR_ID,
  run: async (ctx, input) => {
    const [current] = await ctx.tx.manager.query<{ version: string; name: string | null }[]>(
      `SELECT c.version::text AS version,
              (SELECT CASE WHEN x.kind = 'paid_holiday' THEN x.name END FROM work_calendar_change x
                WHERE x.day = CAST($2 AS date) AND x.version <= c.version
                ORDER BY x.version DESC LIMIT 1) AS name
         FROM work_calendar c WHERE c.id = $1`,
      [ctx.target.key, input.date],
    );
    if (!current || current.version !== input.expectedVersion)
      throw new ProductCommandRejected('stale_version');
    if (current.name === input.holiday) throw new ProductCommandRejected('unchanged');
    const [row] = await ctx.tx.manager.query<{ version: string }[]>(
      `WITH bumped AS (UPDATE work_calendar SET version = version + 1 WHERE id = $1 RETURNING version)
       INSERT INTO work_calendar_change(version,day,kind,name)
         SELECT version, CAST($2 AS date), $3, $4 FROM bumped RETURNING version::text AS version`,
      [
        ctx.target.key,
        input.date,
        input.holiday === null ? 'standard' : 'paid_holiday',
        input.holiday,
      ],
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

/** workCalendar.read: holidays of one year in effect at the current version. */
export const calendarYear: ProductQuery<{ readonly year: number }, CalendarYearView | undefined> = {
  resource: 'workCalendar',
  action: 'read',
  target: () => WORK_CALENDAR_ID,
  run: async ({ tx, scope }, input) => {
    const bound = hrScoped(scope, WORK_CALENDAR_ID, input.year);
    const [row] = await tx.manager.query<
      { version: string; holidays: CalendarYearView['holidays'] }[]
    >(
      `SELECT r.version::text AS version,
                COALESCE((SELECT json_agg(json_build_object('date', to_char(d.day,'YYYY-MM-DD'), 'name', d.name) ORDER BY d.day)
                  FROM (SELECT DISTINCT ON (x.day) x.day, x.kind, x.name FROM work_calendar_change x
                         WHERE x.day >= make_date(CAST(${bound.at(2)} AS int),1,1)
                           AND x.day < make_date(CAST(${bound.at(2)} AS int) + 1,1,1)
                           AND x.version <= r.version
                         ORDER BY x.day, x.version DESC) d
                  WHERE d.kind = 'paid_holiday'), '[]'::json) AS holidays
           FROM work_calendar r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
      bound.parameters,
    );
    return row && { version: row.version, year: input.year, holidays: row.holidays };
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
