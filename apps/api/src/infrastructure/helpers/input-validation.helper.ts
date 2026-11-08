import { isUtf8 } from 'node:buffer';
import type { NestExpressApplication } from '@nestjs/platform-express';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import { isRoleKeyReference } from '../../authorization/helpers/role-grant.helper.js';
import {
  type BoundaryRef,
  isBoundaryKey,
  isBoundaryVersion,
} from '../../authorization/helpers/boundary-binding.helper.js';

// Idempotent registration on the shared dayjs (the timestamp codec registers the same plugins).
dayjs.extend(customParseFormat);
dayjs.extend(utc);

/**
 * Runtime validation of request bodies and queries (design §11): input starts as `unknown`,
 * every helper returns a normalized value or throws ProductInvalidRequest (HTTP 400).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Middleware after the body parser: a key or string anywhere in the body holding a lone surrogate
 * is refused before any handler, since PostgreSQL would store U+FFFD in its place.
 * Iterative because a 100 kB body can nest deeper than the call stack.
 */
export function wellFormedBody(
  request: { readonly body?: unknown },
  _response: unknown,
  next: () => void,
): void {
  const pending: unknown[] = [request.body];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string' && !value.isWellFormed())
      throw new ProductInvalidRequest('Malformed text');
    if (typeof value === 'object' && value !== null)
      for (const [key, item] of Object.entries(value)) pending.push(key, item);
  }
  next();
}

/**
 * `verify` of the JSON body parser, on the raw bytes: a body the parser would decode as UTF-8 that
 * is not valid UTF-8 is refused, since decoding would put U+FFFD in place of each bad sequence.
 * The charset is compared the way iconv-lite resolves it, so `utf-8-` or `utf-8:1234` count.
 * The parser passes on this same error with status 403 and the raw bytes in `body`; the filter goes
 * by its class, answers 400, and neither logs nor returns `body`.
 */
function utf8Body(_request: unknown, _response: unknown, body: Buffer, encoding: string): void {
  if (encoding.toLowerCase().replace(/:\d{4}$|[^0-9a-z]/g, '') === 'utf8' && !isUtf8(body))
    throw new ProductInvalidRequest('Malformed UTF-8');
}

/** Installs `utf8Body`; `rawBody: true` at NestFactory.create would replace this `verify` with its own. */
export function useJsonBody(app: NestExpressApplication): void {
  app.useBodyParser('json', { verify: utf8Body });
}

/** Exactly the allowed keys; `required` must be present. Unknown keys are refused, never ignored. */
export function inputBody(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new ProductInvalidRequest('Unexpected body shape');
  return value;
}

/** A role key (code or runtime) as named by a request: only its size is known here, the command decides the rest. */
export function inputRoleKey(value: unknown): string {
  if (!isRoleKeyReference(value)) throw new ProductInvalidRequest('Invalid role key');
  return value;
}

/** A boundary version by key and number: only the shape is known here, the command decides the rest. */
export function inputBoundaryRef(key: unknown, version: unknown): BoundaryRef {
  if (!isBoundaryKey(key) || !isBoundaryVersion(version))
    throw new ProductInvalidRequest('Invalid boundary');
  return { key, version };
}

/** A boundary version taken from a URL segment: decimal digits without a leading zero, no other form. */
export function inputBoundaryVersionParam(text: unknown): number {
  return typeof text === 'string' && /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : Number.NaN;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Canonical lowercase UUID, the only key form the data tables use. */
export function inputUuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value))
    throw new ProductInvalidRequest('Invalid id');
  return value;
}

/**
 * Business date `YYYY-MM-DD`: the grammar by pattern (ASCII digits, fixed width), the
 * calendar by strict Day.js UTC parsing, so 2026-02-30 is refused. No local
 * timezone is involved.
 */
export function inputDate(value: unknown): string {
  const match = typeof value === 'string' ? /^(\d{4})-\d{2}-\d{2}$/.exec(value) : null;
  if (!match) throw new ProductInvalidRequest('Invalid date');
  const year = Number(match[1]);
  if (year < 1900 || year > 2100 || !dayjs.utc(match[0], 'YYYY-MM-DD', true).isValid())
    throw new ProductInvalidRequest('Invalid date');
  return match[0];
}

export function inputNullableDate(value: unknown): string | null {
  return value === null ? null : inputDate(value);
}

/** Trimmed text of 1..max code points without control characters (design §11). */
export function inputText(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new ProductInvalidRequest('Invalid text');
  const text = value.trim();
  const points = [...text];
  if (
    !text ||
    points.length > max ||
    points.some((c) => (c.codePointAt(0) ?? 0) < 0x20 || c.codePointAt(0) === 0x7f)
  )
    throw new ProductInvalidRequest('Invalid text');
  return text;
}

/** Employee code: letters, digits, `.`, `_`, `-`; compared byte-exact (COLLATE "C"). */
export function inputCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(value))
    throw new ProductInvalidRequest('Invalid code');
  return value;
}

/** Positive int8 as a decimal string: versions never pass through a JS number. */
export function inputVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,17}$/.test(value))
    throw new ProductInvalidRequest('Invalid version');
  return value;
}

/** Bounded integer minutes (leave rates); refuses fractions, strings and unsafe numbers. */
export function inputMinutes(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ProductInvalidRequest('Invalid minutes');
  return value;
}

export function inputBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProductInvalidRequest('Invalid flag');
  return value;
}

export interface InputPage {
  readonly limit: number;
  readonly offset: number;
}

/**
 * `?limit=&offset=` (and the extra keys allowed) as bounded decimal strings: gateway budgets,
 * default 20, max 100, offset ≤ 10000 (design §11).
 */
export function inputPageQuery(
  query: unknown,
  extra: readonly string[] = [],
): InputPage & { readonly extra: Readonly<Record<string, string>> } {
  if (!isRecord(query)) throw new ProductInvalidRequest('Invalid query');
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') throw new ProductInvalidRequest('Invalid query');
    if (key === 'limit' || key === 'offset') {
      if (!/^\d{1,5}$/.test(value)) throw new ProductInvalidRequest('Invalid page');
    } else if (!extra.includes(key)) throw new ProductInvalidRequest('Invalid query');
    values[key] = value;
  }
  const limit = Number(values.limit ?? '20');
  const offset = Number(values.offset ?? '0');
  if (limit < 1 || limit > 100 || offset > 10_000) throw new ProductInvalidRequest('Invalid page');
  const { limit: _limit, offset: _offset, ...rest } = values;
  void _limit;
  void _offset;
  return { limit, offset, extra: rest };
}

/** `LIKE` pattern matching `text` literally (with `ESCAPE '\'`). */
export function inputLikePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
