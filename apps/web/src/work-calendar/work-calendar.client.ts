import { z } from 'zod';
import type { HttpClient } from '../infrastructure/http.client';

const version = z.string().regex(/^[1-9][0-9]{0,17}$/);

/** `GET /api/hr/work-calendar?year=` (T4): paid holidays of one year at the current version. */
const yearSchema = z.object({
  version,
  year: z.number().int().min(1900).max(2100),
  holidays: z.array(z.object({ date: z.iso.date(), name: z.string().min(1).max(200) })).max(366),
});
export type CalendarYear = z.infer<typeof yearSchema>;

const versionSchema = z.object({ version });

export interface WorkCalendarClient {
  year(year: number, signal?: AbortSignal): Promise<CalendarYear>;

  /** `holiday`: its name, or `null` to make the weekday a standard workday again. */
  setDay(
    date: string,
    input: { readonly expectedVersion: string; readonly holiday: string | null },
  ): Promise<{ version: string }>;
}

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
  };
}
