import { z } from 'zod';
import type { HttpClient } from '../../infrastructure/http.client';
import { type Frame, weekSchema } from '../../components/week-frames.helper';

const version = z.string().regex(/^[1-9][0-9]{0,17}$/);

/** Hours of a makeup day: those of `asWeekday`, from the company week or each employee's own. */
const makeupSchema = z.object({
  asWeekday: z.number().int().min(1).max(7),
  frameSource: z.enum(['company', 'employee']),
});
export type MakeupHours = z.infer<typeof makeupSchema>;

/**
 * `GET /api/hr/work-calendar?year=` (T4, ADR-19): paid holidays and makeup workdays of one year at
 * the current version.
 */
const yearSchema = z.object({
  version,
  year: z.number().int().min(1900).max(2100),
  holidays: z.array(z.object({ date: z.iso.date(), name: z.string().min(1).max(200) })).max(366),
  makeupDays: z.array(makeupSchema.extend({ date: z.iso.date() })).max(366),
});
export type CalendarYear = z.infer<typeof yearSchema>;

const versionSchema = z.object({ version });

/** `GET /api/hr/work-calendar/schedule` (ADR-19): the version in force today and every later one. */
const scheduleSchema = z.object({
  today: z.iso.date(),
  maxMinutes: z.number().int().min(60).max(720),
  versions: z
    .array(z.object({ effectiveFrom: z.iso.date(), days: weekSchema }))
    .min(1)
    .max(1000),
});
export type CompanySchedule = z.infer<typeof scheduleSchema>;

const effectiveSchema = z.object({ effectiveFrom: z.iso.date() });

export interface WorkCalendarClient {
  year(year: number, signal?: AbortSignal): Promise<CalendarYear>;

  /**
   * A company workday: `holiday` is its name, or `null` to work it again. A company day off:
   * `makeup` makes it a workday with the hours of a weekday, or `null` a day off again.
   */
  setDay(
    date: string,
    input: { readonly expectedVersion: string } & (
      { readonly holiday: string | null } | { readonly makeup: MakeupHours | null }
    ),
  ): Promise<{ version: string }>;

  /** `PUT /api/hr/work-calendar/holidays`: a holiday on every weekday of from..to. */
  setHolidays(input: HolidayRangeInput): Promise<{ version: string }>;

  schedule(signal?: AbortSignal): Promise<CompanySchedule>;

  /** Creates or replaces the company week from `effectiveFrom` (after today). */
  putSchedule(effectiveFrom: string, days: readonly Frame[]): Promise<{ effectiveFrom: string }>;

  /** Removes a version not in force yet. */
  deleteSchedule(effectiveFrom: string): Promise<{ effectiveFrom: string }>;
}

export type HolidayRangeInput = {
  readonly expectedVersion: string;
  readonly from: string;
  readonly to: string;
  readonly name: string;
};

const schedulePath = (effectiveFrom: string) =>
  `/api/hr/work-calendar/schedule/${encodeURIComponent(effectiveFrom)}`;

export function createWorkCalendarClient(http: HttpClient): WorkCalendarClient {
  return {
    year: (year, signal) =>
      http.request(
        `/api/hr/work-calendar?year=${encodeURIComponent(String(year))}`,
        yearSchema,
        signal ? { signal } : {},
      ),
    setDay: (date, input) =>
      http.request(`/api/hr/work-calendar/days/${encodeURIComponent(date)}`, versionSchema, {
        method: 'PUT',
        body: input,
      }),
    setHolidays: (input) =>
      http.request('/api/hr/work-calendar/holidays', versionSchema, { method: 'PUT', body: input }),
    schedule: (signal) =>
      http.request('/api/hr/work-calendar/schedule', scheduleSchema, signal ? { signal } : {}),
    putSchedule: (effectiveFrom, days) =>
      http.request(schedulePath(effectiveFrom), effectiveSchema, { method: 'PUT', body: { days } }),
    deleteSchedule: (effectiveFrom) =>
      http.request(schedulePath(effectiveFrom), effectiveSchema, { method: 'DELETE' }),
  };
}
