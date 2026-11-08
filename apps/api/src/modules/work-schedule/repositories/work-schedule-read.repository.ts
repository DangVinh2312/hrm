import type { EntityManager } from 'typeorm';
import type { ProductQuery } from '../../../authorization/services/product-authority.types.js';
import { BUSINESS_TODAY } from '../../../infrastructure/helpers/business-time.helper.js';
import { EmployeeAction, EmployeeResource } from '../../employee/employee-authorization.types.js';
import { WORK_CALENDAR_ID, scopedParameters } from '../../permission/permission-database.helper.js';
import type { SettingReadRepository } from '../../setting/repositories/setting-read.repository.js';
import { SettingKey } from '../../setting/setting.registry.js';
import {
  WorkCalendarAction,
  WorkCalendarResource,
} from '../../work-calendar/work-calendar-authorization.types.js';
import { datesBetween } from '../../work-calendar/working-time.helper.js';
import { type ScheduleFacts, frameOn } from '../helpers/work-schedule.helper.js';
import {
  type StoredFrames,
  type StoredSchedule,
  type StoredVersion,
  employeeFramesSql,
  scheduleFacts,
  scheduleVersions,
  scheduleVersionsSql,
  weekFrames,
} from '../helpers/work-schedule-sql.helper.js';
import { MAX_SCHEDULE_RANGE_DAYS } from '../work-schedule.validator.js';
import type {
  CompanyScheduleView,
  EmployeeFramesView,
  EmployeeScheduleQuery,
  EmployeeScheduleView,
} from '../work-schedule.types.js';

const today = `to_char(${BUSINESS_TODAY},'YYYY-MM-DD')`;
const end = `DATE '2101-01-01'`;

export class WorkScheduleReadRepository {
  readonly #settings: SettingReadRepository;

  constructor(settings: SettingReadRepository) {
    this.#settings = settings;
  }

  async #maxMinutes(manager: EntityManager): Promise<number> {
    const values = await this.#settings.read(manager, [SettingKey.WorkdayMaxMinutes]);
    return values[SettingKey.WorkdayMaxMinutes];
  }

  /**
   * The schedule of one employee from the first to the last of `dates`: the calendar days at
   * calendar `version` (the caller holds that row FOR SHARE when it writes), the company versions
   * and the employee's own frames. One statement, so one snapshot.
   */
  async employeeSchedule(
    manager: EntityManager,
    employee: string,
    dates: readonly string[],
    version: string,
  ): Promise<ScheduleFacts> {
    const [from, last] = [
      `(SELECT min(d) FROM unnest(CAST($2 AS date[])) d)`,
      `(SELECT max(d) FROM unnest(CAST($2 AS date[])) d)`,
    ];
    const next = `${last} + 1`;
    const [row] = await manager.query<{ stored: StoredSchedule }[]>(
      `WITH days AS (
         SELECT DISTINCT ON (c.day) to_char(c.day,'YYYY-MM-DD') AS day, c.kind, c.as_weekday, c.frame_source
           FROM work_calendar_change c
          WHERE c.day >= ${from} AND c.day < ${next} AND c.version <= CAST($3 AS int8)
          ORDER BY c.day, c.version DESC)
       SELECT json_build_object(
                'versions', ${scheduleVersionsSql(from, next)},
                'frames', ${employeeFramesSql('CAST($1 AS uuid)', from, next)},
                'holidays', COALESCE((SELECT json_agg(day) FROM days WHERE kind = 'paid_holiday'), '[]'::json),
                'makeupDays', COALESCE((SELECT json_agg(json_build_object('date', day, 'asWeekday', as_weekday,
                                'frameSource', frame_source)) FROM days WHERE kind = 'makeup_workday'), '[]'::json)
              ) AS stored`,
      [employee, [...dates], version],
    );
    if (!row) throw new Error('Schedule read returned no row');
    return scheduleFacts(scheduleVersions(row.stored.versions), row.stored);
  }

  /** workCalendar.read: the company version in force today and every later one. */
  readonly companySchedule: ProductQuery<undefined, CompanyScheduleView | undefined> = {
    resource: WorkCalendarResource.WorkCalendar,
    action: WorkCalendarAction.Read,
    target: () => WORK_CALENDAR_ID,
    run: async ({ tx, scope }) => {
      const bound = scopedParameters(scope, WORK_CALENDAR_ID);
      const [row] = await tx.manager.query<{ today: string; versions: StoredVersion[] }[]>(
        `SELECT ${today} AS today, ${scheduleVersionsSql(BUSINESS_TODAY, end)} AS versions
           FROM work_calendar r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
        bound.parameters,
      );
      if (!row) return undefined;
      return {
        today: row.today,
        maxMinutes: await this.#maxMinutes(tx.manager),
        versions: scheduleVersions(row.versions),
      };
    },
  };

  /** employee.readSchedule: the employee's frames that end today or later. */
  readonly employeeFrames: ProductQuery<
    { readonly employeeId: string },
    EmployeeFramesView | undefined
  > = {
    resource: EmployeeResource.Employee,
    action: EmployeeAction.ReadSchedule,
    target: (input) => input.employeeId,
    run: async ({ tx, scope }, input) => {
      const bound = scopedParameters(scope, input.employeeId);
      const [row] = await tx.manager.query<{ today: string; frames: StoredFrames[] }[]>(
        `SELECT ${today} AS today, ${employeeFramesSql('r.id', BUSINESS_TODAY, end)} AS frames
           FROM employee r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
        bound.parameters,
      );
      if (!row) return undefined;
      return {
        today: row.today,
        maxMinutes: await this.#maxMinutes(tx.manager),
        frames: row.frames.map((f) => ({
          id: f.id,
          validFrom: f.from,
          validTo: f.to,
          days: weekFrames(f.shifts),
        })),
      };
    },
  };

  /** employee.readSchedule: the hours of each day of `from..to` at the current calendar version. */
  readonly employeeDays: ProductQuery<EmployeeScheduleQuery, EmployeeScheduleView | undefined> = {
    resource: EmployeeResource.Employee,
    action: EmployeeAction.ReadSchedule,
    target: (input) => input.employeeId,
    run: async ({ tx, scope }, input) => {
      const bound = scopedParameters(scope, input.employeeId, WORK_CALENDAR_ID);
      const [row] = await tx.manager.query<{ id: string; calendar: string | null }[]>(
        `SELECT r.id::text AS id,
                (SELECT c.version::text FROM work_calendar c WHERE c.id = CAST(${bound.at(2)} AS uuid)) AS calendar
           FROM employee r WHERE ${scope.sql} AND r.id = CAST(${bound.at(1)} AS uuid)`,
        bound.parameters,
      );
      if (!row) return undefined;
      if (!row.calendar) throw new Error('Work calendar anchor is missing');
      const dates = datesBetween(input.from, input.to, MAX_SCHEDULE_RANGE_DAYS);
      const facts = await this.employeeSchedule(tx.manager, row.id, dates, row.calendar);
      return {
        employeeId: row.id,
        days: dates.map((date) => {
          const day = frameOn(date, facts);
          return { date, kind: day.kind, shifts: day.frame };
        }),
      };
    },
  };
}
