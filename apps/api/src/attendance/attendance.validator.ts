import { ProductInvalidRequest } from '../authorization/product-data.gateway.js';
import { hrBody, hrText, hrUuid } from '../hr/hr-input.helper.js';
import type { AttendanceQuery, PeriodCloseInput, PeriodReopenInput } from './attendance.types.js';

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
