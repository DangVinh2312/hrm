/**
 * Closed set of error keys the API answers with. Each key is also a message key of the web
 * locales (`apps/web/src/i18n/locales/*.json`, checked by root `test/locale-keys.spec.ts`).
 * A key names a response class, never a fact the caller may not learn: absent and hidden
 * records share `error.notFound`, every authentication failure shares
 * `error.authenticationFailed`, CSRF/permission/boundary denials share `error.accessDenied`.
 */
export const API_ERROR_CODES = [
  'error.invalidRequest',
  'error.authenticationFailed',
  'error.accessDenied',
  'error.notFound',
  'error.conflict',
  // Reserved closed-set key for leave on a makeup day. Nothing emits it today: the filter maps by
  // status only (400/401/403/404/409), so T7 must change that mapping and add the emitting route
  // with a behavior test. Return it only after authorizing on the target resource.
  'error.makeupDay',
  'error.unavailable',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Body of every non-2xx JSON response; nothing from the error or the request is copied in. */
export interface ApiErrorBody {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
}

/** The key follows the status only, so no handler or error message can choose what is revealed. */
const codes: Readonly<Partial<Record<number, ApiErrorCode>>> = {
  400: 'error.invalidRequest',
  401: 'error.authenticationFailed',
  403: 'error.accessDenied',
  404: 'error.notFound',
  409: 'error.conflict',
};

export function apiErrorCode(status: number): ApiErrorCode {
  return codes[status] ?? (status < 500 ? 'error.invalidRequest' : 'error.unavailable');
}
