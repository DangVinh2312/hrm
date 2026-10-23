import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  inputBody,
  inputDate,
  inputText,
  inputVersion,
} from '../../infrastructure/helpers/input-validation.helper.js';
import type { CalendarDayInput, CalendarHolidaysInput } from './work-calendar.types.js';
import { dayKind, weekdaysBetween } from './working-time.helper.js';

/** `?year=YYYY` only, 1900..2100 (the business date range of input-validation.helper.ts). */
export function parseCalendarYear(query: unknown): number {
  const body = inputBody(query, ['year']);
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
  const day = inputDate(date);
  if (dayKind(day, { paidHolidays: new Set(), makeupDays: new Set() }) === 'weekend') {
    const body = inputBody(value, ['expectedVersion', 'makeup']);
    if (typeof body.makeup !== 'boolean') throw new ProductInvalidRequest('Invalid makeup');
    return { expectedVersion: inputVersion(body.expectedVersion), date: day, makeup: body.makeup };
  }
  const body = inputBody(value, ['expectedVersion', 'holiday']);
  return {
    expectedVersion: inputVersion(body.expectedVersion),
    date: day,
    holiday: body.holiday === null ? null : inputText(body.holiday, 200),
  };
}

/**
 * `{expectedVersion, from, to, name}`: from ≤ to, at most 31 calendar days and at least one
 * Monday–Friday in it (a weekend-only range would change nothing: 400, like a weekend holiday).
 */
export function parseCalendarHolidays(value: unknown): CalendarHolidaysInput {
  const body = inputBody(value, ['expectedVersion', 'from', 'to', 'name']);
  const input = {
    expectedVersion: inputVersion(body.expectedVersion),
    from: inputDate(body.from),
    to: inputDate(body.to),
    name: inputText(body.name, 200),
  };
  if (weekdaysBetween(input.from, input.to).length === 0)
    throw new ProductInvalidRequest('Invalid holiday range');
  return input;
}
