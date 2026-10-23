import type * as oidc from 'openid-client';
import {
  canonicalLoginEmail,
  ProductAuthenticationError,
} from '../services/product-identity.service.js';

export type IdTokenClaims = NonNullable<
  ReturnType<Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>['claims']>
>;

/** 9999-12-31T23:59:59Z: the largest `auth_time` accepted, far inside PostgreSQL's range. */
const MAX_AUTH_TIME = 253402300799;

/**
 * The ID token's `auth_time` (OIDC Core §2, seconds since the epoch) as a value SQL can take:
 * `undefined` when absent, otherwise a non-negative safe integer within MAX_AUTH_TIME. Anything
 * else fails closed. Only the DB clock decides whether it is recent (ADR 0022 §2).
 */
export function authTime(claims: IdTokenClaims): number | undefined {
  const value = claims.auth_time;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_AUTH_TIME)
    throw new ProductAuthenticationError();
  return value;
}

/**
 * The ID token's email, canonical, only when the IdP marks it verified with the boolean `true`
 * (ADR 0020). It is an enrollment/verification claim, never an identity key and never stored.
 */
export function verifiedEmail(claims: IdTokenClaims): string | undefined {
  if (claims.email_verified !== true || typeof claims.email !== 'string') return undefined;
  try {
    return canonicalLoginEmail(claims.email);
  } catch {
    return undefined;
  }
}
