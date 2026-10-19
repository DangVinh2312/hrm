import type { Locale } from './i18n.helper';

/**
 * `YYYY-MM-DD` business date → `dd/MM/yyyy` (design system §6) by string surgery only: no Date,
 * so the viewer's timezone can never shift the day.
 */
export function formatDate(value: string | null | undefined): string {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
}

/** Leave minutes as days (480 minutes = 1 day), at most two decimals in the viewer's language. */
export function formatDays(minutes: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(minutes / 480);
}

/** UTC instant → `dd/MM/yyyy HH:mm` order of the viewer's language, always in the business timezone (ADR 0018). */
export function formatDateTime(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'Asia/Ho_Chi_Minh',
      }).format(date);
}
