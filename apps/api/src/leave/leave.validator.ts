import { ProductInvalidRequest } from '../authorization/product-data.gateway.js';
import { hrDate, hrPageQuery, hrUuid } from '../hr/hr-input.helper.js';
import type { LeaveBalanceQuery, LeaveReconciliationQuery } from './leave.types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `GET …/employees/:id/leave-balance[?date=YYYY-MM-DD]`: nothing else is accepted. */
export function parseLeaveBalanceQuery(id: unknown, query: unknown): LeaveBalanceQuery {
  if (!isRecord(query) || Object.keys(query).some((key) => key !== 'date'))
    throw new ProductInvalidRequest('Invalid query');
  return {
    employeeId: hrUuid(id),
    asOn: query.date === undefined ? null : hrDate(query.date),
  };
}

/** `GET /api/hr/leave/reconciliation[?year=YYYY&limit=&offset=]`, page budgets as everywhere. */
export function parseLeaveReconciliationQuery(query: unknown): LeaveReconciliationQuery {
  const { limit, offset, extra } = hrPageQuery(query, ['year']);
  if (extra.year === undefined) return { year: null, limit, offset };
  if (!/^\d{4}$/.test(extra.year)) throw new ProductInvalidRequest('Invalid year');
  const year = Number(extra.year);
  if (year < 1900 || year > 2100) throw new ProductInvalidRequest('Invalid year');
  return { year, limit, offset };
}
