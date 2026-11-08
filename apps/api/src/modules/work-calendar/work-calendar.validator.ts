import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  inputBody,
  inputDate,
  inputText,
  inputVersion,
} from '../../infrastructure/helpers/input-validation.helper.js';
import type {
  CalendarDayInput,
  CalendarHolidaysInput,
  MakeupHours,
} from './work-calendar.types.js';
import { datesBetween } from './working-time.helper.js';

/** `?year=YYYY` only, 1900..2100 (the business date range of input-validation.helper.ts). */
export function parseCalendarYear(query: unknown): number {
  const body = inputBody(query, ['year']);
  if (typeof body.year !== 'string' || !/^\d{4}$/.test(body.year))
    throw new ProductInvalidRequest('Invalid year');
  const year = Number(body.year);
  if (year < 1900 || year > 2100) throw new ProductInvalidRequest('Invalid year');
  return year;
}

function makeupHours(value: unknown): MakeupHours | null {
  if (value === null) return null;
  const body = inputBody(value, ['asWeekday', 'frameSource']);
  if (
    typeof body.asWeekday !== 'number' ||
    !Number.isInteger(body.asWeekday) ||
    body.asWeekday < 1 ||
    body.asWeekday > 7 ||
    (body.frameSource !== 'company' && body.frameSource !== 'employee')
  )
    throw new ProductInvalidRequest('Invalid makeup');
  return { asWeekday: body.asWeekday, frameSource: body.frameSource };
}

/**
 * `{expectedVersion, holiday}` or `{expectedVersion, makeup}`, never both. Whether the day is off
 * in the company schedule, as a makeup day needs, is the command's check (it reads the schedule).
 */
export function parseCalendarDay(date: unknown, value: unknown): CalendarDayInput {
  const day = inputDate(date);
  if (typeof value === 'object' && value !== null && 'makeup' in value) {
    const body = inputBody(value, ['expectedVersion', 'makeup']);
    return {
      expectedVersion: inputVersion(body.expectedVersion),
      date: day,
      makeup: makeupHours(body.makeup),
    };
  }
  const body = inputBody(value, ['expectedVersion', 'holiday']);
  return {
    expectedVersion: inputVersion(body.expectedVersion),
    date: day,
    holiday: body.holiday === null ? null : inputText(body.holiday, 200),
  };
}

/** `{expectedVersion, from, to, name}`: from ≤ to, at most 31 calendar days. */
export function parseCalendarHolidays(value: unknown): CalendarHolidaysInput {
  const body = inputBody(value, ['expectedVersion', 'from', 'to', 'name']);
  const input = {
    expectedVersion: inputVersion(body.expectedVersion),
    from: inputDate(body.from),
    to: inputDate(body.to),
    name: inputText(body.name, 200),
  };
  if (datesBetween(input.from, input.to).length === 0)
    throw new ProductInvalidRequest('Invalid holiday range');
  return input;
}
