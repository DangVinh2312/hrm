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
  // Business rejections of a work request submit (T5, see `rejectionStatus`).
  'error.dateOutOfRange',
  'error.crossesYear',
  'error.kindNotAllowedInProbation',
  'error.teamNotMember',
  'error.nonWorkingDay',
  'error.makeupDay',
  'error.idempotencyKeyReused',
  'error.overlappingRequest',
  'error.insufficientLeave',
  'error.unavailable',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Body of every non-2xx JSON response; nothing from the error or the request is copied in. */
export interface ApiErrorBody {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
}

/**
 * Generic keys follow the status only, so no handler or error message can choose what is
 * revealed; the only other keys are the closed `ApiRejection` set below.
 */
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

/**
 * Business rules with their own key, and the one status each answers with. A key here may only
 * be thrown after the caller is authorized on the target and must name a rule over facts the
 * caller may already know (their own profile, teams, requests, keys; the public calendar and
 * D06 window), never which other record or person is involved. Thrown by services, never chosen
 * by a controller; the status comes from this table, not from the thrower.
 */
const rejectionStatus = {
  'error.dateOutOfRange': 422,
  'error.crossesYear': 422,
  'error.kindNotAllowedInProbation': 422,
  'error.teamNotMember': 422,
  'error.nonWorkingDay': 422,
  'error.makeupDay': 422,
  'error.idempotencyKeyReused': 422,
  'error.overlappingRequest': 409,
  // T7: only the caller's own accrued leave against their own annual-leave request (D09).
  'error.insufficientLeave': 422,
} as const satisfies Partial<Record<ApiErrorCode, 409 | 422>>;

export type ApiRejectionCode = keyof typeof rejectionStatus;

/** A business rule refused the request; the filter answers `{ statusCode: status, code }`. */
export class ApiRejection extends Error {
  readonly code: ApiRejectionCode;
  readonly status: 409 | 422;

  // No parameter property: root `test/locale-keys.spec.ts` loads this file type-stripped.
  constructor(code: ApiRejectionCode) {
    super(`Rejected: ${code}`);
    // Guards a cast past the type: an unlisted key is a programming fault (503), never sent.
    if (!Object.hasOwn(rejectionStatus, code)) throw new TypeError('Unknown rejection code');
    this.code = code;
    this.status = rejectionStatus[code];
  }
}
