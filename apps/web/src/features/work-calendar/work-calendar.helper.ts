import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session.provider';
import { type Locale } from '../../i18n/i18n.helper';
import { ApiError } from '../../infrastructure/http.client';
import { useWorkCalendarClient } from './work-calendar-services.provider';
import type { CompanySchedule } from './work-calendar.client';

/** Day of week of a `YYYY-MM-DD` business date, computed in UTC so no viewer timezone shifts it. */
export const utcDate = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const DAY_MS = 86_400_000;
/** Longest holiday range of one request, in calendar days (same limit as the API). */
export const MAX_HOLIDAY_DAYS = 31;

/** Calendar days from..to inclusive; `0` when from > to. Both are valid `YYYY-MM-DD`. */
export const calendarDaysBetween = (from: string, to: string) =>
  Math.max(0, Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / DAY_MS) + 1);

/**
 * Whether the company week in force on `date` works it (ADR-19); `undefined` before the first
 * listed version, whose week only the API knows.
 */
export function companyWorksOn(
  date: string,
  versions: CompanySchedule['versions'],
): boolean | undefined {
  const version = versions.findLast((item) => item.effectiveFrom <= date);
  return version && (version.days[(utcDate(date).getUTCDay() + 6) % 7]?.length ?? 0) > 0;
}

/** How many dates of `from..to` a holiday range would set; a date of unknown week counts. */
export function workdaysInRange(
  from: string,
  to: string,
  versions: CompanySchedule['versions'],
): number {
  const days = calendarDaysBetween(from, to);
  if (days > MAX_HOLIDAY_DAYS) return 0;
  let count = 0;
  for (let i = 0; i < days; i += 1) {
    const date = new Date(utcDate(from).getTime() + i * DAY_MS).toISOString().slice(0, 10);
    if (companyWorksOn(date, versions) !== false) count += 1;
  }
  return count;
}

export const weekdayName = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(utcDate(date));

/** The business year now (Asia/Ho_Chi_Minh), unless the URL names a valid one. */
export function selectedYear(param: string | null): number {
  const year = param && /^\d{4}$/.test(param) ? Number(param) : NaN;
  if (year >= 1900 && year <= 2100) return year;
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric' }).format(
      new Date(),
    ),
  );
}

/** The company week in force today and later versions; one cached query for the page. */
export function useCompanySchedule() {
  const { namespace } = useSession();
  const workCalendar = useWorkCalendarClient();
  return useQuery({
    queryKey: [namespace, 'workCalendar', 'schedule'],
    queryFn: ({ signal }) => workCalendar.schedule(signal),
  });
}

export function useCalendarRefresh() {
  const { namespace } = useSession();
  const queryClient = useQueryClient();
  // Calendar and company week changes move the hours each employee's day gets.
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [namespace, 'workCalendar'] }),
      queryClient.invalidateQueries({ queryKey: [namespace, 'employees', 'schedule'] }),
    ]).then(() => undefined);
}

/** A 409 means the calendar moved on: refetch so the retry carries the fresh expectedVersion. */
export const refreshOnConflict = (error: unknown, refresh: () => Promise<void>) =>
  error instanceof ApiError && error.status === 409 ? refresh() : undefined;
