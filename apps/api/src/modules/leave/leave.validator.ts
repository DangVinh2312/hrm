import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import { hrBody, hrDate, hrMinutes, hrPageQuery, hrText, hrUuid } from '../hr/hr-input.helper.js';
import { parseIdempotencyKey } from '../work-request/work-request.validator.js';
import type {
  LeaveAdjustmentInput,
  LeaveBalanceQuery,
  LeaveReconciliationQuery,
} from './leave.types.js';

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

/** The ledger CHECK `ck_leave_ledger_shape` bound for `opening`/`adjustment` entries. */
const MAX_ADJUSTMENT_MINUTES = 175680;

/**
 * `POST …/employees/:id/leave-adjustments` body, path id and `Idempotency-Key`: exactly `minutes`,
 * `effectiveOn` and `reference`. The entry kind is always `adjustment` (opening balances are the
 * D14 import, not an HTTP route); the employee comes from the path only.
 */
export function parseLeaveAdjustment(
  value: unknown,
  id: unknown,
  key: unknown,
): LeaveAdjustmentInput {
  const body = hrBody(value, ['minutes', 'effectiveOn', 'reference']);
  const minutes = hrMinutes(body.minutes, -MAX_ADJUSTMENT_MINUTES, MAX_ADJUSTMENT_MINUTES);
  if (minutes === 0) throw new ProductInvalidRequest('Invalid minutes');
  return {
    employeeId: hrUuid(id),
    idempotencyKey: parseIdempotencyKey(key),
    minutes,
    effectiveOn: hrDate(body.effectiveOn),
    reference: hrText(body.reference, 200),
  };
}
