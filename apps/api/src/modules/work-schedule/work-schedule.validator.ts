import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  inputBody,
  inputDate,
  inputNullableDate,
  inputUuid,
} from '../../infrastructure/helpers/input-validation.helper.js';
import { datesBetween } from '../work-calendar/working-time.helper.js';
import { MAX_SHIFTS, type Frame, type Shift } from './helpers/work-schedule.helper.js';
import type {
  CompanyScheduleInput,
  EmployeeFrameInput,
  EmployeeFrameKey,
  EmployeeScheduleQuery,
  WeekFrames,
} from './work-schedule.types.js';

export const MAX_SCHEDULE_RANGE_DAYS = 92;

const minute = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1440)
    throw new ProductInvalidRequest('Invalid shift');
  return value;
};

const shift = (value: unknown): Shift => {
  if (!Array.isArray(value) || value.length !== 2) throw new ProductInvalidRequest('Invalid shift');
  return [minute(value[0]), minute(value[1])];
};

const frame = (value: unknown): Frame => {
  if (!Array.isArray(value) || value.length > MAX_SHIFTS)
    throw new ProductInvalidRequest('Invalid frame');
  return value.map(shift);
};

/**
 * Shape only: seven lists of at most three `[start, end]` minute pairs. Order, step, overlap and
 * the daily total depend on `hr.workdayMaxMinutes`, so the command checks them.
 */
export function parseWeekFrames(value: unknown): WeekFrames {
  if (!Array.isArray(value) || value.length !== 7) throw new ProductInvalidRequest('Invalid days');
  return value.map(frame);
}

export function parseCompanySchedule(effectiveFrom: unknown, body: unknown): CompanyScheduleInput {
  const value = inputBody(body, ['days']);
  return { effectiveFrom: inputDate(effectiveFrom), days: parseWeekFrames(value.days) };
}

export function parseEmployeeFrame(employeeId: unknown, body: unknown): EmployeeFrameInput {
  const value = inputBody(body, ['validFrom', 'validTo', 'days']);
  const validFrom = inputDate(value.validFrom);
  const validTo = inputNullableDate(value.validTo);
  if (validTo !== null && validTo < validFrom) throw new ProductInvalidRequest('Invalid range');
  return {
    employeeId: inputUuid(employeeId),
    validFrom,
    validTo,
    days: parseWeekFrames(value.days),
  };
}

export function parseEmployeeFrameKey(employeeId: unknown, frameId: unknown): EmployeeFrameKey {
  return { employeeId: inputUuid(employeeId), frameId: inputUuid(frameId) };
}

/** `from..to` inclusive, at most {@link MAX_SCHEDULE_RANGE_DAYS} days. */
export function parseEmployeeScheduleQuery(
  employeeId: unknown,
  query: unknown,
): EmployeeScheduleQuery {
  const value = inputBody(query, ['from', 'to']);
  const from = inputDate(value.from);
  const to = inputDate(value.to);
  if (to < from || datesBetween(from, to, MAX_SCHEDULE_RANGE_DAYS).length === 0)
    throw new ProductInvalidRequest('Invalid range');
  return { employeeId: inputUuid(employeeId), from, to };
}
