import { z } from 'zod';
import { type ErrorMessageKey, isErrorMessageKey } from '../i18n/i18n.helper';

/**
 * Non-2xx answer of the API. `code` is the locale key the API chose from the status; a body
 * without a known `error.*` key (proxy page, older API, injected text) falls back to
 * `error.unavailable`. Nothing else of the body is kept or shown.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorMessageKey = 'error.unavailable',
  ) {
    super(`API request failed with status ${status}`);
  }
}

/** Locale key to show for any failure of an API call, including network errors. */
export function apiErrorKey(error: unknown): ErrorMessageKey {
  return error instanceof ApiError ? error.code : 'error.unavailable';
}

/** A 2xx body that does not match the expected contract; never rendered as data. */
export class ResponseShapeError extends Error {
  constructor() {
    super('API response does not match the expected contract');
  }
}

export interface HttpRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface HttpClient {
  request<T>(path: string, schema: z.ZodType<T>, options?: HttpRequestOptions): Promise<T>;

  /** Drops the cached CSRF token, e.g. after logout or session expiry. */
  reset(): void;
}

const csrfSchema = z.object({ csrfToken: z.string().min(1) });
const errorSchema = z.object({ code: z.string().max(64) });

async function apiError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = errorSchema.safeParse(body);
  return parsed.success && isErrorMessageKey(parsed.data.code)
    ? new ApiError(response.status, parsed.data.code)
    : new ApiError(response.status);
}

/**
 * The API's CSRF cookie lives 3600 s (`/api/auth/csrf`); refresh well before that so a mutation
 * is not rejected for a stale token. Mutations are never retried here.
 */
const CSRF_REFRESH_MS = 30 * 60 * 1000;

export function createHttpClient(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  now: () => number = () => Date.now(),
): HttpClient {
  let csrf: { readonly token: string; readonly at: number } | undefined;

  async function send(path: string, options: HttpRequestOptions, token?: string) {
    if (!path.startsWith('/api/')) throw new TypeError('API paths must start with /api/');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) headers['x-csrf-token'] = token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await apiError(response);
    return response;
  }

  async function csrfToken(signal?: AbortSignal): Promise<string> {
    if (csrf && now() - csrf.at < CSRF_REFRESH_MS) return csrf.token;
    const response = await send('/api/auth/csrf', signal ? { signal } : {});
    const parsed = csrfSchema.safeParse(await response.json());
    if (!parsed.success) throw new ResponseShapeError();
    csrf = { token: parsed.data.csrfToken, at: now() };
    return csrf.token;
  }

  return {
    async request(path, schema, options = {}) {
      const mutation = (options.method ?? 'GET') !== 'GET';
      const token = mutation ? await csrfToken(options.signal) : undefined;
      const response = await send(path, options, token);
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw new ResponseShapeError();
      return parsed.data;
    },
    reset() {
      csrf = undefined;
    },
  };
}
