import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  hrBody,
  hrDate,
  hrMinutes,
  hrPageQuery,
  hrText,
  hrUuid,
} from '../hr/helpers/hr-input.helper.js';
import { parseIdempotencyKey } from '../work-request/work-request.validator.js';
import type {
  AttendanceAdjustmentInput,
  AttendanceAdjustmentQuery,
  AttendanceQuery,
  PeriodCloseInput,
  PeriodReopenInput,
} from './attendance.types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `YYYY-MM`, years 1900..2100 (the business date range of hr-input.helper.ts). */
export function parseAttendanceMonth(value: unknown): string {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})$/.exec(value) : null;
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (!match || year < 1900 || year > 2100 || month < 1 || month > 12)
    throw new ProductInvalidRequest('Invalid month');
  return match[0];
}

/** `GET …/employees/:id/attendance[?month=YYYY-MM]`: nothing else is accepted. */
export function parseAttendanceQuery(id: unknown, query: unknown): AttendanceQuery {
  if (!isRecord(query) || Object.keys(query).some((key) => key !== 'month'))
    throw new ProductInvalidRequest('Invalid query');
  return {
    employeeId: hrUuid(id),
    month: query.month === undefined ? null : parseAttendanceMonth(query.month),
  };
}

/** `POST …/attendance/periods/:month/close`: the month is the path, the body is empty. */
export function parsePeriodClose(month: unknown, body: unknown): PeriodCloseInput {
  hrBody(body ?? {}, []);
  return { month: parseAttendanceMonth(month) };
}

/** `POST …/attendance/periods/:month/reopen`: exactly `reason` (D07). */
export function parsePeriodReopen(month: unknown, body: unknown): PeriodReopenInput {
  const fields = hrBody(body, ['reason']);
  return { month: parseAttendanceMonth(month), reason: hrText(fields.reason, 1000) };
}

/** One adjustment is at most one day of paid time either way (the table CHECK is the same bound). */
const MAX_ADJUSTMENT_MINUTES = 1440;

/**
 * A source reference: letters (any script, so `QĐ` passes), digits and ` . _ / # : -`, starting
 * with a letter or digit, at most 64 characters. Narrow on purpose: it is an identifier of a
 * document, not free text.
 */
function attendanceReference(value: unknown): string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._/#:-]{0,63}$/u.test(value))
    throw new ProductInvalidRequest('Invalid reference');
  return value;
}

/**
 * `POST …/employees/:id/attendance-adjustments` body, path id and `Idempotency-Key`: exactly
 * `workDate`, `minutes`, `reason` and an optional `reference`. The employee comes from the path
 * only, the actor from the session; nothing else is accepted.
 */
export function parseAttendanceAdjustment(
  value: unknown,
  id: unknown,
  key: unknown,
): AttendanceAdjustmentInput {
  const body = hrBody(value, ['workDate', 'minutes', 'reason'], ['reference']);
  const minutes = hrMinutes(body.minutes, -MAX_ADJUSTMENT_MINUTES, MAX_ADJUSTMENT_MINUTES);
  if (minutes === 0) throw new ProductInvalidRequest('Invalid minutes');
  return {
    employeeId: hrUuid(id),
    idempotencyKey: parseIdempotencyKey(key),
    workDate: hrDate(body.workDate),
    minutes,
    reason: hrText(body.reason, 300),
    reference: body.reference === undefined ? null : attendanceReference(body.reference),
  };
}

/** `GET …/employees/:id/attendance-adjustments?month=YYYY-MM[&limit=&offset=]`. */
export function parseAttendanceAdjustmentQuery(
  id: unknown,
  query: unknown,
): AttendanceAdjustmentQuery {
  const { limit, offset, extra } = hrPageQuery(query, ['month']);
  return { employeeId: hrUuid(id), month: parseAttendanceMonth(extra.month), limit, offset };
}
