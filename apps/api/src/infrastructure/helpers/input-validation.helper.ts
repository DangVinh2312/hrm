import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utc from 'dayjs/plugin/utc.js';
import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';

// Idempotent registration on the shared dayjs (the timestamp codec registers the same plugins).
dayjs.extend(customParseFormat);
dayjs.extend(utc);

/**
 * Runtime validation of request bodies and queries (design §11): input starts as `unknown`,
 * every helper returns a normalized value or throws ProductInvalidRequest (HTTP 400).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Canonical lowercase UUID, the only key form the data tables use. */
export function inputUuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value))
    throw new ProductInvalidRequest('Invalid id');
  return value;
}

/**
 * Business date `YYYY-MM-DD` (ADR 0018): the grammar by pattern (ASCII digits, fixed width), the
 * calendar by strict Day.js UTC parsing (ADR 0022 §3), so 2026-02-30 is refused. No local
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
