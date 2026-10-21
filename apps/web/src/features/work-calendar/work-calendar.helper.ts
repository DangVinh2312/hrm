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

export const weekdayName = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(utcDate(date));

/** The business year now (ADR 0018: Asia/Ho_Chi_Minh), unless the URL names a valid one. */
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
