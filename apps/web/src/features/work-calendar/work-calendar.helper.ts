import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../auth/session.provider';
import { type Locale } from '../../i18n/i18n.helper';
import { ApiError } from '../../infrastructure/http.client';

/** Day of week of a `YYYY-MM-DD` business date, computed in UTC so no viewer timezone shifts it. */
export const utcDate = (date: string) => {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

export const isWeekday = (date: string) => ![0, 6].includes(utcDate(date).getUTCDay());

const DAY_MS = 86_400_000;
/** Longest holiday range of one request, in calendar days (same limit as the API). */
export const MAX_HOLIDAY_DAYS = 31;

/** Calendar days from..to inclusive; `0` when from > to. Both are valid `YYYY-MM-DD`. */
export const calendarDaysBetween = (from: string, to: string) =>
  Math.max(0, Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / DAY_MS) + 1);

/** How many Monday–Friday dates `from..to` holds, i.e. the days a holiday range would set. */
export function weekdaysInRange(from: string, to: string): number {
  const days = calendarDaysBetween(from, to);
  if (days > MAX_HOLIDAY_DAYS) return 0;
  let count = 0;
  for (let i = 0; i < days; i += 1)
    if (![0, 6].includes(new Date(utcDate(from).getTime() + i * DAY_MS).getUTCDay())) count += 1;
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

export function useCalendarRefresh() {
  const { namespace } = useSession();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [namespace, 'workCalendar'] });
}

/** A 409 means the calendar moved on: refetch so the retry carries the fresh expectedVersion. */
export const refreshOnConflict = (error: unknown, refresh: () => Promise<void>) =>
  error instanceof ApiError && error.status === 409 ? refresh() : undefined;
