import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import {
  hrBody,
  hrBoolean,
  hrDate,
  hrPageQuery,
  hrText,
  hrUuid,
  hrVersion,
} from '../hr/hr-input.helper.js';
import type {
  ApprovalInput,
  CancelInput,
  LeaveSlotInput,
  RequestKind,
  RequestListQuery,
  SubmitRequestInput,
} from './work-request.types.js';

/** D06/§11: one request covers at most 31 working days, one entry per date. */
const MAX_DAYS = 31;

const kinds: readonly RequestKind[] = [
  'late-arrival',
  'early-departure',
  'wfh',
  'annual-leave',
  'unpaid-leave',
];

const isKind = (value: unknown): value is RequestKind =>
  typeof value === 'string' && (kinds as readonly string[]).includes(value);

/** Integer minute of the day; the kind's own window is checked with the calendar (helper). */
function minute(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1440)
    throw new ProductInvalidRequest('Invalid minute');
  return value;
}

/** 1..31 entries, sorted by date, unique; one calendar year (D06) is checked by the helper. */
function days<T>(value: unknown, parse: (item: unknown) => T, dateOf: (item: T) => string): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DAYS)
    throw new ProductInvalidRequest('Invalid days');
  const items = value.map(parse).sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : 1));
  for (let i = 1; i < items.length; i++)
    if (dateOf(items[i]!) === dateOf(items[i - 1]!))
      throw new ProductInvalidRequest('Duplicate day');
  return items;
}

function slot(value: unknown): LeaveSlotInput {
  const body = hrBody(value, ['date', 'startMinute', 'endMinute']);
  return {
    date: hrDate(body.date),
    startMinute: minute(body.startMinute),
    endMinute: minute(body.endMinute),
  };
}

/**
 * POST /api/hr/requests body. Exactly the keys of its `kind` (+ optional `teamId`); employee,
 * owner, state and version are never accepted (B-09). Keys are emitted in a fixed order so the
 * normalized value hashes the same on retry.
 */
export function parseSubmitRequest(value: unknown): SubmitRequestInput {
  const kind = hrBody(
    value,
    ['kind'],
    ['teamId', 'reason', 'date', 'expectedMinute', 'dates', 'segments'],
  ).kind;
  if (!isKind(kind)) throw new ProductInvalidRequest('Invalid kind');
  const own =
    kind === 'wfh'
      ? ['dates']
      : kind === 'late-arrival' || kind === 'early-departure'
        ? ['date', 'expectedMinute']
        : ['segments'];
  const body = hrBody(value, ['kind', 'reason', ...own], ['teamId']);
  const common = {
    teamId: body.teamId === undefined || body.teamId === null ? null : hrUuid(body.teamId),
    reason: hrText(body.reason, 1000),
  };
  if (kind === 'late-arrival' || kind === 'early-departure')
    return {
      kind,
      ...common,
      date: hrDate(body.date),
      expectedMinute: minute(body.expectedMinute),
    };
  if (kind === 'wfh') return { kind, ...common, dates: days(body.dates, hrDate, (d) => d) };
  return { kind, ...common, segments: days(body.segments, slot, (s) => s.date) };
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `Idempotency-Key` header (design §7.4, §11): required lowercase UUID v4. */
export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !uuidV4.test(value))
    throw new ProductInvalidRequest('Invalid idempotency key');
  return value;
}

/** `?limit=&offset=` only (gateway budgets). */
export function parseRequestList(query: unknown): RequestListQuery {
  const { limit, offset } = hrPageQuery(query);
  return { limit, offset };
}

/**
 * POST /api/hr/requests/:id/decision body plus path id and `Idempotency-Key`: exactly
 * `expectedVersion`, `decision`, `reason` and the optional `acknowledgeWfhLimit` (D04); stage,
 * actor or state are never accepted (C-18). A reject needs its reason (D08); an approval note is
 * optional.
 */
export function parseDecision(value: unknown, id: unknown, key: unknown): ApprovalInput {
  const body = hrBody(value, ['expectedVersion', 'decision'], ['reason', 'acknowledgeWfhLimit']);
  const { decision } = body;
  if (decision !== 'approve' && decision !== 'reject')
    throw new ProductInvalidRequest('Invalid decision');
  const reason =
    decision === 'approve' && (body.reason === undefined || body.reason === null)
      ? null
      : hrText(body.reason, 1000);
  return {
    requestId: hrUuid(id),
    idempotencyKey: parseIdempotencyKey(key),
    expectedVersion: hrVersion(body.expectedVersion),
    decision,
    reason,
    acknowledgeWfhLimit:
      body.acknowledgeWfhLimit === undefined ? false : hrBoolean(body.acknowledgeWfhLimit),
  };
}

/**
 * POST /api/hr/requests/:id/cancel body plus path id and `Idempotency-Key`: exactly
 * `expectedVersion` and an optional `reason`; state, stage and actor are never accepted. Whether
 * a reason is required depends on the stored state, so the command checks it on the locked row.
 */
export function parseCancel(value: unknown, id: unknown, key: unknown): CancelInput {
  const body = hrBody(value, ['expectedVersion'], ['reason']);
  return {
    requestId: hrUuid(id),
    idempotencyKey: parseIdempotencyKey(key),
    expectedVersion: hrVersion(body.expectedVersion),
    reason: body.reason === undefined || body.reason === null ? null : hrText(body.reason, 1000),
  };
}
