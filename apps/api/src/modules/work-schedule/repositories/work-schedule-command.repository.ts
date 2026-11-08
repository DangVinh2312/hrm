import { randomUUID } from 'node:crypto';
import { ProductInvalidRequest } from '../../../authorization/product-data.gateway.js';
import {
  type ProductCommand,
  type ProductCommandContext,
  ProductCommandRejected,
} from '../../../authorization/services/product-authority.types.js';
import { BUSINESS_TODAY } from '../../../infrastructure/helpers/business-time.helper.js';
import type { AttendanceFactsRepository } from '../../attendance/repositories/attendance-facts.repository.js';
import { EmployeeAction, EmployeeResource } from '../../employee/employee-authorization.types.js';
import { WORK_CALENDAR_ID } from '../../permission/permission-database.helper.js';
import type { SettingReadRepository } from '../../setting/repositories/setting-read.repository.js';
import { SettingKey } from '../../setting/setting.registry.js';
import {
  WorkCalendarAction,
  WorkCalendarResource,
} from '../../work-calendar/work-calendar-authorization.types.js';
import { isoWeekday } from '../../work-calendar/working-time.helper.js';
import { companyFrameOn, isValidFrame } from '../helpers/work-schedule.helper.js';
import {
  type StoredShift,
  type StoredVersion,
  scheduleVersions,
  scheduleVersionsSql,
  storedShifts,
} from '../helpers/work-schedule-sql.helper.js';
import type {
  CompanyScheduleInput,
  EmployeeFrameInput,
  EmployeeFrameKey,
  WeekFrames,
} from '../work-schedule.types.js';

/** Inserts the shifts of `days` under parent `id`; positions count from 1 within each weekday. */
const insertShifts = (ctx: ProductCommandContext, table: string, id: string, days: WeekFrames) => {
  const rows = days.flatMap((frame, index) =>
    frame.map(([start, end], position) => [index + 1, position + 1, start, end]),
  );

  const column = (i: number) => rows.map((row) => row[i]);

  return ctx.tx.manager.query(
    `INSERT INTO ${table}(schedule_id,weekday,position,start_minute,end_minute)
     SELECT $1, w, p, s, e FROM unnest(CAST($2 AS int[]), CAST($3 AS int[]), CAST($4 AS int[]),
                                       CAST($5 AS int[])) AS t(w, p, s, e)`,
    [id, column(0), column(1), column(2), column(3)],
  );
};

/**
 * Schedule writes (ADR-19). Each touches only days after today (the DB business date), so a day
 * already worked, and every closed month, keeps its hours. Company versions are written under the
 * calendar row (locked by `execute`, held FOR SHARE by every submit); employee frames under the
 * employee row (locked by `execute`, the lock of every submit of that employee).
 * The current month can be closed before it ends, so the month of the first day changed must be
 * open (409 `error.periodClosed`, held FOR SHARE after the row lock, as calendar changes and
 * submits do); a later month cannot be closed yet.
 */
export class WorkScheduleCommandRepository {
  readonly #settings: SettingReadRepository;
  readonly #attendanceFacts: AttendanceFactsRepository;

  constructor(settings: SettingReadRepository, attendanceFacts: AttendanceFactsRepository) {
    this.#settings = settings;
    this.#attendanceFacts = attendanceFacts;
  }

