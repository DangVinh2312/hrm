import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import { hrBody, hrDate, hrText, hrVersion } from '../hr/hr-input.helper.js';
import type { CalendarDayInput } from './work-calendar.types.js';
import { dayKind } from './working-time.helper.js';

/** `?year=YYYY` only, 1900..2100 (the business date range of hr-input.helper.ts). */
export function parseCalendarYear(query: unknown): number {
  const body = hrBody(query, ['year']);
  if (typeof body.year !== 'string' || !/^\d{4}$/.test(body.year))
    throw new ProductInvalidRequest('Invalid year');
  const year = Number(body.year);
  if (year < 1900 || year > 2100) throw new ProductInvalidRequest('Invalid year');
  return year;
}

/**
 * A weekday takes `holiday` only: Saturday/Sunday are already days off, a holiday there would
 * change nothing. A Saturday/Sunday takes `makeup` only: a weekday is already a workday.
 */
export function parseCalendarDay(date: unknown, value: unknown): CalendarDayInput {
  const day = hrDate(date);
  if (dayKind(day, { paidHolidays: new Set(), makeupDays: new Set() }) === 'weekend') {
    const body = hrBody(value, ['expectedVersion', 'makeup']);
    if (typeof body.makeup !== 'boolean') throw new ProductInvalidRequest('Invalid makeup');
    return { expectedVersion: hrVersion(body.expectedVersion), date: day, makeup: body.makeup };
  }
  const body = hrBody(value, ['expectedVersion', 'holiday']);
  return {
    expectedVersion: hrVersion(body.expectedVersion),
    date: day,
    holiday: body.holiday === null ? null : hrText(body.holiday, 200),
  };
}