  /**
   * Every makeup day from `from` on still works a day the company has off, with the hours of a
   * weekday the company works (the rule of `setCalendarDay`); otherwise the change is refused (409)
   * rather than silently moving those days.
   */
  async #assertMakeupDays(ctx: ProductCommandContext, from: string): Promise<void> {
    const [row] = await ctx.tx.manager.query<
      { versions: StoredVersion[]; makeup: { date: string; asWeekday: number }[] }[]
    >(
      `SELECT ${scheduleVersionsSql('CAST($1 AS date)', "DATE 'infinity'")} AS versions,
              COALESCE((SELECT json_agg(json_build_object('date', to_char(d.day,'YYYY-MM-DD'),
                                'asWeekday', d.as_weekday))
                          FROM (SELECT DISTINCT ON (x.day) x.day, x.kind, x.as_weekday
                                  FROM work_calendar_change x WHERE x.day >= CAST($1 AS date)
                                 ORDER BY x.day, x.version DESC) d
                         WHERE d.kind = 'makeup_workday'), '[]'::json) AS makeup`,
      [from],
    );
    const versions = scheduleVersions(row?.versions ?? []);
    for (const day of row?.makeup ?? [])
      if (
        companyFrameOn(day.date, isoWeekday(day.date), versions).length > 0 ||
        companyFrameOn(day.date, day.asWeekday, versions).length === 0
      )
        throw new ProductCommandRejected('makeup_day');
  }

  /** Every day a valid frame within `hr.workdayMaxMinutes` in force now, and at least one not empty. */
  async #assertWeek(ctx: ProductCommandContext, days: WeekFrames): Promise<void> {
    const values = await this.#settings.read(ctx.tx.manager, [SettingKey.WorkdayMaxMinutes]);
    const max = values[SettingKey.WorkdayMaxMinutes];
    if (!days.every((frame) => isValidFrame(frame, max)) || days.every((f) => f.length === 0))
      throw new ProductInvalidRequest('Invalid frame');
  }

  /** workCalendar.manageSchedule: creates or replaces the company version starting `effectiveFrom`. */
  readonly putCompanySchedule: ProductCommand<
    CompanyScheduleInput,
    { readonly effectiveFrom: string }
  > = {
    resource: WorkCalendarResource.WorkCalendar,
    action: WorkCalendarAction.ManageSchedule,
    mode: 'write',
    target: () => WORK_CALENDAR_ID,
    run: async (ctx, input) => {
      await this.#assertWeek(ctx, input.days);
      const [row] = await ctx.tx.manager.query<
        { future: boolean; current: StoredShift[] | null }[]
      >(
        `SELECT CAST($1 AS date) > ${BUSINESS_TODAY} AS future,
                (SELECT COALESCE(json_agg(json_build_array(s.weekday, s.start_minute, s.end_minute)
                          ORDER BY s.weekday, s.position), '[]'::json)
                   FROM work_schedule w LEFT JOIN work_schedule_shift s ON s.schedule_id = w.id
                  WHERE w.effective_from = CAST($1 AS date)
                  GROUP BY w.id) AS current`,
        [input.effectiveFrom],
      );
      if (!row?.future) throw new ProductInvalidRequest('Invalid date');
      if (JSON.stringify(row.current) === JSON.stringify(storedShifts(input.days)))
        throw new ProductCommandRejected('unchanged');
      await this.#attendanceFacts.assertPeriodsOpen(ctx.tx.manager, [input.effectiveFrom]);
      const id = randomUUID();
      await ctx.tx.manager.query(
        `DELETE FROM work_schedule WHERE effective_from = CAST($1 AS date)`,
        [input.effectiveFrom],
      );
      await ctx.tx.manager.query(
        `INSERT INTO work_schedule(id, effective_from) VALUES ($1, CAST($2 AS date))`,
        [id, input.effectiveFrom],
      );
      await insertShifts(ctx, 'work_schedule_shift', id, input.days);
      await this.#assertMakeupDays(ctx, input.effectiveFrom);
      await ctx.audit('hr.work-schedule.update', {
        resource: WorkCalendarResource.WorkCalendar,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { effectiveFrom: input.effectiveFrom };
    },
  };

  /** workCalendar.manageSchedule: removes a version not in force yet. */
  readonly deleteCompanySchedule: ProductCommand<
    { readonly effectiveFrom: string },
    { readonly effectiveFrom: string }
  > = {
    resource: WorkCalendarResource.WorkCalendar,
    action: WorkCalendarAction.ManageSchedule,
    mode: 'write',
    target: () => WORK_CALENDAR_ID,
    run: async (ctx, input) => {
      const [row] = await ctx.tx.manager.query<{ future: boolean }[]>(
        `SELECT effective_from > ${BUSINESS_TODAY} AS future FROM work_schedule
          WHERE effective_from = CAST($1 AS date)`,
        [input.effectiveFrom],
      );
      if (!row) throw new ProductCommandRejected('no_version');
      if (!row.future) throw new ProductInvalidRequest('Invalid date');
      await this.#attendanceFacts.assertPeriodsOpen(ctx.tx.manager, [input.effectiveFrom]);
      await ctx.tx.manager.query(
        `DELETE FROM work_schedule WHERE effective_from = CAST($1 AS date)`,
        [input.effectiveFrom],
      );
      await this.#assertMakeupDays(ctx, input.effectiveFrom);
      await ctx.audit('hr.work-schedule.update', {
        resource: WorkCalendarResource.WorkCalendar,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { effectiveFrom: input.effectiveFrom };
    },
  };

  /**
   * employee.manageSchedule: own hours from a date after today. Frames of one employee never
   * overlap (409); an empty weekday keeps the company's hours, a day the company has off stays off.
   */
  readonly addEmployeeFrame: ProductCommand<EmployeeFrameInput, { readonly id: string }> = {
    resource: EmployeeResource.Employee,
    action: EmployeeAction.ManageSchedule,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      await this.#assertWeek(ctx, input.days);
      const [row] = await ctx.tx.manager.query<
        { future: boolean; overlaps: boolean; workdays: number[] }[]
      >(
        `SELECT CAST($2 AS date) > ${BUSINESS_TODAY} AS future,
                EXISTS (SELECT 1 FROM employee_schedule o WHERE o.employee_id = $1
                          AND o.valid_from <= COALESCE(CAST($3 AS date), DATE 'infinity')
                          AND COALESCE(o.valid_to, DATE 'infinity') >= CAST($2 AS date)) AS overlaps,
                ARRAY(SELECT DISTINCT s.weekday::int FROM work_schedule_shift s
                       WHERE s.schedule_id = (SELECT w.id FROM work_schedule w
                                               WHERE w.effective_from <= CAST($2 AS date)
                                               ORDER BY w.effective_from DESC LIMIT 1)) AS workdays`,
        [ctx.target.key, input.validFrom, input.validTo],
      );
      if (!row?.future) throw new ProductInvalidRequest('Invalid date');
      // Own hours change the hours of a company workday, never add a workday.
      if (input.days.some((frame, index) => frame.length > 0 && !row.workdays.includes(index + 1)))
        throw new ProductInvalidRequest('Invalid frame');
      if (row.overlaps) throw new ProductCommandRejected('overlap');
      await this.#attendanceFacts.assertPeriodsOpen(ctx.tx.manager, [input.validFrom]);
      const id = randomUUID();
      await ctx.tx.manager.query(
        `INSERT INTO employee_schedule(id, employee_id, valid_from, valid_to)
         VALUES ($1, $2, CAST($3 AS date), CAST($4 AS date))`,
        [id, ctx.target.key, input.validFrom, input.validTo],
      );
      await insertShifts(ctx, 'employee_schedule_shift', id, input.days);
      await ctx.audit('hr.employee-schedule.update', {
        resource: EmployeeResource.Employee,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { id };
    },
  };

  /**
   * employee.manageSchedule: a frame not started yet is removed; one in force ends today, so
   * today and every earlier day keep its hours.
   */
  readonly endEmployeeFrame: ProductCommand<EmployeeFrameKey, { readonly id: string }> = {
    resource: EmployeeResource.Employee,
    action: EmployeeAction.ManageSchedule,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const [row] = await ctx.tx.manager.query<
        { future: boolean; running: boolean; firstChanged: string }[]
      >(
        `SELECT valid_from > ${BUSINESS_TODAY} AS future,
                (valid_to IS NULL OR valid_to > ${BUSINESS_TODAY}) AS running,
                to_char(GREATEST(valid_from, ${BUSINESS_TODAY} + 1),'YYYY-MM-DD') AS "firstChanged"
           FROM employee_schedule WHERE id = $2 AND employee_id = $1`,
        [ctx.target.key, input.frameId],
      );
      if (!row) throw new ProductCommandRejected('no_frame');
      if (row.future || row.running)
        await this.#attendanceFacts.assertPeriodsOpen(ctx.tx.manager, [row.firstChanged]);
      if (row.future)
        await ctx.tx.manager.query(`DELETE FROM employee_schedule WHERE id = $1`, [input.frameId]);
      else if (row.running)
        await ctx.tx.manager.query(
          `UPDATE employee_schedule SET valid_to = ${BUSINESS_TODAY} WHERE id = $1`,
          [input.frameId],
        );
      else throw new ProductCommandRejected('unchanged');
      await ctx.audit('hr.employee-schedule.update', {
        resource: EmployeeResource.Employee,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { id: input.frameId };
    },
  };
}
